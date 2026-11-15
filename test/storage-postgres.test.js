import { afterAll, describe, expect, test } from "#test";
import { randomUUID } from "node:crypto";
import { createStore, StorageError } from "../src/storage/index.js";

const databaseUrl = process.env.AUTOMOD_TEST_DATABASE_URL;
const stores = [];

afterAll(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

if (!databaseUrl) {
  test.skip("PostgreSQL durable storage integration (set AUTOMOD_TEST_DATABASE_URL)", () => {});
} else {
  describe("durable moderation store (PostgreSQL)", () => {
    async function openStore(namespace) {
      const store = await createStore({
        backend: "postgres",
        databaseUrl,
        namespace,
        maxInboxJobs: 100,
        maxQueuedJobs: 100,
      });
      stores.push(store);
      return store;
    }

    test("shares the SFS cache and an isolated atomic provider quota across connections", async () => {
      const namespace = `sfs-test-${randomUUID()}`;
      const first = await openStore(namespace);
      const second = await openStore(namespace);
      await first.enqueue({ noteId: "sfs-note", userId: "sfs-user" });
      const claim = await first.claim({ workerId: "sfs-worker", leaseMs: 10000 });
      const key = "a".repeat(64);
      const result = { status: "listed", score: 40, signals: [{ kind: "email", frequency: 10, confidence: 90, lastSeen: Math.floor(Date.now() / 1000) }] };
      await first.saveReputation(claim, key, result, 60000);
      expect(await second.getReputation("sfs-user", key)).toEqual(expect.objectContaining({ caseId: "sfs-note", result }));
      const slots = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).tryReputationSlot(60000, 1)));
      expect(slots.filter((wait) => wait === 0)).toHaveLength(1);
      expect(await first.tryApiSlot(1)).toBe(0);
      await second.blockReputationApi(10000);
      expect(await first.tryReputationSlot(1, 1)).toBeGreaterThan(0);
      expect(await first.reputationStats()).toEqual(expect.objectContaining({ apiRequests: 1, requestsToday: 1, cacheEntries: 1 }));
      await first.fail(claim, { code: "RETRY", delayMs: 0 });
      await expect(first.saveReputation(claim, key, result, 60000)).rejects.toThrow(/lease/);
    });

    test("serializes first initialization across namespaces sharing the schema", async () => {
      const [first, second] = await Promise.all([
        openStore(`schema-init-a-${randomUUID()}`),
        openStore(`schema-init-b-${randomUUID()}`),
      ]);
      const note = { version: 1, noteId: "isolated", userId: "same", receivedAt: Date.now() };
      expect(await Promise.all([first.enqueue(note), second.enqueue(note)])).toEqual([
        { inserted: true }, { inserted: true },
      ]);
      expect(await first.stats()).toMatchObject({ pending: 1 });
      expect(await second.stats()).toMatchObject({ pending: 1 });
    });

    test("shares dedupe, per-user leases, and API budget across independent connections", async () => {
      const namespace = `storage-test-${randomUUID()}`;
      const first = await openStore(namespace);
      const second = await openStore(namespace);
      const envelope = (noteId, userId) => ({ version: 1, noteId, userId, receivedAt: Date.now() });

      const inserted = await Promise.all([
        first.enqueue(envelope("same", "same-user")),
        second.enqueue(envelope("same", "same-user")),
      ]);
      expect(inserted.filter((item) => item.inserted)).toHaveLength(1);
      await first.enqueue(envelope("other-case", "same-user"));

      const claim = await first.claim({ workerId: "worker-a", leaseMs: 10_000 });
      expect(claim).not.toBeNull();
      expect(claim.leaseExpiresAt).toBeGreaterThan(Date.now());
      expect(await second.claim({ workerId: "worker-b", leaseMs: 10_000 })).toBeNull();

      expect(await first.tryApiSlot(1_000)).toBe(0);
      expect(await second.tryApiSlot(1_000)).toBeGreaterThan(0);
      await second.blockApi(5_000);
      expect((await first.stats()).apiBlockedUntil).toBeGreaterThan(Date.now());
      expect(await first.tryApiSlot(1_000)).toBeGreaterThan(0);

      const burst = Array.from({ length: 12 }, (_, index) => ({
        noteId: `burst-${index}`,
        userId: `burst-user-${index}`,
      }));
      await Promise.all(burst.map((item, index) =>
        (index % 2 === 0 ? first : second).enqueue(envelope(item.noteId, item.userId))));
      const claims = await Promise.all(burst.map((_, index) =>
        (index % 2 === 0 ? first : second).claim({ workerId: `burst-worker-${index}`, leaseMs: 10_000 })));
      expect(claims.every(Boolean)).toBe(true);
      expect(new Set(claims.map((claim) => claim.noteId)).size).toBe(burst.length);
      expect(new Set(claims.map((claim) => claim.userId)).size).toBe(burst.length);
    });

    test("keeps completed-note and human-override indexes across process-style restart", async () => {
      const namespace = `storage-test-${randomUUID()}`;
      let store = await openStore(namespace);
      await store.enqueue({ version: 1, noteId: "done", userId: "user-done", receivedAt: Date.now() });
      const claim = await store.claim({ workerId: "worker", leaseMs: 10_000 });
      await store.record({ type: "case.completed", caseId: "case-done", noteId: "done", userId: "user-done", actor: "deterministic" }, { lease: claim });
      await store.complete(claim);
      await store.setHumanDecision({ scope: "user", id: "human-user", reason: "reviewed" });
      await store.close();
      stores.splice(stores.indexOf(store), 1);

      store = await openStore(namespace);
      expect(await store.hasProcessed("done")).toBe(true);
      expect(await store.hasHumanDecision({ userId: "human-user" })).toBe(true);
    });

    test("resumes a gated SQLite state migration into PostgreSQL and verifies its footer", async () => {
      const namespace = `storage-migrate-${randomUUID()}`;
      const source = await createStore({ sqlitePath: ":memory:", namespace, clock: Date.now });
      try {
        const envelope = (noteId, userId) => ({ version: 1, noteId, userId, receivedAt: Date.now() });
        await source.enqueue(envelope("a-pending", "u-pending"));
        await source.enqueue(envelope("z-done", "u-done"));
        const pending = await source.claim({ workerId: "source", leaseMs: 10_000 });
        await source.startAction(pending, "uncertain-action");
        const done = await source.claim({ workerId: "source", leaseMs: 10_000 });
        await source.startAction(done, "confirmed-action");
        await source.completeAction(done, "confirmed-action");
        await source.setHumanDecision({ scope: "note", id: "z-done", reason: "moderator reviewed" });
        await source.saveReputation(done, "d".repeat(64), {
          status: "listed", score: 80,
          signals: [{ kind: "email", frequency: 9, confidence: 80, lastSeen: Math.floor(Date.now() / 1000) }],
        }, 60_000);
        await source.record({ type: "case.completed", caseId: "z-done", noteId: "z-done", userId: "u-done", actor: "human" }, { lease: done });
        await source.complete(done);
        await source.markImport("legacy-file-fingerprint");
        await source.importLegacyRecord("audit", {
          type: "legacy.reviewed", caseId: "legacy-case", noteId: "legacy-note", actor: "human",
        }, "legacy-audit-key");
        await source.enqueueJob("review", { caseId: "review-case", userId: "review-user", reason: "queued" });
        await source.tryApiSlot(100);
        await source.blockApi(5_000);
        await source.tryReputationSlot(100, 50);
        await source.blockReputationApi(7_000);

        const records = [];
        for await (const record of source.exportState()) records.push(record);
        expect(records.at(-1).recordCount).toBe(records.length - 2);
        expect(typeof records.at(-1).digest).toBe("string");

        let target = await openStore(namespace);
        expect(await target.importState(records[0])).toEqual({ imported: true });
        expect(await target.importState(records[1])).toEqual({ imported: true });
        await expect(target.stats()).rejects.toBeInstanceOf(StorageError);
        await target.close();
        stores.splice(stores.indexOf(target), 1);

        target = await openStore(namespace);
        const altered = { ...records[1], userId: "changed" };
        await expect(target.importState(altered)).rejects.toBeInstanceOf(StorageError);
        for (const record of records.slice(1, -1)) await target.importState(record);
        await expect(target.importState({ ...records.at(-1), digest: "0".repeat(64) }))
          .rejects.toBeInstanceOf(StorageError);
        await expect(target.stats()).rejects.toBeInstanceOf(StorageError);
        expect(await target.importState(records.at(-1))).toEqual({ imported: true });

        expect(await target.stats()).toMatchObject({ pending: 1, running: 0, completed: 1, reviewJobs: 1, apiRequests: 1 });
        expect(await target.hasProcessed("z-done")).toBe(true);
        expect(await target.hasHumanDecision({ noteId: "z-done" })).toBe(true);
        expect(await target.hasImport("legacy-file-fingerprint")).toBe(true);
        expect(await target.importLegacyRecord("audit", {
          type: "legacy.reviewed", caseId: "legacy-case", noteId: "legacy-note", actor: "human",
        }, "legacy-audit-key")).toEqual({ imported: false });
        expect(await target.getAction("a-pending", "uncertain-action")).toEqual({ status: "started" });
        expect(await target.getAction("z-done", "confirmed-action")).toEqual({ status: "completed" });
        expect(await target.getReputation("u-done", "d".repeat(64))).toEqual(expect.objectContaining({
          caseId: "z-done", result: expect.objectContaining({ status: "listed", score: 80 }),
        }));
        expect(await target.reputationStats()).toEqual(expect.objectContaining({
          cacheEntries: 1, apiRequests: 1, requestsToday: 1,
        }));
        expect((await target.stats()).apiBlockedUntil).toBeGreaterThan(Date.now());
        const restored = await target.claim({ workerId: "target", leaseMs: 10_000 });
        expect(restored.noteId).toBe("a-pending");
        expect(restored.attempts).toBe(2);
      } finally {
        await source.close();
      }
    });

    test("rejects a missing namespace when opening an existing migration source", async () => {
      await expect(createStore({
        backend: "postgres",
        databaseUrl,
        namespace: `missing-source-${randomUUID()}`,
        requireExisting: true,
      })).rejects.toBeInstanceOf(StorageError);
    });
  });
}
