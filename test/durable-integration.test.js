import { describe, expect, mock, test } from "#test";
import { createCaseHandler } from "../src/application.js";
import { loadConfig } from "../src/config.js";
import { createInboxEnvelope } from "../src/inbox-envelope.js";
import { DurableWorker } from "../src/durable-worker.js";
import { MisskeyApiClient } from "../src/misskey.js";
import { DurableApiLimiter } from "../src/rate-limiter.js";
import { SharedHumanAuthority } from "../src/shared-authority.js";
import { createStore } from "../src/storage/index.js";

const sourceSha256 = "a".repeat(64);
const logger = { info() {}, warn() {}, error() {} };
async function harness(tier = "T2") {
  const store = await createStore({ sqlitePath: ":memory:", namespace: "integration" });
  const rules = [{ id: "rule", enabled: true, tier, field: "text", matchers: [{ type: "contains", value: "spam" }], excludedUsers: [], reason: "Policy" }];
  const config = loadConfig({ MISSKEY_URL: "https://misskey.example", MISSKEY_TOKEN: "secret", AUTOMOD_MODE: "enforce", T2_ROLE_ID: "restricted", MIN_ACTION_INTERVAL_MS: "1" });
  const user = { id: "user", host: null, moderationNote: "", roles: [], roleAssigns: [], isModerator: false, isAdministrator: false, isSuspended: false };
  const calls = [];
  const fetchImpl = mock(async (url, request) => {
    request.signal.throwIfAborted();
    const endpoint = new URL(url).pathname.replace("/api/", "");
    calls.push(endpoint);
    if (endpoint === "admin/show-user") return Response.json(user);
    if (endpoint === "admin/roles/assign") user.roleAssigns.push({ roleId: "restricted" });
    if (endpoint === "admin/suspend-user") user.isSuspended = true;
    if (endpoint === "admin/update-user-note") user.moderationNote = JSON.parse(request.body).text;
    return new Response(null, { status: 204 });
  });
  const client = new MisskeyApiClient({ baseUrl: config.baseUrl, token: config.token, fetchImpl,
    rateLimiter: new DurableApiLimiter({ store, intervalMs: 1 }) });
  const authority = new SharedHumanAuthority({ store, logger });
  const handle = createCaseHandler({ store, config, rules, sourceSha256, client, authority, logger, selfUserId: "automod" });
  const worker = () => new DurableWorker({ store, handle, logger, retryBaseMs: 1 });
  const envelope = (id = "note") => createInboxEnvelope({ id, userId: "user", user: { id: "user", host: null }, text: "spam private content" }, rules,
    { sourceSha256, mode: config.mode, selfUserId: "automod" });
  return { store, config, rules, calls, fetchImpl, client, authority, worker, envelope, handle };
}

describe("durable moderation integration", () => {
  test("deduplicates repeated deliveries and preserves the action across worker recreation", async () => {
    const h = await harness();
    try {
      expect(await h.store.enqueue(h.envelope())).toEqual({ inserted: true });
      expect(await h.store.enqueue(h.envelope())).toEqual({ inserted: false });
      await h.worker().processOne();
      expect(await h.store.getAction("note", "assign-role:restricted")).toEqual(expect.objectContaining({ status: "completed" }));
      expect(await h.store.enqueue(h.envelope())).toEqual({ inserted: false });
      await h.worker().processOne();
      expect(h.calls.filter((endpoint) => endpoint === "admin/roles/assign")).toHaveLength(1);
      expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, reviewJobs: 1, pending: 0 }));
      for await (const record of h.store.exportState()) expect(JSON.stringify(record)).not.toMatch(/private content|secret/);
    } finally { await h.store.close(); }
  });

  test("shared human decisions prevent changes and delayed review admission", async () => {
    const h = await harness();
    try {
      await h.store.enqueue(h.envelope());
      await h.store.setHumanDecision({ scope: "user", id: "user", reason: "Moderator resolved" });
      await h.worker().processOne();
      expect(h.calls).toHaveLength(0);
      expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, reviewJobs: 0 }));
    } finally { await h.store.close(); }
  });

  test("an uncertain suspension journal becomes human review without repeating the mutation or purge", async () => {
    const h = await harness("T1");
    try {
      await h.store.enqueue(h.envelope());
      const claim = await h.store.claim({ workerId: "previous", leaseMs: 1000 });
      await h.store.startAction(claim, "suspend");
      await h.store.fail(claim, { code: "TRANSPORT_UNCERTAIN", delayMs: 0 });
      await h.worker().processOne();
      expect(h.calls).toEqual(["admin/show-user", "admin/show-user", "admin/update-user-note"]);
      expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, purgeJobs: 0 }));
      const events = [];
      for await (const record of h.store.exportState()) if (record.kind === "audit") events.push(record.event);
      expect(events).toContainEqual(expect.objectContaining({ type: "automation.skipped.uncertain", outcome: "human_review_required" }));
    } finally { await h.store.close(); }
  });

  test("malformed or incompatible queued policy is dead-lettered without calling Misskey", async () => {
    const h = await harness();
    try {
      await h.store.enqueue({ ...h.envelope(), sourceSha256: "b".repeat(64) });
      await h.worker().processOne();
      expect(h.calls).toHaveLength(0);
      expect(await h.store.stats()).toEqual(expect.objectContaining({ dead: 1, completed: 0 }));
    } finally { await h.store.close(); }
  });

  test("stale claims cannot append audit, enqueue work, or mutate Misskey through the handler", async () => {
    const h = await harness();
    try {
      await h.store.enqueue(h.envelope());
      const claim = await h.store.claim({ workerId: "old", leaseMs: 1000 });
      await h.store.fail(claim, { code: "LOST", delayMs: 0 });
      const assertActive = () => h.store.assertLease(claim);
      await expect(h.handle(claim.payload, { claim, assertActive, signal: new AbortController().signal })).rejects.toThrow(/lease/);
      expect(h.calls).toHaveLength(0);
    } finally { await h.store.close(); }
  });
});
