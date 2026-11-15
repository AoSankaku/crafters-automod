import { describe, expect, mock, test } from "#test";

import { ModerationNoteWriter } from "../src/moderation-note.js";

const moderationCase = {
  caseId: "case-1",
  noteId: "note-1",
  userId: "user-1",
  tier: "T2",
  ruleIds: ["policy-1"],
  reasons: ["繰り返しの勧誘"],
  text: "private post body must never enter moderation note audit metadata",
};

function createHarness({
  initialNote = "Moderator's existing decision: leave this line exactly as written.\n",
  userState = {},
  humanDecision = false,
  journalState = null,
  maxAgeMs = 5_000,
} = {}) {
  let remoteNote = initialNote;
  let now = 10_000;
  const storedJournal = new Map();
  let nextInitialJournalState = journalState;
  const selectedJournalKey = { value: "seed" };
  const writes = [];
  const records = [];
  const state = { ...userState };
  const authority = { hasHumanDecision: mock(async () => humanDecision) };
  const journal = {
    get: mock(async (key) => {
      selectedJournalKey.value = key;
      if (nextInitialJournalState) {
        storedJournal.set(key, nextInitialJournalState);
        nextInitialJournalState = null;
      }
      return storedJournal.get(key) ?? null;
    }),
    start: mock(async (key) => { selectedJournalKey.value = key; storedJournal.set(key, { status: "started" }); return true; }),
    complete: mock(async (key) => { selectedJournalKey.value = key; storedJournal.set(key, { status: "completed" }); return true; }),
    reset: mock(async (key) => { selectedJournalKey.value = key; storedJournal.delete(key); return true; }),
    getState: () => storedJournal.get(selectedJournalKey.value) ?? null,
  };
  const moderator = {
    showUser: mock(async (_userId, { beforeRequest } = {}) => {
      await beforeRequest?.();
      return {
        moderationNote: remoteNote,
        isModerator: false,
        isAdministrator: false,
        roles: [],
        roleAssigns: [],
        ...state,
      };
    }),
    updateUserNote: mock(async (_userId, text, { beforeRequest } = {}) => {
      await beforeRequest?.();
      writes.push(text);
      remoteNote = text;
    }),
  };
  const writer = new ModerationNoteWriter({
    moderator,
    authority,
    journal,
    record: mock(async (type, currentCase, details) => records.push({ type, ...currentCase, ...details })),
    logger: { info() {}, warn() {}, error() {} },
    clock: () => now,
    userStateMaxAgeMs: maxAgeMs,
  });
  return {
    writer,
    moderator,
    authority,
    journal,
    records,
    writes,
    state,
    get remoteNote() { return remoteNote; },
    set remoteNote(value) { remoteNote = value; },
    advanceClock(ms) { now += ms; },
  };
}

