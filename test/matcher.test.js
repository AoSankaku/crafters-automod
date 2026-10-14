import { describe, expect, test } from "bun:test";

import { findMatchingRules, noteFieldValue } from "../src/matcher.js";

const localNote = {
  id: "note-1",
  text: "Free   CRYPTO for everyone",
  cw: "Promotion",
  userId: "user-1",
  user: { id: "user-1", username: "spammer", host: null },
  files: [{ name: "offer.png", comment: "buy followers" }],
  poll: { choices: [{ text: "Click here", votes: 0 }] },
};

const baseRule = {
  id: "spam",
  enabled: true,
  field: "content",
  matchers: [{ type: "regex", source: "free\\s+crypto", flags: "iu" }],
  excludedUsers: [],
  tier: "T2",
  reason: "spam",
};

describe("noteFieldValue", () => {
  test("content combines text, CW, file metadata, and poll choices", () => {
    expect(noteFieldValue(localNote, "content")).toContain("Free   CRYPTO");
    expect(noteFieldValue(localNote, "content")).toContain("Promotion");
    expect(noteFieldValue(localNote, "content")).toContain("offer.png");
    expect(noteFieldValue(localNote, "content")).toContain("Click here");
  });
});

describe("findMatchingRules", () => {
  test("matches case-insensitive regular expressions", () => {
    expect(findMatchingRules(localNote, [baseRule], "automod-user")).toEqual([baseRule]);
  });

  test("matches contains filters case-insensitively", () => {
    const rule = {
      ...baseRule,
      matchers: [{ type: "contains", value: "BUY FOLLOWERS" }],
    };

    expect(findMatchingRules(localNote, [rule], "automod-user")).toEqual([rule]);
  });

  test("ignores disabled rules, excluded users, remote users, and the bot itself", () => {
    const excluded = { ...baseRule, excludedUsers: ["@Spammer"] };
    const disabled = { ...baseRule, id: "disabled", enabled: false };
    const remoteNote = {
      ...localNote,
      user: { ...localNote.user, host: "remote.example" },
    };

    expect(findMatchingRules(localNote, [excluded, disabled], "automod-user")).toEqual([]);
    expect(findMatchingRules(remoteNote, [baseRule], "automod-user")).toEqual([]);
    expect(findMatchingRules(localNote, [baseRule], "user-1")).toEqual([]);
  });
});
