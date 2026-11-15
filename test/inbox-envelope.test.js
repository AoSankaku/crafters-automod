import { describe, expect, test } from "#test";
import { createInboxEnvelope, validateInboxEnvelope } from "../src/inbox-envelope.js";

const sourceSha256 = "a".repeat(64);
const rules = [{
  id: "observe-spam", enabled: true, tier: "T3", field: "text",
  matchers: [{ type: "contains", value: "spam" }], excludedUsers: [], reason: "Observe known spam indicator",
}];
const options = { sourceSha256, mode: "dry-run", selfUserId: "automod" };
const note = {
  id: "note-1", userId: "user-1", user: { id: "user-1", username: "alice", host: null },
  text: "spam with private note content", cw: "private warning", files: [{ name: "private filename" }],
};

describe("durable inbox envelope", () => {
  test("queues an explicit body-free reputation candidate without inventing a deterministic verdict", () => {
    const reputationPolicy = { id: "stopforumspam-account", enabled: true, tier: "T3", excludedUserIds: [] };
    const envelope = createInboxEnvelope({ ...note, text: "ordinary private note" }, rules, { ...options, reputationPolicy });
    expect(envelope).toEqual({ schemaVersion: 2, kind: "account-reputation", sourceSha256, mode: "dry-run",
      caseId: "note-1", noteId: "note-1", userId: "user-1", ruleId: "stopforumspam-account" });
    expect(JSON.stringify(envelope)).not.toMatch(/private|username|email|ip/);
    expect(validateInboxEnvelope(envelope, { ...options, rules, reputationPolicy })).toEqual(envelope);
    for (const change of [{ tier: "T1" }, { ruleId: "unknown" }, { sourceSha256: "b".repeat(64) }, { text: "private" }]) {
      expect(() => validateInboxEnvelope({ ...envelope, ...change }, { ...options, rules, reputationPolicy })).toThrow();
    }
    expect(createInboxEnvelope({ ...note, text: "ordinary" }, rules, { ...options, reputationPolicy: { ...reputationPolicy, excludedUserIds: ["user-1"] } })).toBeNull();
  });
  test("persists classification and IDs without raw note content or user profile", () => {
    const envelope = createInboxEnvelope(note, rules, options);
    expect(envelope).toEqual({
      schemaVersion: 1, sourceSha256, mode: "dry-run", caseId: "note-1", noteId: "note-1",
      userId: "user-1", tier: "T3", ruleIds: ["observe-spam"], reasons: [rules[0].reason],
    });
    expect(JSON.stringify(envelope)).not.toContain("private");
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.ruleIds)).toBe(true);
    expect(validateInboxEnvelope(envelope, { ...options, rules })).toEqual(envelope);
  });

  test("ignores unmatched, remote, self, and conflicting-author events", () => {
    expect(createInboxEnvelope({ ...note, text: "hello" }, rules, options)).toBeNull();
    expect(createInboxEnvelope({ ...note, user: { ...note.user, host: "remote.example" } }, rules, options)).toBeNull();
    expect(createInboxEnvelope({ ...note, userId: "automod", user: { ...note.user, id: "automod" } }, rules, options)).toBeNull();
    expect(createInboxEnvelope({ ...note, userId: "different-user" }, rules, options)).toBeNull();
  });

  test("rejects unexpected content, forged tiers, unknown rules, and stale policy or mode", () => {
    const envelope = createInboxEnvelope(note, rules, options);
    for (const changes of [
      { text: note.text }, { schemaVersion: 2 }, { tier: "T1" }, { userId: "" },
      { caseId: "other-note" }, { ruleIds: ["unknown"] }, { reasons: ["invented reason"] },
      { sourceSha256: "b".repeat(64) }, { mode: "enforce" },
    ]) {
      expect(() => validateInboxEnvelope({ ...envelope, ...changes }, { ...options, rules })).toThrow();
    }
  });
});