describe("ModerationNoteWriter", () => {
  test("keeps moderator text verbatim and appends a readable T2 outcome", async () => {
    const h = createHarness();
    const original = h.remoteNote;

    expect(await h.writer.write(moderationCase, [
      { type: "t2.role.assigned", outcome: "restrictive_role_assigned" },
      { type: "llm-review.queued", outcome: "queued" },
    ])).toBe(true);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].startsWith(original)).toBe(true);
    expect(h.writes[0]).toMatch(/T2/u);
    expect(h.writes[0]).toMatch(/case-1/u);
    expect(h.writes[0]).toMatch(/note-1/u);
    expect(h.writes[0]).toMatch(/policy-1/u);
    expect(h.writes[0]).toMatch(/繰り返しの勧誘/u);
    expect(h.writes[0]).toMatch(/role|ロール/u);
    expect(h.writes[0]).toMatch(/review|レビュー/u);
    expect(h.writes[0]).not.toContain("private post body");
    expect(h.journal.getState()).toEqual({ status: "completed" });
  });

  test("writes readable Japanese and English tier outcomes without claiming queued work ran", async () => {
    const t1 = createHarness({ initialNote: "" });
    await t1.writer.write({ ...moderationCase, tier: "T1", reasons: ["明白な悪質スパム"] }, [
      { type: "t1.suspended", outcome: "account_suspended" },
      { type: "t1.purge.queued", outcome: "historical_purge_job_queued" },
    ]);
    expect(t1.writes[0]).toMatch(/凍結/u);
    expect(t1.writes[0]).toMatch(/削除.*(待機|未実行|キュー)|キュー.*削除/u);
    expect(t1.writes[0]).not.toMatch(/削除.*完了/u);

    const purgeRetry = createHarness({ initialNote: "" });
    await purgeRetry.writer.write({ ...moderationCase, tier: "T1" }, [
      { type: "t1.suspended", outcome: "account_suspended" },
      { type: "t1.enforcement.failed", outcome: "retry_required" },
    ]);
    expect(purgeRetry.writes[0]).toMatch(/凍結しました/u);
    expect(purgeRetry.writes[0]).toMatch(/削除.*確認できません/u);
    expect(purgeRetry.writes[0]).not.toMatch(/削除ジョブ登録に失敗/u);
    expect(purgeRetry.writes[0]).not.toMatch(/凍結に失敗/u);

    const t3 = createHarness({ initialNote: "" });
    const createEnglishWriter = (harness) => new ModerationNoteWriter({
      moderator: harness.moderator,
      authority: harness.authority,
      journal: harness.journal,
      record: mock(async (...args) => harness.records.push(args)),
      logger: { info() {}, warn() {}, error() {} },
      language: "en",
      clock: () => 10_000,
    });
    const englishWriter = createEnglishWriter(t3);
    await englishWriter.write({ ...moderationCase, tier: "T3" }, [
      { type: "llm-review.queued", outcome: "queued" },
    ]);
    expect(t3.writes[0]).toMatch(/observe|observation/iu);
    expect(t3.writes[0]).toMatch(/review is queued/i);
    expect(t3.writes[0]).not.toMatch(/reviewed|completed/i);

    const englishT2 = createHarness({ initialNote: "" });
    await createEnglishWriter(englishT2).write(moderationCase, [
      { type: "t2.role.assigned" },
      { type: "llm-review.queued" },
    ]);
    expect(englishT2.writes[0]).toMatch(/^---[\s\S]*T2 — Restrictive role[\s\S]*Restrictive role assigned/u);
    expect(englishT2.writes[0]).toMatch(/LLM review is queued/u);

    const japaneseT3 = createHarness({ initialNote: "" });
    await japaneseT3.writer.write({ ...moderationCase, tier: "T3" }, [
      { type: "llm-review.queued", outcome: "queued" },
    ]);
    expect(japaneseT3.writes[0]).toMatch(/制限なし/u);
  });

  test("deduplicates a repeated event and never restores an entry removed after completion", async () => {
    const h = createHarness();
    const events = [{ type: "t2.role.assigned", outcome: "restrictive_role_assigned" }];
    await h.writer.write(moderationCase, events);
    expect(h.writes).toHaveLength(1);

    h.remoteNote = "Moderator removed an old automation entry.\n";
    expect(await h.writer.write(moderationCase, events)).toBe(true);

    expect(h.writes).toHaveLength(1);
    expect(h.remoteNote).toBe("Moderator removed an old automation entry.\n");
    expect(h.journal.complete).toHaveBeenCalledTimes(1);
  });

  test("allows a changed failure-to-success outcome to have its own audit marker", async () => {
    const h = createHarness({ initialNote: "" });
    await h.writer.write(moderationCase, [{ type: "t2.role.failed", outcome: "retry_required" }]);
    await h.writer.write(moderationCase, [{ type: "t2.role.assigned", outcome: "restrictive_role_assigned" }]);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]).toMatch(/failed|失敗/i);
    expect(h.writes[1]).toMatch(/role|ロール/i);
  });

  test("reconciles an uncertain write when its stable marker is already in Misskey", async () => {
    const h = createHarness({ initialNote: "" });
    const update = h.moderator.updateUserNote;
    h.moderator.updateUserNote = mock(async (userId, text, options) => {
      await options?.beforeRequest?.();
      h.writes.push(text);
      h.remoteNote = text;
      throw new Error("simulated response loss");
    });
    const events = [{ type: "t2.role.assigned", outcome: "restrictive_role_assigned" }];

    expect(await h.writer.write(moderationCase, events)).toBe(false);
    expect(h.journal.getState()).toEqual({ status: "started" });
    h.moderator.updateUserNote = update;
    expect(await h.writer.write(moderationCase, events)).toBe(true);

    expect(h.writes).toHaveLength(1);
    expect(h.journal.getState()).toEqual({ status: "completed" });
    expect(h.records.some((record) => record.outcome === "human_review_required")).toBe(false);
  });

  test("does not repeat a started write when the marker cannot be found", async () => {
    const h = createHarness({ initialNote: "human note", journalState: { status: "started" } });

    expect(await h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(true);

    expect(h.writes).toHaveLength(0);
    expect(h.journal.complete).not.toHaveBeenCalled();
    expect(h.records.some((record) => record.outcome === "human_review_required")).toBe(true);
  });

  test("does not write after a human decision arrives while waiting for the API slot", async () => {
    const h = createHarness({ initialNote: "human note" });
    h.moderator.updateUserNote = mock(async (_userId, _text, { beforeRequest } = {}) => {
      h.authority.hasHumanDecision.mockResolvedValueOnce(true);
      await beforeRequest?.();
      h.writes.push(_text);
    });

    expect(await h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(true);

    expect(h.writes).toHaveLength(0);
    expect(h.journal.reset).not.toHaveBeenCalled();
    expect(h.journal.getState()).toBeNull();
    expect(h.records.some((record) => record.actor === "human")).toBe(true);
  });

  test("rejects an expired account snapshot before a delayed note update", async () => {
    const h = createHarness({ initialNote: "human note", maxAgeMs: 5 });
    h.moderator.updateUserNote = mock(async (_userId, _text, { beforeRequest } = {}) => {
      h.advanceClock(6);
      await beforeRequest?.();
      h.writes.push(_text);
    });

    expect(await h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);

    expect(h.writes).toHaveLength(0);
    expect(h.journal.reset).not.toHaveBeenCalled();
    expect(h.journal.getState()).toBeNull();
  });

  test("rejects a slow user lookup using the time immediately before its request", async () => {
    const h = createHarness({ initialNote: "human note", maxAgeMs: 5_000 });
    h.moderator.showUser = mock(async (_userId, { beforeRequest } = {}) => {
      await beforeRequest?.();
      h.advanceClock(6_000);
      return { moderationNote: h.remoteNote, isModerator: false, isAdministrator: false, roles: [] };
    });

    expect(await h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);

    expect(h.writes).toHaveLength(0);
    expect(h.journal.start).not.toHaveBeenCalled();
  });

  test("resets only its own started marker if the user snapshot expires during journal preparation", async () => {
    const h = createHarness({ initialNote: "human note", maxAgeMs: 5 });
    const start = h.journal.start;
    h.journal.start = mock(async (key) => {
      h.advanceClock(6);
      return start(key);
    });

    expect(await h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);

    expect(h.writes).toHaveLength(0);
    expect(h.journal.start).toHaveBeenCalledTimes(1);
    expect(h.journal.reset).toHaveBeenCalledTimes(1);
    expect(h.journal.getState()).toBeNull();
  });

  test("skips a protected administrator and fails closed for an invalid moderationNote", async () => {
    const admin = createHarness({ userState: { isAdministrator: true } });
    expect(await admin.writer.write(moderationCase, [{ type: "t1.suspended" }])).toBe(true);
    expect(admin.writes).toHaveLength(0);
    expect(admin.records.some((record) => record.outcome === "automation_skipped")).toBe(true);

    const invalid = createHarness({ userState: { moderationNote: null } });
    expect(await invalid.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);
    expect(invalid.writes).toHaveLength(0);

    const invalidFlags = createHarness({ userState: { isModerator: "false", roles: "not-an-array" } });
    expect(await invalidFlags.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);
    expect(invalidFlags.writes).toHaveLength(0);
  });

  test("rejects identifiers containing bidi controls without retargeting the Misskey request", async () => {
    const h = createHarness();

    expect(await h.writer.write({ ...moderationCase, userId: "user-1\u202E" }, [{ type: "t2.role.assigned" }])).toBe(true);

    expect(h.moderator.showUser).not.toHaveBeenCalled();
    expect(h.moderator.updateUserNote).not.toHaveBeenCalled();
  });

  test("does not discard or truncate moderator text when the note has no capacity", async () => {
    const original = "x".repeat(60_000);
    const h = createHarness({ initialNote: original });

    expect(await h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(true);

    expect(h.writes).toHaveLength(0);
    expect(h.remoteNote).toBe(original);
    expect(h.records.some((record) => record.reason === "note_capacity_exceeded" && record.outcome === "human_review_required")).toBe(true);
  });

  test("bounds and sanitizes policy text and excludes note content from audit metadata", async () => {
    const secretish = "Bearer synthetic-secret-token";
    const h = createHarness({ initialNote: "private moderator note" });
    const noisyCase = {
      ...moderationCase,
      reasons: [`${"x".repeat(5_000)}\n${secretish}\u202E`],
      text: "private post body",
    };

    expect(await h.writer.write(noisyCase, [{ type: "t2.role.assigned" }])).toBe(true);

    const appended = h.writes[0].slice("private moderator note".length);
    expect(appended.length).toBeLessThanOrEqual(4_096);
    expect(appended).not.toContain("\u202E");
    expect(JSON.stringify(h.records)).not.toContain("private moderator note");
    expect(JSON.stringify(h.records)).not.toContain("private post body");
    expect(JSON.stringify(h.records)).not.toContain(secretish);
  });

  test("keeps the stable marker and footer after many bounded policy labels", async () => {
    const h = createHarness({ initialNote: "" });
    const crowdedCase = {
      ...moderationCase,
      ruleIds: Array.from({ length: 8 }, (_, index) => `rule-${index}-${"r".repeat(50)}`),
      reasons: Array.from({ length: 8 }, (_, index) => `Policy ${index} ${"理由".repeat(80)}`),
    };

    expect(await h.writer.write(crowdedCase, [{ type: "t2.role.assigned" }])).toBe(true);

    expect(h.writes[0].length).toBeLessThanOrEqual(4_096);
    expect(h.writes[0]).toMatch(/<!-- automod-log:[a-f0-9]{32} -->\n---$/u);
  });

  test("leaves a failed started action for reconciliation, but resets a definitive 429", async () => {
    const uncertain = createHarness({ initialNote: "" });
    uncertain.moderator.updateUserNote.mockImplementation(async (_userId, _text, { beforeRequest } = {}) => {
      await beforeRequest?.();
      throw new Error("private moderator note must not be copied into an error record");
    });
    expect(await uncertain.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);
    expect(uncertain.journal.getState()).toEqual({ status: "started" });
    expect(JSON.stringify(uncertain.records)).not.toContain("private moderator note");

    const throttled = createHarness({ initialNote: "" });
    throttled.moderator.updateUserNote.mockImplementation(async (_userId, _text, { beforeRequest } = {}) => {
      await beforeRequest?.();
      throw Object.assign(new Error("rate limited"), { status: 429, retryable: true });
    });
    expect(await throttled.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);
    expect(throttled.journal.getState()).toBeNull();
  });

  test("requires a durable journal before any moderation note mutation", async () => {
    const h = createHarness({ initialNote: "human text" });
    const noJournalWriter = new ModerationNoteWriter({
      moderator: h.moderator,
      authority: h.authority,
      record: mock(async (type, currentCase, details) => h.records.push({ type, ...currentCase, ...details })),
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(await noJournalWriter.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(false);

    expect(h.writes).toHaveLength(0);
  });

  test("propagates lease loss and abort without resetting an in-flight journal", async () => {
    const h = createHarness({ initialNote: "human text" });
    const leaseError = Object.assign(new Error("lease expired"), { code: "LEASE_LOST", name: "LeaseLostError" });
    h.moderator.updateUserNote = mock(async (_userId, _text, { beforeRequest } = {}) => beforeRequest?.());
    h.moderator.showUser = mock(async (_userId, { beforeRequest } = {}) => {
      await beforeRequest?.();
      return { moderationNote: h.remoteNote, isModerator: false, isAdministrator: false, roles: [] };
    });
    let activeChecks = 0;
    const writer = new ModerationNoteWriter({
      moderator: h.moderator,
      authority: h.authority,
      journal: h.journal,
      assertActive: async () => { activeChecks += 1; if (activeChecks >= 5) throw leaseError; },
      record: mock(async () => {}),
      logger: { info() {}, warn() {}, error() {} },
      clock: () => 10_000,
    });
    await expect(writer.write(moderationCase, [{ type: "t2.role.assigned" }])).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(h.journal.reset).not.toHaveBeenCalled();

    const aborted = createHarness({ initialNote: "human text" });
    const controller = new AbortController();
    aborted.moderator.updateUserNote = mock(async (_userId, _text, { beforeRequest } = {}) => {
      await beforeRequest?.();
      controller.abort(Object.assign(new Error("private remote response"), { name: "AbortError" }));
      throw controller.signal.reason;
    });
    const abortWriter = new ModerationNoteWriter({
      moderator: aborted.moderator,
      authority: aborted.authority,
      journal: aborted.journal,
      signal: controller.signal,
      record: mock(async (type, currentCase, details) => aborted.records.push({ type, ...currentCase, ...details })),
      logger: { info() {}, warn() {}, error() {} },
      clock: () => 10_000,
    });
    await expect(abortWriter.write(moderationCase, [{ type: "t2.role.assigned" }])).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted.journal.getState()).toEqual({ status: "started" });
    expect(aborted.journal.reset).not.toHaveBeenCalled();
    expect(JSON.stringify(aborted.records)).not.toContain("private remote response");
  });

  test("does not send a note if the durable journal refuses to start", async () => {
    const h = createHarness({ initialNote: "human text" });
    h.journal.start.mockResolvedValueOnce(false);

    await expect(h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).rejects.toMatchObject({ code: "LEASE_LOST" });

    expect(h.writes).toHaveLength(0);
  });

  test("skips immediately when a human decision exists after the user lookup", async () => {
    const h = createHarness({ initialNote: "human text" });
    h.authority.hasHumanDecision.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await h.writer.write(moderationCase, [{ type: "t2.role.assigned" }])).toBe(true);

    expect(h.writes).toHaveLength(0);
    expect(h.journal.start).not.toHaveBeenCalled();
    expect(h.records.some((record) => record.actor === "human" && record.outcome === "automation_skipped")).toBe(true);
  });
});
