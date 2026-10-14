import { findMatchingRules } from "./matcher.js";

const TIER_STRENGTH = Object.freeze({ T3: 1, T2: 2, T1: 3 });

export function classifyNote(note, rules, selfUserId) {
  const matchingRules = findMatchingRules(note, rules, selfUserId);
  if (matchingRules.length === 0) return null;

  const strongest = matchingRules.reduce((current, rule) =>
    TIER_STRENGTH[rule.tier] > TIER_STRENGTH[current.tier] ? rule : current,
  );
  return Object.freeze({
    tier: strongest.tier,
    ruleIds: Object.freeze(matchingRules.map((rule) => rule.id)),
    reasons: Object.freeze(matchingRules.map((rule) => rule.reason)),
  });
}
