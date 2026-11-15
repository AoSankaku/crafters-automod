import { describe, expect, mock, test } from "bun:test";
import { loadReputationPolicy, evaluateReputation, reputationPolicyKey } from "../src/reputation-policy.js";
import { AccountReputation } from "../src/account-reputation.js";

const now = Date.parse("2026-11-15T00:00:00Z");
const policyInput = {
  schemaVersion: 1, id: "stopforumspam-account", enabled: true, tier: "T3",
  reason: "Recent Stop Forum Spam account evidence requires observation",
  minFrequency: 3, minConfidence: 75, maxAgeDays: 90,
  emailScore: 40, ipScore: 20, excludedUserIds: [],
};
const policy = () => loadReputationPolicy({ accountReputation: policyInput });
const hit = () => ({ appears: true, frequency: 12, confidence: 90, lastSeen: now / 1000 - 3600 });
function harness({ profile = { email: "private-mailbox@example.invalid", emailVerified: true }, result = { email: hit() }, checkIp = false } = {}) {
  const store = { getReputation: mock(async () => null), saveReputation: mock(async () => {}) };
  const misskey = { showUser: mock(async (_id, options) => { await options.beforeRequest(); return profile; }),
    getUserIps: mock(async (_id, options) => { await options.beforeRequest(); return [{ ip: "8.8.8.8", createdAt: new Date(now - 1000).toISOString() }]; }) };
  const authority = { hasHumanDecision: mock(async () => false) };
  const provider = { lookup: mock(async (_input, options) => { await options.beforeRequest(); return result; }) };
  const review = new AccountReputation({ store, misskey, provider, authority, policy: policy(), policyKey: "a".repeat(64),
    checkIp, clock: () => now, cacheTtlMs: 21600000, failureTtlMs: 300000 });
  const envelope = { caseId: "note", noteId: "note", userId: "user" };
  const context = { claim: { noteId: "note", userId: "user" }, assertActive: mock(async () => {}), signal: new AbortController().signal };
  return { store, misskey, provider, authority, review, envelope, context };
}

describe("compiled reputation policy", () => {
  test("is optional and cannot grant T1 or T2 authority", () => {
    expect(loadReputationPolicy({})).toBeNull();
    expect(policy().tier).toBe("T3");
    expect(Object.isFrozen(policy())).toBe(true);
    for (const change of [{ tier: "T1" }, { tier: "T2" }, { minFrequency: 0 }, { minConfidence: 101 }, { maxAgeDays: 0 }, { emailScore: 101 }, { unknown: true }]) {
      expect(() => loadReputationPolicy({ accountReputation: { ...policyInput, ...change } })).toThrow();
    }
  });
  test("requires current sufficiently frequent confident evidence and emits only aggregate signals", () => {
    expect(evaluateReputation({ email: hit(), ip: hit() }, policy(), { now })).toEqual({ status: "listed", score: 60,
      signals: [{ kind: "email", frequency: 12, confidence: 90, lastSeen: hit().lastSeen }, { kind: "ip", frequency: 12, confidence: 90, lastSeen: hit().lastSeen }] });
    for (const change of [{ appears: false }, { frequency: 2 }, { confidence: 74 }, { lastSeen: now / 1000 - 91 * 86400 }, { lastSeen: now / 1000 + 301 }]) {
      expect(evaluateReputation({ email: { ...hit(), ...change } }, policy(), { now }).status).toBe("clear");
    }
    expect(reputationPolicyKey(policy(), { sourceSha256: "a".repeat(64), checkIp: false })).not.toBe(reputationPolicyKey(policy(), { sourceSha256: "a".repeat(64), checkIp: true }));
  });
});

