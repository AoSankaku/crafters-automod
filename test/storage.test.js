import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStore,
  LeaseLostError,
  QueueCapacityError,
  StorageError,
} from "../src/storage/index.js";

const directories = [];
const stores = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "automod-store-"));
  directories.push(directory);
  let now = 1_000;
  const clock = () => now;
  const open = (overrides = {}) => createStore({
    sqlitePath: join(directory, "state.sqlite"),
    namespace: "test",
    clock,
    ...options,
    ...overrides,
  }).then((store) => {
    stores.push(store);
    return store;
  });
  return { open, setNow: (value) => { now = value; }, getNow: () => now };
}

function envelope(noteId, userId = `user-${noteId}`) {
  return {
    version: 1,
    noteId,
    userId,
    receivedAt: 1_000,
    note: { id: noteId, userId },
  };
}

function caseJob(caseId, userId = `user-${caseId}`) {
  return { caseId, userId, createdAt: 1_000, reason: "test" };
}

describe("durable moderation store (SQLite)", () => {
  test("restores inbox deduplication, completed cases, audit state, and jobs after restart", async () => {
    const { open } = await fixture();
    let store = await open();
    expect(await store.enqueue(envelope("note-1"))).toEqual({ inserted: true });
    const claim = await store.claim({ workerId: "worker-1", leaseMs: 500 });
    expect(claim?.noteId).toBe("note-1");
    await store.record({ type: "case.completed", caseId: "case-1", noteId: "note-1", userId: "user-note-1", actor: "deterministic" }, { lease: claim });
    await store.enqueueJob("review", caseJob("case-1", "user-note-1"));
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    store = await open();
    expect(await store.hasProcessed("note-1")).toBe(true);
    expect(await store.enqueue(envelope("note-1"))).toEqual({ inserted: false });
    const stats = await store.stats();
    expect(stats.completed).toBe(1);
    expect(stats.reviewJobs).toBe(1);
  });

  test("deduplicates simultaneous enqueues across independent connections and bounds active inbox rows", async () => {
    const { open } = await fixture({ maxInboxJobs: 1 });
    const first = await open();
    const second = await open();
    const results = await Promise.all([
      first.enqueue(envelope("same")),
      second.enqueue(envelope("same")),
    ]);
    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    await expect(first.enqueue(envelope("other"))).rejects.toBeInstanceOf(QueueCapacityError);
    expect(await second.enqueue(envelope("same"))).toEqual({ inserted: false });
  });

  test("serializes concurrent claims and never leases two cases for the same user", async () => {
    const { open } = await fixture();
    const first = await open();
    const second = await open();
    await first.enqueue(envelope("n1", "same-user"));
    await first.enqueue(envelope("n2", "same-user"));
    await first.enqueue(envelope("n3", "other-user"));

    const claims = await Promise.all([
      first.claim({ workerId: "worker-a", leaseMs: 500 }),
      second.claim({ workerId: "worker-b", leaseMs: 500 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.userId)).size).toBe(2);
    expect(await first.stats()).toMatchObject({ pending: 1, running: 2 });
  });

  test("reclaims expired leases with a new fencing token and rejects stale workers", async () => {
    const { open, setNow } = await fixture();
    const store = await open();
    await store.enqueue(envelope("n1", "u1"));
    const oldClaim = await store.claim({ workerId: "old", leaseMs: 100 });
    expect(oldClaim.attempts).toBe(1);
    setNow(1_100);
    const freshClaim = await store.claim({ workerId: "new", leaseMs: 100 });
    expect(freshClaim.token).not.toBe(oldClaim.token);
    expect(freshClaim.attempts).toBe(2);
    expect(await store.renew(oldClaim, 100)).toBe(false);
    await expect(store.assertLease(oldClaim)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await store.complete(oldClaim)).toBe(false);
    expect(await store.complete(freshClaim)).toBe(true);
  });

  test("moves repeatedly crashed jobs to dead after the configured attempt limit", async () => {
    const { open, setNow } = await fixture({ maxAttempts: 2 });
    const store = await open();
    await store.enqueue(envelope("n1", "u1"));
    const first = await store.claim({ workerId: "w1", leaseMs: 10 });
    setNow(1_010);
    const second = await store.claim({ workerId: "w2", leaseMs: 10 });
    expect(second.attempts).toBe(2);
    setNow(1_020);
    expect(await store.claim({ workerId: "w3", leaseMs: 10 })).toBeNull();
    expect(await store.stats()).toMatchObject({ pending: 0, running: 0, dead: 1 });
  });

  test("requeues transient failures with a durable delay and makes permanent failures dead", async () => {
    const { open, setNow } = await fixture();
    const store = await open();
    await store.enqueue(envelope("n1", "u1"));
    const claim = await store.claim({ workerId: "w1", leaseMs: 100 });
    expect(await store.fail(claim, { code: "busy", delayMs: 50 })).toBe("pending");
    expect(await store.claim({ workerId: "w2", leaseMs: 100 })).toBeNull();
    setNow(1_050);
    const retry = await store.claim({ workerId: "w2", leaseMs: 100 });
    expect(retry.attempts).toBe(2);
    expect(await store.fail(retry, { code: "rejected", permanent: true })).toBe("dead");
    expect(await store.stats()).toMatchObject({ pending: 0, dead: 1 });
  });

  test("keeps completed note tombstones while releasing inbox capacity", async () => {
    const { open } = await fixture({ maxInboxJobs: 1 });
    const store = await open();
    await store.enqueue(envelope("n1", "u1"));
    const claim = await store.claim({ workerId: "w1", leaseMs: 100 });
    expect(await store.complete(claim)).toBe(true);
    expect(await store.enqueue(envelope("n2", "u2"))).toEqual({ inserted: true });
    expect(await store.enqueue(envelope("n1", "u1"))).toEqual({ inserted: false });
    expect(await store.stats()).toMatchObject({ pending: 1, completed: 1 });
  });

  test("bounds queued jobs independently by kind and deduplicates without consuming capacity", async () => {
    const { open } = await fixture({ maxQueuedJobs: 1 });
    const store = await open();
    expect(await store.enqueueJob("review", caseJob("c1", "u1"))).toMatchObject({ inserted: true });
    expect(await store.enqueueJob("review", caseJob("c1", "u1"))).toMatchObject({ inserted: false });
    await expect(store.enqueueJob("review", caseJob("c2", "u2"))).rejects.toBeInstanceOf(QueueCapacityError);
    expect(await store.enqueueJob("purge", caseJob("c2", "u2"))).toMatchObject({ inserted: true });
    expect(await store.stats()).toMatchObject({ reviewJobs: 1, purgeJobs: 1 });
  });

  test("persists human decisions by case, note, and user scope", async () => {
    const { open } = await fixture();
    let store = await open();
    await store.setHumanDecision({ scope: "case", id: "c1", reason: "moderator retained" });
    await store.setHumanDecision({ scope: "note", id: "n2", reason: "reviewed" });
    await store.setHumanDecision({ scope: "user", id: "u3", reason: "known context" });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    store = await open();
    expect(await store.hasHumanDecision({ caseId: "c1" })).toBe(true);
    expect(await store.hasHumanDecision({ noteId: "n2" })).toBe(true);
    expect(await store.hasHumanDecision({ userId: "u3" })).toBe(true);
    expect(await store.hasHumanDecision({ caseId: "other", noteId: "other", userId: "other" })).toBe(false);
  });

  test("human-decided automation skip is restored as a human decision", async () => {
    const { open } = await fixture();
    const store = await open();
    await store.record({ type: "automation.skipped.human", caseId: "c1", noteId: "n1", userId: "u1", actor: "human", reason: "override" });
    expect(await store.hasHumanDecision({ caseId: "c1", noteId: "n1", userId: "u1" })).toBe(true);
  });

  test("rejects stale lease writes atomically without recording case completion", async () => {
    const { open, setNow } = await fixture();
    const store = await open();
    await store.enqueue(envelope("n1", "u1"));
    const claim = await store.claim({ workerId: "w1", leaseMs: 10 });
    setNow(1_010);
    await expect(store.record({ type: "case.completed", caseId: "c1", noteId: "n1", actor: "deterministic" }, { lease: claim })).rejects.toBeInstanceOf(LeaseLostError);
    expect(await store.hasProcessed("n1")).toBe(false);
    expect(await store.complete(claim)).toBe(false);
  });

  test("bounds and deduplicates review and purge jobs atomically across connections", async () => {
    const { open } = await fixture({ maxQueuedJobs: 2 });
    const first = await open();
    const second = await open();
    const result = await Promise.all([
      first.enqueueJob("review", caseJob("c1", "u1")),
      second.enqueueJob("review", caseJob("c1", "u1")),
    ]);
    expect(result.filter((value) => value.inserted)).toHaveLength(1);
    await Promise.all([
      first.enqueueJob("review", caseJob("c2", "u2")),
      second.enqueueJob("purge", caseJob("c3", "u3")),
    ]);
    await expect(first.enqueueJob("review", caseJob("c4", "u4"))).rejects.toBeInstanceOf(QueueCapacityError);
  });

  test("shares a non-reserving API interval budget and global cooldown", async () => {
    const { open, setNow } = await fixture();
    const first = await open();
    const second = await open();
    expect(await first.tryApiSlot(100)).toBe(0);
    expect(await second.tryApiSlot(100)).toBe(100);
    setNow(1_050);
    expect(await second.tryApiSlot(100)).toBe(50);
    await first.blockApi(500);
    expect(await second.stats()).toMatchObject({ apiBlockedUntil: 1_550 });
    expect(await second.tryApiSlot(100)).toBe(500);
    setNow(1_550);
    expect(await second.tryApiSlot(100)).toBe(0);
  });

  test("fences action journal writes and keeps completed actions idempotent", async () => {
    const { open, setNow } = await fixture();
    const store = await open();
    await store.enqueue(envelope("n1", "u1"));
    const old = await store.claim({ workerId: "old", leaseMs: 10 });
    expect(await store.getAction("c1", "suspend")).toBeNull();
    await store.startAction(old, "suspend");
    expect(await store.getAction("c1", "suspend")).toEqual({ status: "started" });
    setNow(1_010);
    const current = await store.claim({ workerId: "new", leaseMs: 100 });
    await expect(store.completeAction(old, "suspend")).rejects.toBeInstanceOf(LeaseLostError);
    await store.completeAction(current, "suspend");
    expect(await store.getAction("c1", "suspend")).toEqual({ status: "completed" });
    expect(await store.startAction(current, "suspend")).toBe(false);
    await expect(store.resetAction(current, "suspend")).rejects.toThrow();
  });

  test("resetAction only clears a started action after a definitive rejection", async () => {
    const { open } = await fixture();
    const store = await open();
    await store.enqueue(envelope("n1", "u1"));
    const claim = await store.claim({ workerId: "w1", leaseMs: 100 });
    await store.startAction(claim, "restrict");
    await store.resetAction(claim, "restrict");
    expect(await store.getAction("n1", "restrict")).toBeNull();
  });

  test("isolates namespaces and wraps database failures without exposing credentials", async () => {
    const { open } = await fixture();
    const first = await open({ namespace: "one" });
    const second = await open({ namespace: "two" });
    await first.enqueue(envelope("same", "u1"));
    await second.enqueue(envelope("same", "u1"));
    expect((await first.stats()).pending).toBe(1);
    expect((await second.stats()).pending).toBe(1);

    await expect(createStore({ backend: "unknown", sqlitePath: ":memory:", namespace: "test" }))
      .rejects.toBeInstanceOf(StorageError);
    await expect(createStore({ backend: "postgres", databaseUrl: "not-a-database-url", namespace: "test" }))
      .rejects.toBeInstanceOf(StorageError);
  });
});
