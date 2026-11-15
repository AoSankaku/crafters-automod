import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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

afterAll(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map(removeDirectory));
});

async function removeDirectory(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

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
  return { open, directory, setNow: (value) => { now = value; }, getNow: () => now };
}

function envelope(noteId, userId = `user-${noteId}`) {
  return {
    version: 1,
    noteId,
    userId,
    receivedAt: 1_000,
  };
}

function caseJob(caseId, userId = `user-${caseId}`) {
  return { caseId, userId, createdAt: 1_000, reason: "test" };
}

describe("durable moderation store (SQLite)", () => {
  test("shares a bounded daily reputation API budget and persists its cooldown separately", async () => {
    const f = await fixture();
    const store = await f.open();
    expect(await store.tryReputationSlot(100, 2)).toBe(0);
    expect(await store.tryReputationSlot(100, 2)).toBe(100);
    f.setNow(1_100);
    expect(await store.tryReputationSlot(100, 2)).toBe(0);
    expect(await store.tryReputationSlot(100, 2)).toBeGreaterThan(0);
    await store.blockReputationApi(300);
    expect(await store.tryReputationSlot(100, 2)).toBeGreaterThanOrEqual(300);
    expect(await store.tryApiSlot(100)).toBe(0);
    expect(await store.reputationStats()).toEqual(expect.objectContaining({
      apiRequests: 2, requestsToday: 2, blockedUntil: 1_400,
    }));
  });

  test("caches only sanitized reputation results by policy and user, with bounded eviction", async () => {
    const f = await fixture({ maxInboxJobs: 10 });
    const store = await f.open();
    const envelope = (id) => ({ version: 1, noteId: id, userId: `user-${id}`, receivedAt: 1_000 });
    const first = await store.enqueue(envelope("one"));
    const second = await store.enqueue(envelope("two"));
    const claimOne = await store.claim({ workerId: "worker", leaseMs: 500 });
    const claimTwo = await store.claim({ workerId: "worker", leaseMs: 500 });
    const policyKey = "a".repeat(64);
    const listed = { status: "listed", score: 90, signals: [{ kind: "email", frequency: 10, confidence: 80, lastSeen: 999 }] };
    expect(await store.getReputation("user-one", policyKey)).toBeNull();
    const saved = await store.saveReputation(claimOne, policyKey, listed, 100, { maxEntries: 1 });
    expect(saved).toEqual({ caseId: "one", result: listed, checkedAt: 1_000, expiresAt: 1_100 });
    expect(await store.getReputation("user-one", policyKey)).toEqual(saved);
    await store.saveReputation(claimTwo, policyKey, { status: "clear", score: 0, signals: [] }, 200, { maxEntries: 1 });
    expect(await store.getReputation("user-one", policyKey)).toBeNull();
    expect(await store.getReputation("user-two", policyKey)).toEqual(expect.objectContaining({ caseId: "two" }));
    expect(await store.reputationStats()).toEqual(expect.objectContaining({ cacheEntries: 1 }));
  });

  test("rejects raw identifiers and stale lease writes in reputation storage", async () => {
    const f = await fixture();
    const store = await f.open();
    await store.enqueue(envelope("one", "user-one"));
    const claim = await store.claim({ workerId: "worker", leaseMs: 500 });
    const key = "b".repeat(64);
    await expect(store.saveReputation(claim, key, {
      status: "listed", score: 1, email: "private@example.invalid", signals: [],
    }, 100)).rejects.toBeInstanceOf(StorageError);
    expect(await store.saveReputation(claim, key, {
      status: "listed", score: 1, signals: [{ kind: "email", frequency: 1, confidence: 50, lastSeen: 999 }],
    }, 100)).toBeTruthy();
    await store.fail(claim, { code: "retry", delayMs: 0 });
    await expect(store.saveReputation(claim, key, { status: "clear", score: 0, signals: [] }, 100))
      .rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.getReputation("user-one", "not-a-hash")).rejects.toBeInstanceOf(StorageError);
  });

  test("restores inbox deduplication, completed cases, audit state, and jobs after restart", async () => {
    const { open } = await fixture();
    let store = await open();
    expect(await store.enqueue(envelope("note-1"))).toEqual({ inserted: true });
    const claim = await store.claim({ workerId: "worker-1", leaseMs: 500 });
    expect(claim?.noteId).toBe("note-1");
    await store.record({ type: "case.completed", caseId: "case-1", noteId: "note-1", userId: "user-note-1", actor: "deterministic" }, { lease: claim });
    await store.complete(claim);
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
    expect(await store.getAction("n1", "suspend")).toBeNull();
    await store.startAction(old, "suspend");
    expect(await store.getAction("n1", "suspend")).toEqual({ status: "started" });
    setNow(1_010);
    const current = await store.claim({ workerId: "new", leaseMs: 100 });
    await expect(store.completeAction(old, "suspend")).rejects.toBeInstanceOf(LeaseLostError);
    await store.completeAction(current, "suspend");
    expect(await store.getAction("n1", "suspend")).toEqual({ status: "completed" });
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

  test("exports and restores durable state, rebasing leases and retaining attempts and started journals", async () => {
    const { open, directory } = await fixture();
    const source = await open();
    const pending = envelope("pending", "u-pending");
    const running = envelope("running", "u-running");
    await source.enqueue(pending);
    await source.enqueue(running);
    const runningClaim = await source.claim({ workerId: "source-worker", leaseMs: 50_000 });
    expect(runningClaim.noteId).toBe("pending");
    await source.startAction(runningClaim, "suspend");
    const completed = await source.enqueue(envelope("completed", "u-completed"));
    expect(completed.inserted).toBe(true);
    const completedClaim = await source.claim({ workerId: "source-worker", leaseMs: 50_000 });
    await source.record({ type: "case.completed", caseId: "completed", noteId: "completed", userId: "u-completed", actor: "deterministic" }, { lease: completedClaim });
    await source.complete(completedClaim);
    await source.enqueueJob("review", caseJob("review-1", "u-review"));
    await source.enqueueJob("purge", caseJob("purge-1", "u-purge"));
    await source.setHumanDecision({ scope: "user", id: "human-1", reason: "moderator decision" });
    await source.markImport("legacy-file-fingerprint");
    await source.tryApiSlot(100);
    await source.blockApi(1_000);

    const exported = [];
    for await (const record of source.exportState()) exported.push(record);
    expect(exported[0]).toMatchObject({ kind: "meta", namespace: "test", schemaVersion: 1 });
    const footer = exported.at(-1);
    expect(footer).toMatchObject({ kind: "footer", namespace: "test", schemaVersion: 1 });
    expect(typeof footer.recordCount).toBe("number");
    expect(typeof footer.digest).toBe("string");

    const target = await open({ sqlitePath: ":memory:" });
    for (const record of exported) await target.importState(record);
    for (const record of exported) expect(await target.importState(record)).toMatchObject({ imported: false });

    const stats = await target.stats();
    expect(stats).toMatchObject({ pending: 2, running: 0, dead: 0, completed: 1, reviewJobs: 1, purgeJobs: 1 });
    expect(stats.apiRequests).toBe(1);
    expect(stats.apiBlockedUntil).toBeGreaterThan(1_000);
    expect(await target.hasProcessed("completed")).toBe(true);
    expect(await target.hasHumanDecision({ userId: "human-1" })).toBe(true);
    expect(await target.hasImport("legacy-file-fingerprint")).toBe(true);
    expect(await target.getAction("pending", "suspend")).toEqual({ status: "started" });

    const restoredClaim = await target.claim({ workerId: "target-worker", leaseMs: 100 });
    expect(restoredClaim.noteId).toBe("pending");
    expect(restoredClaim.attempts).toBe(2);
    const restoredRunning = await target.claim({ workerId: "target-worker", leaseMs: 100 });
    expect(restoredRunning.noteId).toBe("running");
    expect(await target.complete(runningClaim)).toBe(false);
  });

  test("resumes a partial state import, rejects changed records, and gates until a verified footer", async () => {
    const { open, setNow } = await fixture();
    const source = await open();
    await source.enqueue(envelope("a-pending", "u-pending"));
    await source.enqueue(envelope("z-done", "u-done"));
    const pending = await source.claim({ workerId: "source", leaseMs: 500 });
    await source.startAction(pending, "uncertain-action");
    const done = await source.claim({ workerId: "source", leaseMs: 500 });
    await source.startAction(done, "confirmed-action");
    await source.completeAction(done, "confirmed-action");
    await source.setHumanDecision({ scope: "note", id: "z-done", reason: "reviewed by moderator" });
    await source.record({ type: "case.completed", caseId: "z-done", noteId: "z-done", userId: "u-done", actor: "human" }, { lease: done });
    await source.complete(done);
    await source.markImport("legacy-file-fingerprint");
    await source.importLegacyRecord("audit", {
      type: "legacy.reviewed", caseId: "legacy-case", noteId: "legacy-note", actor: "human",
    }, "legacy-audit-key");
    await source.enqueueJob("review", caseJob("review-case", "review-user"));
    await source.tryApiSlot(100);
    await source.blockApi(2_000);

    const records = [];
    for await (const record of source.exportState()) records.push(record);
    expect(records.at(-1).recordCount).toBe(records.length - 2);
    setNow(2_000);
    const laterExport = [];
    for await (const record of source.exportState()) laterExport.push(record);
    expect(laterExport).toEqual(records);

    const migrationDirectory = await mkdtemp(join(tmpdir(), "automod-import-"));
    directories.push(migrationDirectory);
    const targetPath = join(migrationDirectory, "target.sqlite");
    let target = await open({ sqlitePath: targetPath, namespace: "test" });
    expect(await target.importState(records[0])).toEqual({ imported: true });
    expect(await target.importState(records[1])).toEqual({ imported: true });
    await expect(target.stats()).rejects.toBeInstanceOf(StorageError);
    await target.close();
    stores.splice(stores.indexOf(target), 1);

    target = await open({ sqlitePath: targetPath, namespace: "test" });
    const changedRecord = { ...records[1], userId: "different-user" };
    await expect(target.importState(changedRecord)).rejects.toBeInstanceOf(StorageError);
    const invalidFooter = { ...records.at(-1), digest: "0".repeat(64) };
    for (const record of records.slice(1, -1)) await target.importState(record);
    await expect(target.importState(invalidFooter)).rejects.toBeInstanceOf(StorageError);
    await expect(target.stats()).rejects.toBeInstanceOf(StorageError);
    expect(await target.importState(records.at(-1))).toEqual({ imported: true });
    expect(await target.importState(records.at(-1))).toEqual({ imported: false });

    expect(await target.stats()).toMatchObject({ pending: 1, running: 0, completed: 1, reviewJobs: 1, apiRequests: 1 });
    expect(await target.hasProcessed("z-done")).toBe(true);
    expect(await target.hasHumanDecision({ noteId: "z-done" })).toBe(true);
    expect(await target.hasImport("legacy-file-fingerprint")).toBe(true);
    expect(await target.importLegacyRecord("audit", {
      type: "legacy.reviewed", caseId: "legacy-case", noteId: "legacy-note", actor: "human",
    }, "legacy-audit-key")).toEqual({ imported: false });
    expect(await target.getAction("a-pending", "uncertain-action")).toEqual({ status: "started" });
    expect(await target.getAction("z-done", "confirmed-action")).toEqual({ status: "completed" });
    expect((await target.stats()).apiBlockedUntil).toBeGreaterThan(1_000);

    const restored = await target.claim({ workerId: "target", leaseMs: 500 });
    expect(restored.noteId).toBe("a-pending");
    expect(restored.attempts).toBe(2);
  });

  test("requireExisting reopens a real namespace and rejects missing sources without creating files", async () => {
    const { open, directory } = await fixture();
    const existing = await open({ namespace: "existing" });
    await existing.enqueue(envelope("seeded-source-note"));
    await existing.close();
    stores.splice(stores.indexOf(existing), 1);
    await expect(open({ namespace: "missing", requireExisting: true })).rejects.toBeInstanceOf(StorageError);

    const reopened = await open({ namespace: "existing", requireExisting: true });
    expect(await reopened.stats()).toMatchObject({ pending: 1 });

    const nonexistentPath = join(directory, "must-not-be-created.sqlite");
    await expect(createStore({ sqlitePath: nonexistentPath, namespace: "missing", requireExisting: true }))
      .rejects.toBeInstanceOf(StorageError);
    expect(existsSync(nonexistentPath)).toBe(false);
  });

  test("rejects migration namespace/schema mismatches and non-empty destinations", async () => {
    const { open } = await fixture();
    const empty = await open({ sqlitePath: ":memory:" });
    await expect(empty.importState({ kind: "meta", schemaVersion: 2, namespace: "test", sourceId: "src" }))
      .rejects.toBeInstanceOf(StorageError);
    await expect(empty.importState({ kind: "meta", schemaVersion: 1, namespace: "elsewhere", sourceId: "src" }))
      .rejects.toBeInstanceOf(StorageError);

    await empty.enqueue(envelope("already-present", "u1"));
    await expect(empty.importState({ kind: "meta", schemaVersion: 1, namespace: "test", sourceId: "src" }))
      .rejects.toBeInstanceOf(StorageError);
    expect(await empty.stats()).toMatchObject({ pending: 1 });
  });

  test("imports legacy audits and jobs exactly once using a caller-stable key", async () => {
    const { open } = await fixture();
    const store = await open();
    const audit = { type: "case.completed", caseId: "legacy-case", noteId: "legacy-note", userId: "legacy-user", actor: "human", reason: "reviewed" };
    expect(await store.importLegacyRecord("audit", audit, "audit-sha256-1")).toEqual({ imported: true });
    expect(await store.importLegacyRecord("audit", audit, "audit-sha256-1")).toEqual({ imported: false });
    expect(await store.hasProcessed("legacy-note")).toBe(true);
    expect(await store.hasHumanDecision({ caseId: "legacy-case" })).toBe(true);

    expect(await store.importLegacyRecord("review", caseJob("legacy-review", "legacy-user"), "review-sha256-1"))
      .toEqual({ imported: true });
    expect(await store.importLegacyRecord("review", caseJob("legacy-review", "legacy-user"), "review-sha256-1"))
      .toEqual({ imported: false });
    expect(await store.stats()).toMatchObject({ reviewJobs: 1 });
    expect(await store.hasImport("fingerprint-1")).toBe(false);
    await store.markImport("fingerprint-1");
    expect(await store.hasImport("fingerprint-1")).toBe(true);
    await expect(store.importLegacyRecord("unknown", {}, "key")).rejects.toBeInstanceOf(StorageError);
  });

  test("restores every human decision scope from imported human.decision audit events", async () => {
    const { open } = await fixture();
    const store = await open();
    for (const scope of ["case", "note", "user"]) {
      expect(await store.importLegacyRecord("audit", {
        type: "human.decision", scope, id: `human-${scope}`, actor: "human", reason: "moderator decision",
      }, `human-${scope}`)).toEqual({ imported: true });
      expect(await store.hasHumanDecision({
        caseId: scope === "case" ? `human-${scope}` : undefined,
        noteId: scope === "note" ? `human-${scope}` : undefined,
        userId: scope === "user" ? `human-${scope}` : undefined,
      })).toBe(true);
    }
    await expect(store.importLegacyRecord("audit", {
      type: "human.decision", scope: "case", id: "invalid", actor: "deterministic", reason: "not human",
    }, "invalid-human-decision")).rejects.toBeInstanceOf(StorageError);
  });
});
