import { describe, expect, mock, test } from "bun:test";
import { createCaseHandler } from "../src/application.js";
import { AccountReputation } from "../src/account-reputation.js";
import { loadConfig } from "../src/config.js";
import { DurableIntake } from "../src/durable-intake.js";
import { DurableWorker } from "../src/durable-worker.js";
import { loadReputationPolicy, reputationPolicyKey } from "../src/reputation-policy.js";
import { createStore } from "../src/storage/index.js";

const logger = { info() {}, warn() {}, error() {} };
const sourceSha256 = "a".repeat(64);
const note = { id: "note", userId: "user", user: { id: "user", username: "member", host: null }, text: "Ordinary private content" };
async function harness({ listed = true } = {}) {
  const config = loadConfig({ MISSKEY_URL: "https://misskey.example", MISSKEY_TOKEN: "test-only", SFS_ENABLED: "true", AUTOMOD_MODE: "enforce" });
  const store = await createStore({ sqlitePath: ":memory:", namespace: "sfs-integration" });
  const policy = loadReputationPolicy({ accountReputation: { schemaVersion: 1, id: "stopforumspam-account", enabled: true, tier: "T3", reason: "Account reputation observation", minFrequency: 3, minConfidence: 75, maxAgeDays: 90, emailScore: 40, ipScore: 20, excludedUserIds: [] } });
  const key = reputationPolicyKey(policy, { sourceSha256, checkIp: false });
  const authority = { hasHumanDecision: (value) => store.hasHumanDecision(value) };
  const client = { showUser: mock(async (_id, options) => { await options.beforeRequest(); return { email: "member@example.invalid", emailVerified: true }; }),
    suspendUser: mock(async () => {}), assignRole: mock(async () => {}) };
  const provider = { lookup: mock(async (_input, options) => { await options.beforeRequest(); return { email: { appears: listed, frequency: listed ? 10 : 0, confidence: listed ? 99 : 0, lastSeen: Math.floor(Date.now() / 1000) - 60 } }; }) };
  const reputationService = new AccountReputation({ store, misskey: client, provider, authority, policy, policyKey: key });
  const intake = new DurableIntake({ store, rules: [], sourceSha256, mode: config.mode, selfUserId: "automod", reputationPolicy: policy, reputationPolicyKey: key, maxPendingNotes: 10, logger });
  const handle = createCaseHandler({ store, config, rules: [], sourceSha256, client, authority, logger, selfUserId: "automod", reputationPolicy: policy, reputationService });
  const worker = new DurableWorker({ store, handle, logger });
  const events = async () => { const all = []; for await (const row of store.exportState()) if (row.kind === "audit") all.push(row.event); return all; };
  return { config, store, client, provider, intake, worker, events, policy, reputationService, authority };
}

describe("Stop Forum Spam durable integration", () => {
  test("a reputation-only match raises T3 awareness without any Misskey mutation", async () => {
    const h = await harness();
    try {
      expect(await h.intake.submit(note)).toBe(true);
      expect(await h.worker.processOne()).toBe(true);
      expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, reviewJobs: 1, dead: 0 }));
      expect(h.client.suspendUser).not.toHaveBeenCalled();
      expect(h.client.assignRole).not.toHaveBeenCalled();
      expect(await h.events()).toContainEqual(expect.objectContaining({ type: "reputation.assessed", riskScore: 40 }));
      expect(await h.events()).toContainEqual(expect.objectContaining({ type: "case.classified", tier: "T3", ruleIds: [h.policy.id] }));
      for await (const row of h.store.exportState()) expect(JSON.stringify(row)).not.toMatch(/member@example|Ordinary private/);
      expect(await h.intake.submit({ ...note, id: "another-note" })).toBe(false);
      expect(h.intake.snapshot().cached).toBe(1);
      expect(h.provider.lookup).toHaveBeenCalledTimes(1);
    } finally { await h.intake.close(); await h.store.close(); }
  });
  test("nonmatches and provider failure never become restrictive cases", async () => {
    for (const failure of [false, true]) {
      const h = await harness({ listed: false });
      if (failure) h.provider.lookup.mockRejectedValue(new Error("private upstream response"));
      try {
        await h.intake.submit(note);
        await h.worker.processOne();
        expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, reviewJobs: 0, purgeJobs: 0 }));
        expect(h.client.suspendUser).not.toHaveBeenCalled();
        expect(h.client.assignRole).not.toHaveBeenCalled();
        expect(JSON.stringify(await h.events())).not.toContain("private upstream");
        expect(await h.events()).toContainEqual(expect.objectContaining({ type: "reputation.assessed", outcome: failure ? "unavailable" : "clear" }));
      } finally { await h.intake.close(); await h.store.close(); }
    }
  });
  test("a human decision before or during lookup suppresses T3 review", async () => {
    for (const during of [false, true]) {
      const h = await harness();
      try {
        await h.intake.submit(note);
        if (during) h.provider.lookup.mockImplementation(async () => {
          await h.store.setHumanDecision({ scope: "user", id: "user", reason: "Human resolution" });
          return { email: { appears: true, frequency: 99, confidence: 99, lastSeen: Math.floor(Date.now() / 1000) } };
        });
        else await h.store.setHumanDecision({ scope: "user", id: "user", reason: "Human resolution" });
        await h.worker.processOne();
        expect(await h.store.stats()).toEqual(expect.objectContaining({ completed: 1, reviewJobs: 0 }));
        if (!during) expect(h.provider.lookup).not.toHaveBeenCalled();
      } finally { await h.intake.close(); await h.store.close(); }
    }
  });
});
