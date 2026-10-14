import { describe, expect, test } from "bun:test";

import { classifyNote } from "../src/classification.js";

const note = {
  id: "note-1",
  text: "spam offer",
  userId: "user-1",
  user: { id: "user-1", username: "spammer", host: null },
};

function rule(id, tier, value = "spam") {
  return {
    id,
    enabled: true,
    tier,
    field: "text",
    matchers: [{ type: "contains", value }],
    excludedUsers: [],
    reason: id,
  };
}

describe("classifyNote", () => {
  test("uses the strongest tier when several deterministic rules match", () => {
    const result = classifyNote(note, [rule("observe", "T3"), rule("severe", "T1"), rule("limit", "T2")]);
    expect(result.tier).toBe("T1");
    expect(result.ruleIds).toEqual(["observe", "severe", "limit"]);
  });

  test("returns null when no deterministic rule matches", () => {
    expect(classifyNote(note, [rule("other", "T2", "not present")])).toBeNull();
  });
});
