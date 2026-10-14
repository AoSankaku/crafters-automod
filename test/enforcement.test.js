import { describe, expect, mock, test } from "bun:test";

import { ModerationEnforcer } from "../src/enforcement.js";

function createHarness({
  humanDecision = false,
  user = { isModerator: false, isAdministrator: false, isSuspended: false, roleAssigns: [] },
  t2RoleId = "restricted-role",
} = {}) {
  const events = [];
  const moderator = {
    showUser: mock(async () => user),
    suspendUser: mock(async () => events.push("suspend")),
    assignRole: mock(async () => events.push("assign-role")),
  };
  const purgeQueue = { enqueue: mock(async () => events.push("purge-enqueue")) };
  const authority = { hasHumanDecision: mock(async () => humanDecision) };
  const record = mock(async (type) => events.push(type));
  const logger = { error: mock(() => undefined) };
  const enforcer = new ModerationEnforcer({
    record,
    moderator,
    purgeQueue,
    authority,
    logger,
    t2RoleId,
  });
  const moderationCase = {
    caseId: "case-1",
    noteId: "note-1",
    userId: "user-1",
    ruleIds: ["rule-1"],
  };

  return { authority, enforcer, events, logger, moderationCase, moderator, purgeQueue, record };
}

describe("ModerationEnforcer", () => {
  test("suspends and audits before enqueueing the historical purge", async () => {
    const { enforcer, events, moderationCase, moderator, purgeQueue } = createHarness();

    expect(await enforcer.enforceT1(moderationCase)).toBe(true);

    expect(moderator.suspendUser).toHaveBeenCalledWith("user-1");
    expect(purgeQueue.enqueue).toHaveBeenCalledWith({ caseId: "case-1", userId: "user-1" });
    expect(events.indexOf("suspend")).toBeLessThan(events.indexOf("t1.suspended"));
    expect(events.indexOf("t1.suspended")).toBeLessThan(events.indexOf("purge-enqueue"));
  });

  test("checks for a human decision after loading the user and before mutation", async () => {
    const { authority, enforcer, moderationCase, moderator, purgeQueue } = createHarness();
    moderator.showUser.mockImplementationOnce(async () => {
      authority.hasHumanDecision.mockResolvedValue(true);
      return { isModerator: false, isAdministrator: false, isSuspended: false, roleAssigns: [] };
    });

    expect(await enforcer.enforceT1(moderationCase)).toBe(true);

    expect(moderator.showUser).toHaveBeenCalledTimes(1);
    expect(authority.hasHumanDecision).toHaveBeenCalledTimes(1);
    expect(moderator.suspendUser).not.toHaveBeenCalled();
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
  });

  test("stops the purge if a human decision appears after suspension", async () => {
    const { authority, enforcer, events, moderationCase, moderator, purgeQueue, record } = createHarness();
    authority.hasHumanDecision.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await enforcer.enforceT1(moderationCase)).toBe(true);

    expect(moderator.suspendUser).toHaveBeenCalledTimes(1);
    expect(purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith("automation.skipped.human", moderationCase, { actor: "human" });
    expect(events).not.toContain("purge-enqueue");
  });

  test("protects administrator accounts from both T1 and T2 enforcement", async () => {
    const protectedAccounts = [
      { harness: createHarness({ user: { isAdministrator: true } }), tier: "T1" },
      { harness: createHarness({ user: { roles: [{ isAdministrator: true }] } }), tier: "T2" },
      { harness: createHarness({ user: { roles: [{ isModerator: true }] } }), tier: "T1" },
    ];

    for (const { harness, tier } of protectedAccounts) {
      expect(await harness.enforcer[`enforce${tier}`](harness.moderationCase)).toBe(true);
      expect(harness.moderator.suspendUser).not.toHaveBeenCalled();
      expect(harness.moderator.assignRole).not.toHaveBeenCalled();
      expect(harness.purgeQueue.enqueue).not.toHaveBeenCalled();
      expect(harness.record).toHaveBeenCalledWith(
        "automation.skipped.protected",
        harness.moderationCase,
        { actor: "deterministic" },
      );
    }

  });

  test("retains the existing behavior for suspended users and already assigned roles", async () => {
    const t1 = createHarness({ user: { isSuspended: true } });
    const t2 = createHarness({ user: { roleAssigns: [{ roleId: "restricted-role" }] } });

    expect(await t1.enforcer.enforceT1(t1.moderationCase)).toBe(true);
    expect(await t2.enforcer.enforceT2(t2.moderationCase)).toBe(true);

    expect(t1.moderator.suspendUser).not.toHaveBeenCalled();
    expect(t1.purgeQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(t2.moderator.assignRole).not.toHaveBeenCalled();
  });

  test("returns false and records a failure when a Misskey action fails", async () => {
    const { enforcer, logger, moderationCase, moderator, record } = createHarness();
    moderator.suspendUser.mockRejectedValueOnce(new Error("Misskey unavailable"));

    expect(await enforcer.enforceT1(moderationCase)).toBe(false);

    expect(record).toHaveBeenCalledWith("t1.enforcement.failed", moderationCase, {
      actor: "deterministic",
      error: "Misskey unavailable",
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
