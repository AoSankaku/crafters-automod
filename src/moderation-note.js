import { createHash } from "node:crypto";

const MAX_MODERATION_NOTE_LENGTH = 60_000;
const MAX_ENTRY_LENGTH = 4_096;
const MAX_REASON_LENGTH = 250;
const MAX_LIST_ITEMS = 8;
const AUTOMATION_EVENTS = new Set([
  "t1.suspended",
  "t1.purge.queued",
  "t1.enforcement.failed",
  "t2.role.assigned",
  "t2.role.failed",
  "t3.observed",
  "automation.skipped.human",
  "automation.skipped.human-state",
  "automation.skipped.uncertain",
  "automation.skipped.protected",
  "llm-review.queued",
]);
const DEFINITIVE_REJECTIONS = new Set([400, 401, 403, 404, 422, 429]);
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const BIDI_CONTROL_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const EMAIL = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/giu;

export class ModerationNoteWriter {
  constructor({
    moderator,
    authority,
    journal,
    assertActive = async () => {},
    signal,
    record,
    logger,
    language = "ja",
    clock = () => performance.now(),
    userStateMaxAgeMs = 5_000,
  }) {
    this.moderator = moderator;
    this.authority = authority;
    this.journal = journal ?? null;
    this.assertActive = assertActive;
    this.signal = signal;
    this.record = record ?? (async () => {});
    this.logger = logger;
    this.language = language === "en" ? "en" : "ja";
    this.clock = clock;
    this.userStateMaxAgeMs = Number.isFinite(userStateMaxAgeMs) && userStateMaxAgeMs >= 0
      ? userStateMaxAgeMs
      : 5_000;
  }

