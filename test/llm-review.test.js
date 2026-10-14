import { describe, expect, test } from "bun:test";

import { resolveEffectiveDecision, validateLlmReview } from "../src/llm-review.js";

describe("validateLlmReview", () => {
  test("accepts a typed T2/T3 recommendation tied to terms evidence", () => {
    expect(
      validateLlmReview({
        schemaVersion: 1,
        caseId: "case-1",
        recommendation: "T2",
        reason: "Repeated solicitation violates section 4.",
        termsSections: ["4"],
      }),
    ).toEqual({
      schemaVersion: 1,
      caseId: "case-1",
      recommendation: "T2",
      reason: "Repeated solicitation violates section 4.",
      termsSections: ["4"],
    });
  });

  test("rejects an LLM attempt to directly trigger T1", () => {
    expect(() =>
      validateLlmReview({
        schemaVersion: 1,
        caseId: "case-1",
        recommendation: "T1",
        reason: "Suspend now",
        termsSections: ["4"],
      }),
    ).toThrow(/not allowed/i);
  });
});

describe("resolveEffectiveDecision", () => {
  test("human decisions always override deterministic and LLM decisions", () => {
    expect(resolveEffectiveDecision({ human: "clear", deterministic: "T2", llm: "T3" })).toBe("clear");
  });

  test("deterministic T1 cannot be downgraded by the LLM", () => {
    expect(resolveEffectiveDecision({ human: null, deterministic: "T1", llm: "T3" })).toBe("T1");
  });

  test("a validated LLM recommendation may refine T2/T3", () => {
    expect(resolveEffectiveDecision({ human: null, deterministic: "T3", llm: "T2" })).toBe("T2");
  });
});