describe("account reputation enrichment", () => {
  test("queries only verified account identifiers and stores no email, IP or hash", async () => {
    const h = harness();
    const assessment = await h.review.check(h.envelope, h.context);
    expect(assessment.result.status).toBe("listed");
    expect(h.provider.lookup.mock.calls[0][0]).toEqual({ email: "private-mailbox@example.invalid" });
    expect(h.misskey.getUserIps).not.toHaveBeenCalled();
    expect(h.store.saveReputation).toHaveBeenCalledWith(h.context.claim, "a".repeat(64), assessment.result, 21600000);
    expect(JSON.stringify(h.store.saveReputation.mock.calls)).not.toMatch(/private-mailbox|8\.8\.8\.8/);
  });
  test("unverified email and usernames never become provider inputs", async () => {
    const h = harness({ profile: { email: "spoofed@example.invalid", emailVerified: false, username: "spammer" } });
    expect((await h.review.check(h.envelope, h.context)).result.status).toBe("skipped");
    expect(h.provider.lookup).not.toHaveBeenCalled();
  });
  test("checks only recent dedicated IP history when explicitly enabled", async () => {
    const h = harness({ checkIp: true, result: { email: hit(), ip: hit() } });
    expect((await h.review.check(h.envelope, h.context)).result.score).toBe(60);
    expect(h.provider.lookup.mock.calls[0][0]).toEqual({ email: "private-mailbox@example.invalid", ip: "8.8.8.8" });
    const stale = harness({ checkIp: true });
    stale.misskey.getUserIps.mockResolvedValue([{ ip: "8.8.8.8", createdAt: "2020-01-01T00:00:00Z" }, { ip: "127.0.0.1", createdAt: new Date(now).toISOString() }]);
    await stale.review.check(stale.envelope, stale.context);
    expect(stale.provider.lookup.mock.calls[0][0]).toEqual({ email: "private-mailbox@example.invalid" });
  });
  test("shared cached evidence avoids another account/API lookup and retains origin case", async () => {
    const h = harness();
    const cached = { caseId: "previous-note", result: { status: "listed", score: 40, signals: [] }, checkedAt: now - 1000, expiresAt: now + 1000 };
    h.store.getReputation.mockResolvedValue(cached);
    expect(await h.review.check(h.envelope, h.context)).toEqual({ ...cached, cached: true });
    expect(h.misskey.showUser).not.toHaveBeenCalled();
    expect(h.provider.lookup).not.toHaveBeenCalled();
  });
  test("human overrides and protected accounts prevent external lookups", async () => {
    const h = harness();
    h.authority.hasHumanDecision.mockResolvedValue(true);
    expect((await h.review.check(h.envelope, h.context)).result.code).toBe("HUMAN_DECISION");
    expect(h.provider.lookup).not.toHaveBeenCalled();
    expect(h.misskey.showUser).not.toHaveBeenCalled();
    for (const profile of [{ isAdministrator: true }, { isModerator: true }, { roles: [{ isModerator: true }] }, { isSuspended: true }]) {
      const p = harness({ profile });
      expect((await p.review.check(p.envelope, p.context)).result.code).toBe("PROTECTED_ACCOUNT");
      expect(p.provider.lookup).not.toHaveBeenCalled();
    }
  });
  test("rechecks human authority after an API budget wait and keeps failure unknown", async () => {
    const h = harness();
    h.provider.lookup.mockImplementation(async (_input, options) => {
      h.authority.hasHumanDecision.mockResolvedValue(true);
      await options.beforeRequest();
      throw new Error("external fetch must not run");
    });
    expect((await h.review.check(h.envelope, h.context)).result.code).toBe("HUMAN_DECISION");
    expect(h.store.saveReputation).not.toHaveBeenCalled();
    const failed = harness();
    failed.provider.lookup.mockRejectedValue(new Error("private-mailbox@example.invalid in provider error"));
    const assessment = await failed.review.check(failed.envelope, failed.context);
    expect(assessment.result.status).toBe("unavailable");
    expect(JSON.stringify(assessment)).not.toContain("private-mailbox");
    expect(failed.store.saveReputation.mock.calls[0][3]).toBe(300000);
  });
  test("lease loss and storage failure are not disguised as clean reputation", async () => {
    const h = harness();
    h.context.assertActive.mockRejectedValue(Object.assign(new Error("lost"), { code: "LEASE_LOST" }));
    await expect(h.review.check(h.envelope, h.context)).rejects.toThrow("lost");
    expect(h.provider.lookup).not.toHaveBeenCalled();
    const broken = harness();
    broken.store.getReputation.mockRejectedValue(new Error("storage failure"));
    await expect(broken.review.check(broken.envelope, broken.context)).rejects.toThrow("storage failure");
  });
});