  async write(moderationCase, events = []) {
    const safeCase = sanitizeCase(moderationCase);
    const eventTypes = [...new Set(events
      .map((event) => event?.type)
      .filter((type) => AUTOMATION_EVENTS.has(type)))].sort();
    if (!safeCase || eventTypes.length === 0) {
      if (safeCase) await this.audit("moderation-note.skipped", safeCase, {
        actor: "deterministic",
        reason: "no_supported_case_outcome",
        outcome: "automation_skipped",
      });
      return true;
    }

    if (!this.hasDurableJournal()) {
      await this.audit("moderation-note.failed", safeCase, {
        actor: "deterministic",
        reason: "durable_journal_required",
        outcome: "retry_required",
      });
      return false;
    }

    const marker = createMarker(safeCase, eventTypes);
    const actionKey = `moderation-note:${marker.slice("<!-- automod-log:".length, -" -->".length)}`;
    let actionStarted = false;

    try {
      await this.assertMutationAllowed(safeCase);
      const action = await this.journal.get(actionKey);
      if (action?.status === "completed") return true;
      if (action && action.status !== "started") {
        await this.audit("moderation-note.uncertain", safeCase, {
          actor: "deterministic",
          reason: "unknown_moderation_note_journal_state",
          outcome: "human_review_required",
        });
        return true;
      }

      let observedAt = null;
      const user = await this.moderator.showUser(safeCase.userId, {
        signal: this.signal,
        beforeRequest: async () => {
          await this.assertMutationAllowed(safeCase);
          observedAt = this.clock();
        },
      });
      if (!isUserState(user) || observedAt === null) {
        await this.audit("moderation-note.failed", safeCase, {
          actor: "deterministic",
          reason: "invalid_misskey_user_state",
          outcome: "retry_required",
        });
        return false;
      }
      this.assertFreshUser(observedAt);

      if (isProtectedAccount(user)) {
        await this.audit("moderation-note.skipped", safeCase, {
          actor: "deterministic",
          reason: "moderator_or_administrator_account",
          outcome: "automation_skipped",
        });
        return true;
      }
      await this.assertMutationAllowed(safeCase);

      if (typeof user.moderationNote !== "string") {
        await this.audit("moderation-note.failed", safeCase, {
          actor: "deterministic",
          reason: "invalid_misskey_moderation_note",
          outcome: "retry_required",
        });
        return false;
      }

      if (user.moderationNote.includes(marker)) {
        if (action?.status === "started") {
          await this.assertActive();
          if (await this.journal.complete(actionKey) === false) throw leaseLostError();
        } else if (!action) {
          await this.assertActive();
          if (await this.journal.start(actionKey) === false) throw leaseLostError();
          if (await this.journal.complete(actionKey) === false) throw leaseLostError();
        }
        await this.audit("moderation-note.reconciled", safeCase, {
          actor: "deterministic",
          reason: "existing_automation_marker_found",
          outcome: "moderation_note_present",
        });
        return true;
      }

      if (action?.status === "started") {
        await this.audit("moderation-note.uncertain", safeCase, {
          actor: "deterministic",
          reason: "started_write_marker_not_found",
          outcome: "human_review_required",
        });
        return true;
      }

      const entry = createEntry(safeCase, eventTypes, marker, this.language);
      if (entry.length > MAX_ENTRY_LENGTH) {
        await this.audit("moderation-note.skipped", safeCase, {
          actor: "deterministic",
          reason: "entry_capacity_exceeded",
          outcome: "human_review_required",
        });
        return true;
      }
      const separator = user.moderationNote.length > 0 && !user.moderationNote.endsWith("\n") ? "\n" : "";
      const updatedNote = `${user.moderationNote}${separator}${entry}`;
      if (updatedNote.length > MAX_MODERATION_NOTE_LENGTH) {
        await this.audit("moderation-note.skipped", safeCase, {
          actor: "deterministic",
          reason: "note_capacity_exceeded",
          outcome: "human_review_required",
        });
        return true;
      }

      await this.moderator.updateUserNote(safeCase.userId, updatedNote, {
        signal: this.signal,
        beforeRequest: async () => {
          try {
            await this.assertMutationAllowed(safeCase);
            this.assertFreshUser(observedAt);
            if (await this.journal.start(actionKey) === false) throw leaseLostError();
            actionStarted = true;
            await this.assertMutationAllowed(safeCase);
            this.assertFreshUser(observedAt);
          } catch (error) {
            if (actionStarted && !isLeaseLost(error) && !isAbort(error)) {
              await this.resetAction(actionKey);
              actionStarted = false;
            }
            throw error;
          }
        },
      });
      await this.assertActive();
      if (await this.journal.complete(actionKey) === false) throw leaseLostError();
      actionStarted = false;
      await this.audit("moderation-note.updated", safeCase, {
        actor: "deterministic",
        reason: "case_outcome_appended",
        outcome: "moderation_note_appended",
      });
      return true;
    } catch (error) {
      if (isLeaseLost(error) || isAbort(error)) throw error;

      if (isHumanDecisionError(error)) {
        if (actionStarted) await this.resetAction(actionKey);
        await this.audit("moderation-note.skipped", safeCase, {
          actor: "human",
          reason: "human_decision_prevented_moderation_note_update",
          outcome: "automation_skipped",
        });
        return true;
      }

      if (actionStarted && DEFINITIVE_REJECTIONS.has(error?.status)) {
        await this.resetAction(actionKey);
        actionStarted = false;
      }
      await this.audit("moderation-note.failed", safeCase, {
        actor: "deterministic",
        reason: safeFailureReason(error),
        outcome: "retry_required",
      });
      this.logger?.error?.("Moderation note update failed", new Error(safeFailureReason(error)), { caseId: safeCase.caseId });
      return false;
    }
  }

  hasDurableJournal() {
    return Boolean(this.journal && ["get", "start", "complete", "reset"].every((method) => typeof this.journal[method] === "function"));
  }

  async assertMutationAllowed(moderationCase) {
    throwIfAborted(this.signal);
    await this.assertActive();
    if (await this.authority?.hasHumanDecision?.(moderationCase)) throw new HumanDecisionError();
  }

  assertFreshUser(observedAt) {
    if (this.clock() - observedAt > this.userStateMaxAgeMs) {
      throw Object.assign(new Error("Misskey user state expired."), { code: "USER_STATE_STALE", retryable: true });
    }
  }

