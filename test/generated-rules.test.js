import { describe, expect, test } from "#test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import generatedDocument from "../rules.generated.json" with { type: "json" };
import { loadGeneratedRules } from "../src/generated-rules.js";
import { loadReputationPolicy } from "../src/reputation-policy.js";

describe("statically generated rules", () => {
  test("were generated from the current rules.md", async () => {
    const source = await readFile(new URL("../rules.md", import.meta.url), "utf8");
    const normalizedSource = new TextEncoder().encode(source.replace(/\r\n/gu, "\n"));
    const sourceSha256 = createHash("sha256").update(normalizedSource).digest("hex");

    expect(generatedDocument.sourceSha256).toBe(sourceSha256);
  });

  test("load as validated immutable runtime rules", () => {
    const rules = loadGeneratedRules(generatedDocument);

    expect(generatedDocument.schemaVersion).toBe(2);
    expect(Array.isArray(rules)).toBe(true);
    expect(Object.isFrozen(rules)).toBe(true);
    expect(loadReputationPolicy(generatedDocument)).toEqual(expect.objectContaining({ id: "stopforumspam-account", tier: "T3" }));
  });

  test("accepts a complete safe generated rule", () => {
    const rules = loadGeneratedRules({
      schemaVersion: 2,
      rules: [
        {
          id: "example-log",
          enabled: true,
          field: "content",
          matchers: [
            { type: "contains", value: "example" },
            { type: "regex", source: "examples?", flags: "iu" },
          ],
          excludedUsers: ["trusted_user"],
          tier: "T3",
          reason: "validation example",
        },
      ],
    });

    expect(rules[0].id).toBe("example-log");
    expect(Object.isFrozen(rules[0].matchers)).toBe(true);
    expect(Object.isFrozen(rules[0].excludedUsers)).toBe(true);
  });

  test("rejects malformed or unsafe generated data", () => {
    expect(() => loadGeneratedRules({ schemaVersion: 1, rules: [] })).toThrow(/schema version/i);
    expect(() =>
      loadGeneratedRules({
        schemaVersion: 2,
        rules: [
          {
            id: "unsafe",
            enabled: true,
            field: "content",
            matchers: [{ type: "regex", source: "(a+)+$", flags: "u" }],
            excludedUsers: [],
            tier: "T1",
            reason: "unsafe regex",
          },
        ],
      }),
    ).toThrow(/unsafe regular expression/i);
  });
});
