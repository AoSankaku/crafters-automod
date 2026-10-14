const ALLOWED_FIELDS = new Set(["content", "text", "cw", "username", "filename"]);
const ALLOWED_TIERS = new Set(["T1", "T2", "T3"]);
const ALLOWED_REGEX_FLAGS = /^[dgimsuvy]*$/u;
const MAX_REGEX_LENGTH = 500;

export function loadGeneratedRules(document) {
  if (document?.schemaVersion !== 2) {
    throw new Error("Unsupported generated rules schema version.");
  }
  if (!Array.isArray(document.rules)) {
    throw new Error("Generated rules must contain a rules array.");
  }

  const seenIds = new Set();
  const rules = document.rules.map((rule, index) => validateRule(rule, index, seenIds));
  return Object.freeze(rules);
}

function validateRule(rule, index, seenIds) {
  const label = typeof rule?.id === "string" ? rule.id : `#${index + 1}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(rule?.id)) {
    throw new Error(`Generated rule ${label} has an invalid id.`);
  }
  if (seenIds.has(rule.id)) throw new Error(`Generated rule id ${rule.id} is duplicated.`);
  seenIds.add(rule.id);

  if (typeof rule.enabled !== "boolean") throw new Error(`Generated rule ${label} has invalid enabled.`);
  if (!ALLOWED_FIELDS.has(rule.field)) throw new Error(`Generated rule ${label} has an invalid field.`);
  if (!ALLOWED_TIERS.has(rule.tier)) throw new Error(`Generated rule ${label} has an invalid tier.`);
  if (typeof rule.reason !== "string" || !rule.reason.trim()) {
    throw new Error(`Generated rule ${label} must have a reason.`);
  }
  if (!Array.isArray(rule.excludedUsers) || rule.excludedUsers.some((user) => typeof user !== "string")) {
    throw new Error(`Generated rule ${label} has invalid excludedUsers.`);
  }
  if (!Array.isArray(rule.matchers) || rule.matchers.length === 0) {
    throw new Error(`Generated rule ${label} needs at least one matcher.`);
  }

  const matchers = rule.matchers.map((matcher) => validateMatcher(matcher, label));
  return Object.freeze({
    id: rule.id,
    enabled: rule.enabled,
    field: rule.field,
    matchers: Object.freeze(matchers),
    excludedUsers: Object.freeze([...rule.excludedUsers]),
    tier: rule.tier,
    reason: rule.reason,
  });
}

function validateMatcher(matcher, ruleId) {
  if (matcher?.type === "contains") {
    if (typeof matcher.value !== "string" || !matcher.value) {
      throw new Error(`Generated rule ${ruleId} has an empty contains matcher.`);
    }
    return Object.freeze({ type: "contains", value: matcher.value });
  }
  if (matcher?.type !== "regex" || typeof matcher.source !== "string" || typeof matcher.flags !== "string") {
    throw new Error(`Generated rule ${ruleId} has an invalid matcher.`);
  }
  if (
    matcher.source.length > MAX_REGEX_LENGTH ||
    !ALLOWED_REGEX_FLAGS.test(matcher.flags) ||
    /\\[1-9]/u.test(matcher.source) ||
    /\(\?<([=!])/u.test(matcher.source) ||
    /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/u.test(matcher.source)
  ) {
    throw new Error(`Generated rule ${ruleId} has an unsafe regular expression.`);
  }
  try {
    new RegExp(matcher.source, matcher.flags);
  } catch {
    throw new Error(`Generated rule ${ruleId} has an invalid regular expression.`);
  }
  return Object.freeze({ type: "regex", source: matcher.source, flags: matcher.flags });
}
