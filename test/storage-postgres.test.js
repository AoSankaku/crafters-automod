import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createStore } from "../src/storage/index.js";

const databaseUrl = process.env.AUTOMOD_TEST_DATABASE_URL;
const stores = [];

afterEach(async () => {
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
    });

    test("keeps completed-note and human-override indexes across process-style restart", async () => {
      const namespace = `storage-test-${randomUUID()}`;
      let store = await openStore(namespace);
      await store.enqueue({ version: 1, noteId: "done", userId: "user-done", receivedAt: Date.now() });
      const claim = await store.claim({ workerId: "worker", leaseMs: 10_000 });
      await store.record({ type: "case.completed", caseId: "case-done", noteId: "done", userId: "user-done", actor: "deterministic" }, { lease: claim });
      await store.setHumanDecision({ scope: "user", id: "human-user", reason: "reviewed" });
      await store.close();
      stores.splice(stores.indexOf(store), 1);

      store = await openStore(namespace);
      expect(await store.hasProcessed("done")).toBe(true);
      expect(await store.hasHumanDecision({ userId: "human-user" })).toBe(true);
    });
  });
}
