const ALLOWED_RECOMMENDATIONS = new Set(["clear", "T2", "T3", "human-review"]);

export function validateLlmReview(value) {
  if (value?.schemaVersion !== 1) throw new Error("Unsupported LLM review schema version.");
  if (typeof value.caseId !== "string" || !value.caseId) throw new Error("LLM review caseId is required.");
  if (!ALLOWED_RECOMMENDATIONS.has(value.recommendation)) {
    throw new Error(`LLM recommendation ${String(value.recommendation)} is not allowed.`);
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    throw new Error("LLM review reason is required.");
  }
  if (
    !Array.isArray(value.termsSections) ||
    value.termsSections.length === 0 ||
    value.termsSections.some((section) => typeof section !== "string" || !section)
  ) {
    throw new Error("LLM review must cite at least one terms section.");
  }

  return Object.freeze({
    schemaVersion: 1,
    caseId: value.caseId,
    recommendation: value.recommendation,
    reason: value.reason,
    termsSections: Object.freeze([...value.termsSections]),
  });
}

export function resolveEffectiveDecision({ human, deterministic, llm }) {
  if (human != null) return human;
  if (deterministic === "T1") return "T1";
  if (llm === "clear" || llm === "T2" || llm === "T3") return llm;
  return deterministic;
}