  async resetAction(actionKey) {
    await this.assertActive();
    if (await this.journal.reset(actionKey) === false) throw leaseLostError();
  }

  async audit(type, moderationCase, details) {
    await this.record(type, {
      caseId: moderationCase.caseId,
      noteId: moderationCase.noteId,
      userId: moderationCase.userId,
      tier: moderationCase.tier,
      ruleIds: moderationCase.ruleIds,
    }, details);
  }
}

class HumanDecisionError extends Error {
  constructor() {
    super("A human decision prevents this automated mutation.");
    this.name = "HumanDecisionError";
  }
}

function createMarker(moderationCase, eventTypes) {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      caseId: moderationCase.caseId,
      userId: moderationCase.userId,
      tier: moderationCase.tier,
      eventTypes,
    }))
    .digest("hex")
    .slice(0, 32);
  return `<!-- automod-log:${digest} -->`;
}

function createEntry(moderationCase, eventTypes, marker, language) {
  const date = new Date().toISOString();
  const tierDescription = tierMeaning(moderationCase.tier, language);
  const reasons = moderationCase.reasons.length > 0
    ? moderationCase.reasons.map((reason) => sanitizeText(reason, MAX_REASON_LENGTH)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
    : [];
  const rules = moderationCase.ruleIds.length > 0
    ? moderationCase.ruleIds.map((ruleId) => sanitizeText(ruleId, 100)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
    : [];
  const result = summarizeEvents(eventTypes, language);
  const labels = language === "en" ? {
    title: "AutoMod moderation log",
    case: "Case",
    note: "note",
    rules: "Rules",
    reasons: "Reasons",
  } : {
    title: "AutoMod 判定ログ",
    case: "ケース",
    note: "投稿",
    rules: "ルール",
    reasons: "理由",
  };
  const lines = [
    `---\n[${labels.title}] ${date}`,
    `${moderationCase.tier} — ${tierDescription}`,
    `${labels.case}: ${moderationCase.caseId} / ${labels.note}: ${moderationCase.noteId}`,
  ];
  if (rules.length > 0) lines.push(`${labels.rules}: ${rules.join(", ")}`);
  if (reasons.length > 0) lines.push(`${labels.reasons}: ${reasons.join("; ")}`);
  lines.push(result, marker, "---");
  return lines.join("\n");
}

function tierMeaning(tier, language) {
  if (language === "en") {
    if (tier === "T1") return "Immediate severe action";
    if (tier === "T2") return "Restrictive role";
    return "Observe; no automatic restriction";
  }
  if (tier === "T1") return "重大な違反として即時対応";
  if (tier === "T2") return "制限ロールによる制限";
  return "観察（制限なし）";
}

function summarizeEvents(eventTypes, language) {
  const has = (type) => eventTypes.includes(type);
  const reviewQueued = has("llm-review.queued");
  const outcome = language === "en"
    ? summarizeEnglishOutcome(has)
    : summarizeJapaneseOutcome(has);
  const followUps = [];
  if (has("t1.purge.queued")) {
    followUps.push(language === "en"
      ? "Historical note deletion is queued and has not run."
      : "過去投稿の削除ジョブを登録しました（削除処理は未実行）。");
  } else if (has("t1.suspended") && has("t1.enforcement.failed")) {
    followUps.push(language === "en"
      ? "Historical note deletion follow-up could not be confirmed; the deletion worker is not connected."
      : "過去投稿削除の後続処理を確認できません（削除ワーカーは未接続）。");
  }
  if (reviewQueued) {
    followUps.push(language === "en"
      ? "LLM review is queued and has not run."
      : "LLMレビューを登録しました（レビューは未実行）。");
  }
  return [outcome, ...followUps].join(" ");
}

function summarizeEnglishOutcome(has) {
  if (has("automation.skipped.protected")) return "Automatic action skipped for a moderator or administrator account.";
  if (has("automation.skipped.human") || has("automation.skipped.human-state")) return "Automatic action skipped to preserve a human decision or existing moderation state.";
  if (has("automation.skipped.uncertain")) return "An external action is uncertain; human review is required.";
  if (has("t1.suspended")) return "Account suspended.";
  if (has("t1.enforcement.failed")) return "Account suspension failed; retry required.";
  if (has("t2.role.assigned")) return "Restrictive role assigned.";
  if (has("t2.role.failed")) return "Restrictive role assignment failed; retry required.";
  if (has("t3.observed")) return "Observed with no automatic restriction.";
  return "Case recorded for moderator review; no restriction was applied.";
}

function summarizeJapaneseOutcome(has) {
  if (has("automation.skipped.protected")) return "管理者・モデレーターのため自動処理をスキップしました。";
  if (has("automation.skipped.human") || has("automation.skipped.human-state")) return "人間の判断または既存の管理状態を優先し、自動処理をスキップしました。";
  if (has("automation.skipped.uncertain")) return "外部処理の結果を確認できません。管理者の確認が必要です。";
  if (has("t1.suspended")) return "アカウントを凍結しました。";
  if (has("t1.enforcement.failed")) return "アカウント凍結に失敗しました。再試行が必要です。";
  if (has("t2.role.assigned")) return "制限ロールを付与しました。";
  if (has("t2.role.failed")) return "制限ロールの付与に失敗しました。再試行が必要です。";
  if (has("t3.observed")) return "観察対象として記録しました（制限なし）。";
  return "管理者による確認用に記録しました（制限なし）。";
}

function sanitizeCase(moderationCase) {
  if (!moderationCase || typeof moderationCase !== "object") return null;
  const caseId = sanitizeIdentifier(moderationCase.caseId);
  const noteId = sanitizeIdentifier(moderationCase.noteId);
  const userId = sanitizeIdentifier(moderationCase.userId);
  const tier = ["T1", "T2", "T3"].includes(moderationCase.tier) ? moderationCase.tier : null;
  if (!caseId || !noteId || !userId || !tier) return null;
  const ruleIds = Array.isArray(moderationCase.ruleIds)
    ? moderationCase.ruleIds.map((id) => sanitizeText(id, 64)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
    : [];
  const reasons = Array.isArray(moderationCase.reasons)
    ? moderationCase.reasons.map((reason) => sanitizeText(reason, MAX_REASON_LENGTH)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
    : [];
  return { caseId, noteId, userId, tier, ruleIds, reasons };
}

function sanitizeIdentifier(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  if (/[\s\u0000-\u001F\u007F-\u009F]/u.test(value) || BIDI_CONTROL_PATTERN.test(value)) return null;
  return value;
}

function sanitizeText(value, maximumLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(BEARER_TOKEN, "[redacted token]")
    .replace(EMAIL, "[redacted email]")
    .replace(IPV4, "[redacted IP]")
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}

function isUserState(user) {
  return Boolean(
    user && typeof user === "object" && !Array.isArray(user) &&
    typeof user.isModerator === "boolean" && Array.isArray(user.roles) &&
    (user.isAdministrator === undefined || typeof user.isAdministrator === "boolean"),
  );
}

function isProtectedAccount(user) {
  return Boolean(user.isModerator || user.isAdministrator || user.roles?.some((role) => role?.isModerator || role?.isAdministrator));
}

function isHumanDecisionError(error) {
  return error instanceof HumanDecisionError;
}

function isLeaseLost(error) {
  return error?.code === "LEASE_LOST" || error?.name === "LeaseLostError";
}

function leaseLostError() {
  const error = new Error("The moderation note journal lease was lost.");
  error.name = "LeaseLostError";
  error.code = "LEASE_LOST";
  return error;
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (isLeaseLost(reason)) throw reason;
  if (reason instanceof Error && isAbort(reason)) throw reason;
  const error = new Error("Moderation note update was aborted.");
  error.name = "AbortError";
  throw error;
}

function safeFailureReason(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    return `misskey_http_${error.status}`;
  }
  if (error?.code === "USER_STATE_STALE") return "user_state_expired";
  if (error?.name === "MisskeyTransportError") return "misskey_transport_error";
  if (error?.name === "MisskeyApiError") return "misskey_api_error";
  return "moderation_note_update_failed";
}
