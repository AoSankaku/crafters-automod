import { describe, expect, mock, test } from "bun:test";

import { TieredModerationEngine } from "../src/moderation.js";

const note = {
  id: "note-1",
  text: "obvious spam",
  userId: "user-1",
  user: { id: "user-1", username: "spammer", host: null },
};

function rule(tier) {
  return {
    id: `${tier.toLowerCase()}-rule`,
    enabled: true,
    tier,
    field: "text",
    matchers: [{ type: "contains", value: "spam" }],
    excludedUsers: [],
    reason: `${tier} reason`,
  };
}

function createHarness({ mode = "enforce", humanDecision = false, userState = {} } = {}) {
  const moderator = {
    showUser: mock(async () => ({
      isModerator: false,
      isSuspended: false,
      roleAssigns: [],
      ...userState,
    })),
    suspendUser: mock(async () => undefined),
    assignRole: mock(async () => undefined),
  };
  const ledger = { record: mock(async () => undefined) };
  const reviewQueue = { enqueue: mock(async () => undefined) };
  const purgeQueue = { enqueue: mock(async () => undefined) };
  const authority = { hasHumanDecision: mock(async () => humanDecision) };
  const logger = { info() {}, warn() {}, error() {} };
  const engine = new TieredModerationEngine({
    mode,
    moderator,
    ledger,
    reviewQueue,
    purgeQueue,
    authority,
    logger,
    selfUserId: "automod-user",
    t2RoleId: "restricted-role",
    reviewDelayMs: 60_000,
    // These tests isolate classification/enforcement; note delivery has dedicated integration coverage.
    moderationNoteEnabled: false,
  });

  return { authority, engine, ledger, moderator, purgeQueue, reviewQueue };
}

describe("TieredModerationEngine", () => {
  test("T1 suspends first and enqueues a bounded historical purge", async () => {
    const { engine, moderator, purgeQueue, reviewQueue } = createHarness();
    await engine.process(note, [rule("T1")]);
    expect(moderator.suspendUser).toHaveBeenCalledWith("user-1", expect.objectContaining({ beforeRequest: expect.any(Function) }));
    expect(purgeQueue.enqueue).toHaveBeenCalledWith({ caseId: "note-1", userId: "user-1" });
    expect(reviewQueue.enqueue).not.toHaveBeenCalled();
  });

  test("T2 assigns the restrictive role and schedules delayed LLM review", async () => {
    const { engine, moderator, purgeQueue, reviewQueue } = createHarness();
    await engine.process(note, [rule("T2")]);
    expect(moderator.assignRole).toHaveBeenCalledWith("user-1", "restricted-role", expect.objectContaining({ beforeRequest: expect.any(Function) }));
    expect(moderator.suspendUser).not.toHaveBeenCalled();
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(reviewQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "note-1", tier: "T2", delayMs: 60_000 }),
    );
  });

  test("T3 records and schedules review without changing Misskey", async () => {
    const { engine, moderator, purgeQueue, reviewQueue } = createHarness();
    await engine.process(note, [rule("T3")]);
    expect(moderator.showUser).not.toHaveBeenCalled();
    expect(moderator.assignRole).not.toHaveBeenCalled();
    expect(moderator.suspendUser).not.toHaveBeenCalled();
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(reviewQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  test("a human decision suppresses deterministic actions and LLM review", async () => {
    const { engine, ledger, moderator, purgeQueue, reviewQueue } = createHarness({ humanDecision: true });
    await engine.process(note, [rule("T1")]);
    expect(moderator.showUser).not.toHaveBeenCalled();
    expect(moderator.suspendUser).not.toHaveBeenCalled();
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(reviewQueue.enqueue).not.toHaveBeenCalled();
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ type: "automation.skipped.human" }));
  });

  test("never suspends a moderator account", async () => {
    const { engine, moderator, purgeQueue } = createHarness({ userState: { isModerator: true } });
    await engine.process(note, [rule("T1")]);
    expect(moderator.suspendUser).not.toHaveBeenCalled();
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
  });

  test("dry-run records intended work without Misskey mutations", async () => {
    const { engine, moderator, purgeQueue } = createHarness({ mode: "dry-run" });
    await engine.process(note, [rule("T1")]);
    expect(moderator.showUser).not.toHaveBeenCalled();
    expect(moderator.suspendUser).not.toHaveBeenCalled();
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
  });

  test("does not mark a failed T1 action complete and permits a safe retry", async () => {
    const { engine, ledger, moderator } = createHarness();
    moderator.suspendUser
      .mockImplementationOnce(async () => {
        throw new Error("temporary Misskey failure");
      })
      .mockImplementationOnce(async () => undefined);

    await engine.process(note, [rule("T1")]);
    await engine.process(note, [rule("T1")]);

    expect(moderator.suspendUser).toHaveBeenCalledTimes(2);
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ type: "t1.enforcement.failed" }));
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ type: "case.completed" }));
  });

  test("skips a note already completed in the durable ledger", async () => {
    const { engine, ledger, moderator, purgeQueue, reviewQueue } = createHarness();
    ledger.hasProcessed = mock(() => true);

    await engine.process(note, [rule("T1")]);

    expect(ledger.record).not.toHaveBeenCalled();
    expect(moderator.showUser).not.toHaveBeenCalled();
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(reviewQueue.enqueue).not.toHaveBeenCalled();
  });

  test("supports asynchronous durable completion lookup", async () => {
    const { engine, ledger, reviewQueue } = createHarness();
    ledger.hasProcessed = mock(async () => false);
    await engine.process(note, [rule("T3")]);
    expect(reviewQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  test("processes a persisted classification without needing the original note", async () => {
    const { engine, ledger, moderator } = createHarness();
    const moderationCase = { caseId: note.id, noteId: note.id, userId: note.userId, tier: "T3", ruleIds: ["t3-rule"], reasons: ["T3 reason"] };
    expect(await engine.processCase(moderationCase)).toBe(true);
    expect(moderator.suspendUser).not.toHaveBeenCalled();
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ type: "case.completed", noteId: note.id }));
  });

  test("retries T2 after the delayed review queue fails", async () => {
    const { engine, ledger, moderator, reviewQueue } = createHarness();
    reviewQueue.enqueue.mockRejectedValueOnce(new Error("review queue unavailable"));

    await expect(engine.process(note, [rule("T2")])).rejects.toThrow("review queue unavailable");
    expect(moderator.showUser).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalledWith(expect.objectContaining({ type: "case.completed" }));

    await engine.process(note, [rule("T2")]);

    expect(moderator.assignRole).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ type: "case.completed" }));
  });

  test("retries T1 purge enqueue after failure without losing successful suspension", async () => {
    const { engine, ledger, moderator, purgeQueue } = createHarness();
    const user = { isModerator: false, isSuspended: false, roleAssigns: [] };
    moderator.showUser.mockImplementation(async () => user);
    moderator.suspendUser.mockImplementation(async () => {
      user.isSuspended = true;
    });
    purgeQueue.enqueue.mockRejectedValueOnce(new Error("purge queue unavailable"));

    await engine.process(note, [rule("T1")]);
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ type: "t1.enforcement.failed" }));
    expect(ledger.record).not.toHaveBeenCalledWith(expect.objectContaining({ type: "case.completed" }));

    await engine.process(note, [rule("T1")]);

    expect(moderator.suspendUser).toHaveBeenCalledTimes(1);
    expect(purgeQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ type: "case.completed" }));
  });
});
