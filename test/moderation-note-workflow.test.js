import { describe, expect, test } from "bun:test";
import { createCaseHandler } from "../src/application.js";
import { loadConfig } from "../src/config.js";
import { createInboxEnvelope } from "../src/inbox-envelope.js";
import { DurableWorker } from "../src/durable-worker.js";
import { MisskeyApiClient } from "../src/misskey.js";
import { DurableApiLimiter } from "../src/rate-limiter.js";
import { SharedHumanAuthority } from "../src/shared-authority.js";
import { createStore } from "../src/storage/index.js";

const logger = { warn() {}, info() {}, error() {} };
const sourceSha256 = "a".repeat(64);
async function fixture(tier, env = {}) {
  const store = await createStore({ sqlitePath: ":memory:", namespace: "moderation-note" });
  const config = loadConfig({ MISSKEY_URL: "https://misskey.example", MISSKEY_TOKEN: "private-token",
    AUTOMOD_MODE: "enforce", T2_ROLE_ID: "restricted", MIN_ACTION_INTERVAL_MS: "1", ...env });
  const rules = [{ id: "policy-rule", enabled: true, tier, field: "text", matchers: [{ type: "contains", value: "spam" }],
    excludedUsers: [], reason: "Policy reason" }];
  const user = { moderationNote: "Human memo: keep this.\n", isModerator: false, isAdministrator: false,
    isSuspended: false, roles: [], roleAssigns: [] };
  const calls = [];
  let rejectLog = false;
  const client = new MisskeyApiClient({ baseUrl: config.baseUrl, token: config.token,
    rateLimiter: new DurableApiLimiter({ store, intervalMs: 1 }), fetchImpl: async (url, request) => {
      const endpoint = new URL(url).pathname.slice(5);
      const body = JSON.parse(request.body);
      calls.push(endpoint);
      if (endpoint === "admin/show-user") return Response.json(user);
      if (endpoint === "admin/suspend-user") user.isSuspended = true;
      if (endpoint === "admin/roles/assign") user.roleAssigns.push({ roleId: body.roleId });
      if (endpoint === "admin/update-user-note") {
        if (rejectLog) { rejectLog = false; return Response.json({ error: { code: "RATE_LIMIT_EXCEEDED" } }, { status: 429, headers: { "Retry-After": "0" } }); }
        user.moderationNote = body.text;
      }
      return new Response(null, { status: 204 });
    } });
  const authority = new SharedHumanAuthority({ store, logger });
  const handle = createCaseHandler({ store, config, rules, sourceSha256, client, authority, logger, selfUserId: "automod" });
  const worker = () => new DurableWorker({ store, handle, logger, retryBaseMs: 1 });
  const payload = createInboxEnvelope({ id: "note", userId: "user", user: { id: "user", host: null }, text: "spam private content" },
    rules, { sourceSha256, mode: config.mode, selfUserId: "automod" });
  await store.enqueue(payload);
  return { store, user, calls, worker, rejectNextLog: () => { rejectLog = true; } };
}

describe("default Misskey moderation-note workflow", () => {
  for (const tier of ["T1", "T2", "T3"]) test(`${tier} writes a readable result while preserving human text`, async () => {
    const h = await fixture(tier);
    try {
      await h.worker().processOne();
      expect(h.user.moderationNote).toStartWith("Human memo: keep this.\n");
      expect(h.user.moderationNote).toContain(tier);
      expect(h.user.moderationNote).toContain("policy-rule");
      expect(h.user.moderationNote).toContain("Policy reason");
      expect(h.user.moderationNote).not.toMatch(/private content|private-token/);
      expect(h.calls.filter((call) => call === "admin/update-user-note")).toHaveLength(1);
      expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, pending: 0 }));
      if (tier === "T1") {
        expect(h.calls.indexOf("admin/suspend-user")).toBeLessThan(h.calls.indexOf("admin/update-user-note"));
        expect(h.user.moderationNote).toContain("削除");
      }
      if (tier === "T3") {
        expect(h.calls).not.toContain("admin/suspend-user");
        expect(h.calls).not.toContain("admin/roles/assign");
        expect(h.user.moderationNote).toContain("制限なし");
      }
      for await (const record of h.store.exportState()) expect(JSON.stringify(record)).not.toMatch(/Human memo|private content|private-token/);
    } finally { await h.store.close(); }
  });

  for (const env of [{ AUTOMOD_MODE: "dry-run" }, { MODERATION_NOTE_ENABLED: "false" }]) {
    test(`does not write moderation notes with ${JSON.stringify(env)}`, async () => {
      const h = await fixture("T3", env);
      try {
        await h.worker().processOne();
        expect(h.calls).toHaveLength(0);
        expect(h.user.moderationNote).toBe("Human memo: keep this.\n");
      } finally { await h.store.close(); }
    });
  }

  for (const tier of ["T1", "T2"]) test(`retries a rejected ${tier} log without repeating the successful restriction`, async () => {
    const h = await fixture(tier, { MODERATION_NOTE_LANGUAGE: "en" });
    try {
      h.rejectNextLog();
      await h.worker().processOne();
      expect(await h.store.hasProcessed("note")).toBe(false);
      await Bun.sleep(10);
      await h.worker().processOne();
      const endpoint = tier === "T1" ? "admin/suspend-user" : "admin/roles/assign";
      expect(h.calls.filter((call) => call === endpoint)).toHaveLength(1);
      expect(h.calls.filter((call) => call === "admin/update-user-note")).toHaveLength(2);
      expect(h.user.moderationNote).toContain(tier === "T1" ? "Account suspended" : "Restrictive role");
      expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, pending: 0 }));
    } finally { await h.store.close(); }
  });
});
