import { classifyNote } from "./classification.js";
import { ModerationEnforcer } from "./enforcement.js";

const DEFAULT_DEDUPE_LIMIT = 10_000;

export class TieredModerationEngine {
  constructor({
    mode,
    moderator,
    ledger,
    reviewQueue,
    purgeQueue,
    authority,
    logger,
    selfUserId,
    t2RoleId,
    reviewDelayMs,
    journal,
    assertActive,
    signal,
    userStateMaxAgeMs,
  }) {
    this.mode = mode;
    this.moderator = moderator;
    this.ledger = ledger;
    this.reviewQueue = reviewQueue;
    this.purgeQueue = purgeQueue;
    this.authority = authority;
    this.logger = logger;
    this.selfUserId = selfUserId;
    this.t2RoleId = t2RoleId;
    this.reviewDelayMs = reviewDelayMs;
    this.processedNoteIds = new Map();
    this.enforcer = new ModerationEnforcer({
      record: (type, moderationCase, details) => this.record(type, moderationCase, details),
      moderator,
      purgeQueue,
      authority,
      logger,
      t2RoleId,
      journal,
      assertActive,
      signal,
      userStateMaxAgeMs,
    });
  }

  async process(note, rules) {
    const classification = classifyNote(note, rules, this.selfUserId);
    if (!classification) return true;
    return this.processCase({
        caseId: note.id,
        noteId: note.id,
        userId: note.userId ?? note.user?.id,
        tier: classification.tier,
        ruleIds: classification.ruleIds,
        reasons: classification.reasons,
      });
  }

  async processCase(moderationCase) {
    const { noteId, tier } = moderationCase;
    if (this.processedNoteIds.has(noteId) || await this.ledger.hasProcessed?.(noteId)) return true;
    this.remember(noteId);
    try {
      await this.record("case.classified", moderationCase, { actor: "deterministic", mode: this.mode });
      this.logger.warn("Note classified by automod", { ...moderationCase, mode: this.mode });

      if (await this.authority.hasHumanDecision(moderationCase)) {
        await this.record("automation.skipped.human", moderationCase, { actor: "human" });
        await this.record("case.completed", moderationCase, { actor: "human" });
        return true;
      }

      if (tier === "T2" || tier === "T3") {
        await this.reviewQueue.enqueue({
          caseId: moderationCase.caseId,
          noteId: moderationCase.noteId,
          userId: moderationCase.userId,
          tier: moderationCase.tier,
          ruleIds: moderationCase.ruleIds,
          delayMs: this.reviewDelayMs,
          ...(moderationCase.reputation ? { reputation: moderationCase.reputation } : {}),
        });
        await this.record("llm-review.queued", moderationCase, { actor: "deterministic" });
      }

      if (this.mode === "dry-run" || tier === "T3") {
        await this.record("case.completed", moderationCase, { actor: "deterministic" });
        return true;
      }
      const succeeded =
        tier === "T1"
          ? await this.enforceT1(moderationCase)
          : await this.enforceT2(moderationCase);
      if (succeeded) {
        await this.record("case.completed", moderationCase, { actor: "deterministic" });
      } else {
        this.forget(noteId);
      }
      return succeeded;
    } catch (error) {
      this.forget(noteId);
      throw error;
    }
  }

  async enforceT1(moderationCase) {
    return this.enforcer.enforceT1(moderationCase);
  }

  async enforceT2(moderationCase) {
    return this.enforcer.enforceT2(moderationCase);
  }

  record(type, moderationCase, details) {
    return this.ledger.record({
      type,
      timestamp: new Date().toISOString(),
      ...moderationCase,
      ...details,
    });
  }

  remember(noteId) {
    this.processedNoteIds.set(noteId, true);
    if (this.processedNoteIds.size > DEFAULT_DEDUPE_LIMIT) {
      this.processedNoteIds.delete(this.processedNoteIds.keys().next().value);
    }
  }

  forget(noteId) {
    this.processedNoteIds.delete(noteId);
  }
}
