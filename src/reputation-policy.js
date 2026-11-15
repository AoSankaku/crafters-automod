import { createHash } from "node:crypto";

const FIELDS = new Set(["schemaVersion", "id", "enabled", "tier", "reason", "minFrequency", "minConfidence", "maxAgeDays", "emailScore", "ipScore", "excludedUserIds"]);

/** Only the human-authored policy's compiled artifact may enable advisory classification. */
export function loadReputationPolicy(document) {
  const policy = document?.accountReputation;
  if (policy === undefined) return null;
  if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).length !== FIELDS.size || Object.keys(policy).some((field) => !FIELDS.has(field)) ||
      policy.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(policy.id) ||
      typeof policy.enabled !== "boolean" || policy.tier !== "T3" ||
      typeof policy.reason !== "string" || !policy.reason.trim() || policy.reason.length > 2048 ||
      !integer(policy.minFrequency, 1, 10000) || !number(policy.minConfidence, 0, 100) ||
      !integer(policy.maxAgeDays, 1, 365) || !integer(policy.emailScore, 1, 100) || !integer(policy.ipScore, 1, 100) ||
      !Array.isArray(policy.excludedUserIds) || policy.excludedUserIds.length > 10000 ||
      !policy.excludedUserIds.every((id) => typeof id === "string" && /^[a-z0-9_-]{1,128}$/iu.test(id))) {
    throw new Error("Invalid compiled account reputation policy; only T3 observation is permitted.");
  }
  return Object.freeze({ ...policy, excludedUserIds: Object.freeze([...policy.excludedUserIds]) });
}

export function reputationPolicyKey(policy, { sourceSha256, checkIp = false }) {
  return createHash("sha256").update(JSON.stringify({ version: 1, policy, sourceSha256, checkIp })).digest("hex");
}

export function evaluateReputation(evidence, policy, { now = Date.now() } = {}) {
  const signals = [];
  let score = 0;
  for (const kind of ["email", "ip"]) {
    const entry = evidence?.[kind];
    if (!entry?.appears || !integer(entry.frequency, policy.minFrequency, Number.MAX_SAFE_INTEGER) ||
        !number(entry.confidence, policy.minConfidence, 100) || !integer(entry.lastSeen, 0, Number.MAX_SAFE_INTEGER)) continue;
    const age = now / 1000 - entry.lastSeen;
    if (age < -300 || age > policy.maxAgeDays * 86400) continue;
    signals.push({ kind, frequency: entry.frequency, confidence: entry.confidence, lastSeen: entry.lastSeen });
    score += kind === "email" ? policy.emailScore : policy.ipScore;
  }
  return { status: signals.length ? "listed" : "clear", score: Math.min(100, score), signals };
}

function number(value, min, max) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
