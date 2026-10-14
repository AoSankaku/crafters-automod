import { describe, expect, mock, test } from "bun:test";

import { HumanDecisionError, ModerationEnforcer } from "../src/enforcement.js";
import { MisskeyApiError } from "../src/misskey.js";

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

    expect(moderator.suspendUser.mock.calls[0][0]).toBe("user-1");
    expect(moderator.suspendUser.mock.calls[0][1]).toEqual(expect.objectContaining({
      beforeRequest: expect.any(Function),
    }));
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
    expect(record).toHaveBeenCalledWith(
      "automation.skipped.human",
      moderationCase,
      expect.objectContaining({ actor: "human" }),
    );
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
        expect.objectContaining({ actor: "deterministic" }),
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

    expect(record).toHaveBeenCalledWith("t1.enforcement.failed", moderationCase, expect.objectContaining({
      actor: "deterministic",
      error: "Misskey unavailable",
    }));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("ModerationEnforcer mutation safety and restart journal", () => {
  test("rechecks human authority after the API wait and skips the mutation", async () => {
    let humanDecision = false;
    const harness = createSafeHarness({ hasHumanDecision: () => humanDecision });
    harness.moderator.suspendUser.mockImplementation(async (_userId, options) => {
      // This represents the wait for a shared API slot. The decision arrives during that wait.
      humanDecision = true;
      await options.beforeRequest();
      harness.events.push("suspend");
    });

    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(true);

    expect(harness.authority.hasHumanDecision).toHaveBeenCalledTimes(2);
    expect(harness.events).not.toContain("suspend");
    expect(harness.purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(harness.record).toHaveBeenCalledWith(
      "automation.skipped.human",
      harness.moderationCase,
      expect.objectContaining({ actor: "human" }),
    );
  });

  test("rethrows a lost lease that occurs after waiting instead of returning retry success", async () => {
    const lostLease = Object.assign(new Error("lease expired"), { code: "LEASE_LOST" });
    const harness = createSafeHarness({ assertActive: mock(async () => { throw lostLease; }) });
    harness.moderator.suspendUser.mockImplementation(async (_userId, options) => {
      await options.beforeRequest();
      harness.events.push("suspend");
    });

    await expect(harness.enforcer.enforceT1(harness.moderationCase)).rejects.toBe(lostLease);
    expect(harness.events).not.toContain("suspend");
    expect(harness.purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(harness.record.mock.calls.some(([type]) => type === "t1.enforcement.failed")).toBe(false);
  });

  test("does not repeat suspension when purge retry follows a completed mutation", async () => {
    const harness = createSafeHarness();
    harness.moderator.suspendUser.mockImplementation(async (_userId, options) => {
      await options.beforeRequest();
      harness.state.user.isSuspended = true;
      harness.events.push("suspend");
    });
    harness.purgeQueue.enqueue
      .mockRejectedValueOnce(new Error("purge queue unavailable"))
      .mockResolvedValueOnce(undefined);

    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(false);
    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(true);

    expect(harness.moderator.suspendUser).toHaveBeenCalledTimes(1);
    expect(harness.purgeQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(harness.journal.get).toHaveBeenCalledWith("suspend");
  });

  test("holds an ambiguous started mutation for human review after restart", async () => {
    const journal = createJournal({ suspend: { status: "started" } });
    const harness = createSafeHarness({ journal });

    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(true);

    expect(harness.moderator.suspendUser).not.toHaveBeenCalled();
    expect(harness.purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(harness.record).toHaveBeenCalledWith(
      "automation.skipped.uncertain",
      harness.moderationCase,
      expect.objectContaining({ actor: "deterministic", outcome: "human_review_required" }),
    );
  });

  test("skips an automation-owned completed state that is no longer present", async () => {
    const journal = createJournal({ suspend: { status: "completed" } });
    const harness = createSafeHarness({ journal, user: { isSuspended: false } });

    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(true);

    expect(harness.moderator.suspendUser).not.toHaveBeenCalled();
    expect(harness.purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(harness.record).toHaveBeenCalledWith(
      "automation.skipped.human-state",
      harness.moderationCase,
      expect.objectContaining({ actor: "deterministic", outcome: "automation_skipped" }),
    );
  });

  test("does not purge a preexisting suspension without a same-case completion journal", async () => {
    const harness = createSafeHarness({ user: { isSuspended: true } });

    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(true);

    expect(harness.moderator.suspendUser).not.toHaveBeenCalled();
    expect(harness.purgeQueue.enqueue).not.toHaveBeenCalled();
  });

  test("resets a started journal after a definitive 429 rejection", async () => {
    const harness = createSafeHarness();
    harness.moderator.suspendUser.mockImplementation(async (_userId, options) => {
      await options.beforeRequest();
      throw new MisskeyApiError("admin/suspend-user", 429, "RATE_LIMIT");
    });

    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(false);

    expect(harness.journal.start).toHaveBeenCalledWith("suspend");
    expect(harness.journal.reset).toHaveBeenCalledWith("suspend");
    expect(harness.journal.complete).not.toHaveBeenCalled();
  });

  test("journals a T2 role assignment and uses the claim signal for reads and mutations", async () => {
    const signal = new AbortController().signal;
    const harness = createSafeHarness({ signal });
    harness.moderator.assignRole.mockImplementation(async (_userId, roleId, options) => {
      await options.beforeRequest();
      harness.state.user.roleAssigns.push({ roleId });
      harness.events.push("assign-role");
    });

    expect(await harness.enforcer.enforceT2(harness.moderationCase)).toBe(true);
    expect(await harness.enforcer.enforceT2(harness.moderationCase)).toBe(true);

    expect(harness.moderator.showUser.mock.calls[0][1]).toEqual(expect.objectContaining({
      signal,
      beforeRequest: expect.any(Function),
    }));
    expect(harness.moderator.assignRole.mock.calls[0][2]).toEqual(expect.objectContaining({
      signal,
      beforeRequest: expect.any(Function),
    }));
    expect(harness.journal.start).toHaveBeenCalledWith("assign-role:restricted-role");
    expect(harness.journal.complete).toHaveBeenCalledWith("assign-role:restricted-role");
    expect(harness.moderator.assignRole).toHaveBeenCalledTimes(1);
  });

  test("requires the completion journal before queuing T1 purge", async () => {
    const harness = createSafeHarness({ user: { isSuspended: true } });
    harness.journal = createJournal({ suspend: { status: "completed" } });
    harness.enforcer.journal = harness.journal;
    harness.authority.hasHumanDecision.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await harness.enforcer.enforceT1(harness.moderationCase)).toBe(true);

    expect(harness.purgeQueue.enqueue).not.toHaveBeenCalled();
    expect(harness.record).toHaveBeenCalledWith(
      "automation.skipped.human",
      harness.moderationCase,
      expect.objectContaining({ actor: "human" }),
    );
  });
});

function createSafeHarness({
  journal = createJournal(),
  assertActive = async () => undefined,
  hasHumanDecision = () => false,
  signal,
  user = {},
} = {}) {
  const state = {
    user: {
      isModerator: false,
      isAdministrator: false,
      isSuspended: false,
      roleAssigns: [],
      ...user,
    },
  };
  const events = [];
  const moderator = {
    showUser: mock(async () => ({ ...state.user })),
    suspendUser: mock(async (_userId, options) => {
      await options?.beforeRequest?.();
      state.user.isSuspended = true;
      events.push("suspend");
    }),
    assignRole: mock(async (_userId, _roleId, options) => {
      await options?.beforeRequest?.();
      events.push("assign-role");
    }),
  };
  const purgeQueue = { enqueue: mock(async () => events.push("purge-enqueue")) };
  const authority = { hasHumanDecision: mock(async () => hasHumanDecision()) };
  const record = mock(async (type) => events.push(type));
  const logger = { error: mock(() => undefined) };
  const enforcer = new ModerationEnforcer({
    record,
    moderator,
    purgeQueue,
    authority,
    logger,
    t2RoleId: "restricted-role",
    journal,
    assertActive,
    signal,
  });
  const moderationCase = {
    caseId: "case-1",
    noteId: "note-1",
    userId: "user-1",
    ruleIds: ["rule-1"],
  };

  return { authority, enforcer, events, journal, logger, moderationCase, moderator, purgeQueue, record, state };
}

function createJournal(initial = {}) {
  const state = new Map(Object.entries(initial));
  return {
    get: mock(async (key) => state.get(key) ?? null),
    start: mock(async (key) => state.set(key, { status: "started" })),
    complete: mock(async (key) => state.set(key, { status: "completed" })),
    reset: mock(async (key) => state.delete(key)),
  };
}
