import { classifyNote } from "./classification.js";

const FIELDS = new Set(["schemaVersion", "sourceSha256", "mode", "caseId", "noteId", "userId", "tier", "ruleIds", "reasons"]);
const STRENGTH = { T3: 1, T2: 2, T1: 3 };

export class InvalidInboxEnvelopeError extends Error {
  constructor(message = "Invalid durable inbox envelope.", code = "INVALID_ENVELOPE") {
    super(message);
    this.name = "InvalidInboxEnvelopeError";
    this.code = code;
    this.permanent = true;
  }
}

export function createInboxEnvelope(note, rules, { sourceSha256, mode, selfUserId }) {
  const userId = note?.userId ?? note?.user?.id;
  if (!identifier(note?.id) || !identifier(userId) || !note?.user || note.user.host != null) return null;
  if (note.user.id != null && note.user.id !== userId) return null;
  if (userId === selfUserId) return null;
  const classification = classifyNote(note, rules, selfUserId);
  if (!classification) return null;
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

export function validateInboxEnvelope(value, { sourceSha256, mode, rules }) {
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
