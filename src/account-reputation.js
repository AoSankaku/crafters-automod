import { evaluateReputation } from "./reputation-policy.js";
import { isPublicIp } from "./stop-forum-spam.js";

const empty = (status, code) => ({ status, score: 0, signals: [], code });

/** Keep private account identifiers transient; persist only a small advisory verdict. */
export class AccountReputation {
  constructor({ store, misskey, provider, authority, policy, policyKey, checkIp = false,
    cacheTtlMs = 21600000, failureTtlMs = 300000, clock = Date.now, userStateMaxAgeMs = 5000 }) {
    Object.assign(this, { store, misskey, provider, authority, policy, policyKey, checkIp, cacheTtlMs, failureTtlMs, clock, userStateMaxAgeMs });
  }

  async check(envelope, context) {
    const { claim, assertActive, signal } = context;
    const assertAllowed = async () => {
      await assertActive();
      if (await this.authority.hasHumanDecision(envelope)) {
        throw Object.assign(new Error("A human decision prevents reputation lookup."), { code: "HUMAN_DECISION" });
      }
      signal.throwIfAborted();
    };
    let result;
    try { await assertAllowed(); } catch (error) {
      if (error?.code !== "HUMAN_DECISION") throw error;
      return this.skipped(envelope, "HUMAN_DECISION");
    }
    if (this.policy.excludedUserIds.includes(envelope.userId)) return this.skipped(envelope, "EXCLUDED_USER");
    const cached = await this.store.getReputation(envelope.userId, this.policyKey);
    if (cached) return { ...cached, cached: true };
    try {
      const user = await this.misskey.showUser(envelope.userId, { signal, beforeRequest: assertAllowed });
      const observedAt = this.clock();
      const assertFreshAccount = async () => {
        await assertAllowed();
        const age = this.clock() - observedAt;
        if (age < 0 || age > this.userStateMaxAgeMs) {
          throw Object.assign(new Error("Account state expired before external lookup."), { code: "STALE_ACCOUNT_STATE" });
        }
      };
      await assertAllowed();
      if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("Invalid account response.");
      if (user.isModerator || user.isAdministrator || user.isSuspended ||
          user.roles?.some((role) => role.isModerator || role.isAdministrator)) {
        result = empty("skipped", "PROTECTED_ACCOUNT");
      } else {
        const input = {};
        if (user.emailVerified === true && typeof user.email === "string" && user.email.trim()) input.email = user.email;
        if (this.checkIp) {
          try {
            const history = await this.misskey.getUserIps(envelope.userId, { signal, beforeRequest: assertAllowed });
            if (Array.isArray(history) && history.length <= 30) {
              const current = history.filter((entry) => {
                const timestamp = typeof entry?.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
                const age = this.clock() - timestamp;
                return Number.isFinite(age) && age >= -300000 && age <= this.policy.maxAgeDays * 86400000 && isPublicIp(entry.ip);
              }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
              if (current) input.ip = current.ip;
            }
          } catch (error) {
            await assertAllowed();
            if (error?.name === "StorageError") throw error;
            // An optional admin-only API must not discard an available verified email.
          }
        }
        if (!input.email && !input.ip) result = empty("skipped", "NO_IDENTIFIERS");
        else {
          await assertFreshAccount();
          result = evaluateReputation(await this.provider.lookup(input, { signal, beforeRequest: assertFreshAccount }), this.policy, { now: this.clock() });
        }
      }
    } catch (error) {
      await assertActive();
      signal.throwIfAborted();
      if (error?.code === "HUMAN_DECISION") return this.skipped(envelope, "HUMAN_DECISION");
      if (error?.name === "StorageError" || error?.code === "LEASE_LOST") throw error;
      result = empty("unavailable", "LOOKUP_UNAVAILABLE");
    }
    // Human decisions arriving during a read also prevent new review/cache evidence.
    try { await assertAllowed(); } catch (error) {
      if (error?.code !== "HUMAN_DECISION") throw error;
      return this.skipped(envelope, "HUMAN_DECISION");
    }
    const ttl = result.status === "unavailable" ? this.failureTtlMs : this.cacheTtlMs;
    await this.store.saveReputation(claim, this.policyKey, result, ttl);
    return { caseId: envelope.caseId, result, checkedAt: this.clock(), cached: false };
  }

  skipped(envelope, code) {
    return { caseId: envelope.caseId, result: empty("skipped", code), checkedAt: this.clock(), cached: false };
  }
}
