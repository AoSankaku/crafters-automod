import { classifyNote } from "./classification.js";

const FIELDS = new Set(["schemaVersion", "sourceSha256", "mode", "caseId", "noteId", "userId", "tier", "ruleIds", "reasons"]);
const STRENGTH = { T3: 1, T2: 2, T1: 3 };
const REPUTATION_FIELDS = new Set(["schemaVersion", "kind", "sourceSha256", "mode", "caseId", "noteId", "userId", "ruleId"]);

export class InvalidInboxEnvelopeError extends Error {
  constructor(message = "Invalid durable inbox envelope.", code = "INVALID_ENVELOPE") {
    super(message);
    this.name = "InvalidInboxEnvelopeError";
    this.code = code;
    this.permanent = true;
  }
}

export function createInboxEnvelope(note, rules, { sourceSha256, mode, selfUserId, reputationPolicy = null }) {
  const userId = note?.userId ?? note?.user?.id;
  if (!identifier(note?.id) || !identifier(userId) || !note?.user || note.user.host != null) return null;
  if (note.user.id != null && note.user.id !== userId) return null;
  if (userId === selfUserId) return null;
  const classification = classifyNote(note, rules, selfUserId);
  if (!classification) {
    if (!reputationPolicy?.enabled || reputationPolicy.excludedUserIds.includes(userId)) return null;
    return validateInboxEnvelope({ schemaVersion: 2, kind: "account-reputation", sourceSha256, mode,
      caseId: note.id, noteId: note.id, userId, ruleId: reputationPolicy.id }, { sourceSha256, mode, rules, reputationPolicy });
  }
  return validateInboxEnvelope({
    schemaVersion: 1,
    sourceSha256,
    mode,
    caseId: note.id,
    noteId: note.id,
    userId,
    tier: classification.tier,
    ruleIds: [...classification.ruleIds],
    reasons: [...classification.reasons],
  }, { sourceSha256, mode, rules });
}

export function validateInboxEnvelope(value, { sourceSha256, mode, rules, reputationPolicy = null }) {
  if (value?.schemaVersion === 2 && value.kind === "account-reputation") {
    if (Object.keys(value).length !== REPUTATION_FIELDS.size || Object.keys(value).some((key) => !REPUTATION_FIELDS.has(key)) ||
        !identifier(value.noteId) || !identifier(value.userId) || value.caseId !== value.noteId ||
        !["dry-run", "enforce"].includes(value.mode) || !/^[a-f0-9]{64}$/u.test(value.sourceSha256) ||
        !reputationPolicy?.enabled || reputationPolicy.tier !== "T3" || value.ruleId !== reputationPolicy.id ||
        reputationPolicy.excludedUserIds.includes(value.userId)) throw new InvalidInboxEnvelopeError();
    if (value.sourceSha256 !== sourceSha256 || value.mode !== mode) {
      throw new InvalidInboxEnvelopeError("Queued reputation check does not match worker policy or mode.", "POLICY_MISMATCH");
    }
    return Object.freeze({ ...value });
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== FIELDS.size || Object.keys(value).some((key) => !FIELDS.has(key)) ||
      value.schemaVersion !== 1 || !identifier(value.noteId) || !identifier(value.userId) || value.caseId !== value.noteId ||
      !["dry-run", "enforce"].includes(value.mode) || !/^[a-f0-9]{64}$/u.test(value.sourceSha256)) {
    throw new InvalidInboxEnvelopeError();
  }
  if (value.sourceSha256 !== sourceSha256 || value.mode !== mode) {
    throw new InvalidInboxEnvelopeError("Queued case does not match the worker policy or mode.", "POLICY_MISMATCH");
  }
  if (!Array.isArray(value.ruleIds) || value.ruleIds.length === 0 || value.ruleIds.length > 256 ||
      !Array.isArray(value.reasons) || value.reasons.length !== value.ruleIds.length ||
      new Set(value.ruleIds).size !== value.ruleIds.length) {
    throw new InvalidInboxEnvelopeError();
  }
  const known = new Map(rules.map((rule) => [rule.id, rule]));
  let strongest = "T3";
  for (let index = 0; index < value.ruleIds.length; index += 1) {
    const rule = known.get(value.ruleIds[index]);
    if (!rule?.enabled || !STRENGTH[rule.tier] || value.reasons[index] !== rule.reason || rule.reason.length > 2048) {
      throw new InvalidInboxEnvelopeError();
    }
    if (STRENGTH[rule.tier] > STRENGTH[strongest]) strongest = rule.tier;
  }
  if (value.tier !== strongest) throw new InvalidInboxEnvelopeError();
  return Object.freeze({
    schemaVersion: 1, sourceSha256: value.sourceSha256, mode: value.mode,
    caseId: value.caseId, noteId: value.noteId, userId: value.userId, tier: value.tier,
    ruleIds: Object.freeze([...value.ruleIds]), reasons: Object.freeze([...value.reasons]),
  });
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f]/u.test(value);
}
