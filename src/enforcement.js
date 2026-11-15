export class HumanDecisionError extends Error {
  constructor() {
    super("A human decision prevents this automated mutation.");
    this.name = "HumanDecisionError";
  }
}

export class ModerationEnforcer {
  constructor({
    record,
    moderator,
    purgeQueue,
    authority,
    logger,
    t2RoleId,
    assertActive = async () => {},
    journal,
    signal,
    clock = () => performance.now(),
    userStateMaxAgeMs = 5000,
  }) {
    this.record = record;
    this.moderator = moderator;
    this.purgeQueue = purgeQueue;
    this.authority = authority;
    this.logger = logger;
    this.t2RoleId = t2RoleId;
    this.assertActive = assertActive;
    this.journal = journal ?? null;
    this.signal = signal;
    this.clock = clock;
    this.userStateMaxAgeMs = userStateMaxAgeMs;
  }

  async enforceT1(moderationCase) {
    const actionKey = "suspend";
    let actionStarted = false;
    try {
      const gate = await this.loadUserForAutomation(moderationCase);
      if (!gate.allowed) return true;

      const action = await this.readAction(actionKey);
      if (action?.status === "started" || (action && action.status !== "completed")) {
        await this.recordUncertain(moderationCase, actionKey);
        return true;
      }
      if (action?.status === "completed") {
        if (!gate.user.isSuspended) {
          await this.recordHumanStateSkip(moderationCase, "completed_suspension_not_observed");
          return true;
        }
        await this.record("t1.suspended", moderationCase, {
          actor: "deterministic",
          reason: "completed_suspension_observed",
          outcome: "account_suspended",
        });
        return await this.enqueuePurge(moderationCase);
      }

      // With a journal, an existing suspension may belong to a human or another process.
      if (this.journal && gate.user.isSuspended) {
        await this.recordHumanStateSkip(moderationCase, "suspension_has_no_case_journal");
        return true;
      }

      if (!gate.user.isSuspended) {
        await this.moderator.suspendUser(moderationCase.userId, {
          signal: this.signal,
          beforeRequest: () => this.prepareMutation(moderationCase, gate, actionKey, (started) => { actionStarted = started; }),
        });
        if (this.journal) {
          await this.completeAction(actionKey);
          actionStarted = false;
        }
      }

      await this.record("t1.suspended", moderationCase, {
        actor: "deterministic",
        reason: "tier1_rule_matched",
        outcome: "account_suspended",
      });
      return await this.enqueuePurge(moderationCase);
    } catch (error) {
      if (error instanceof HumanDecisionError) {
        if (actionStarted) await this.resetAction(actionKey);
        await this.recordHumanDecisionSkip(moderationCase);
        return true;
      }
      if (isLeaseLost(error)) throw error;
      if (actionStarted && error?.status === 429) {
        await this.resetAction(actionKey);
        actionStarted = false;
      }
      await this.record("t1.enforcement.failed", moderationCase, {
        actor: "deterministic",
        reason: "automated_enforcement_failed",
        outcome: "retry_required",
        error: safeErrorMessage(error),
      });
      this.logger.error("T1 enforcement failed", error, { caseId: moderationCase.caseId });
      return false;
    }
  }

  async enforceT2(moderationCase) {
    const actionKey = this.t2RoleId ? `assign-role:${this.t2RoleId}` : null;
    let actionStarted = false;
    try {
      const gate = await this.loadUserForAutomation(moderationCase);
      if (!gate.allowed) return true;

      if (!this.t2RoleId) {
        await this.record("t2.role.failed", moderationCase, {
          actor: "deterministic",
          reason: "restrictive_role_not_configured",
          outcome: "retry_required",
          error: "T2_ROLE_ID is not configured.",
        });
        return false;
      }

      const alreadyAssigned = gate.user.roleAssigns?.some((assignment) => assignment.roleId === this.t2RoleId);
      const action = await this.readAction(actionKey);
      if (action?.status === "started" || (action && action.status !== "completed")) {
        await this.recordUncertain(moderationCase, actionKey);
        return true;
      }
      if (action?.status === "completed") {
        if (!alreadyAssigned) {
          await this.recordHumanStateSkip(moderationCase, "completed_role_assignment_not_observed");
        } else {
          await this.record("t2.role.assigned", moderationCase, {
            actor: "deterministic",
            reason: "completed_role_assignment_observed",
            outcome: "restrictive_role_assigned",
          });
        }
        return true;
      }
      if (this.journal && alreadyAssigned) {
        await this.recordHumanStateSkip(moderationCase, "role_assignment_has_no_case_journal");
        return true;
      }
      if (alreadyAssigned) return true;

      await this.moderator.assignRole(moderationCase.userId, this.t2RoleId, {
        signal: this.signal,
        beforeRequest: () => this.prepareMutation(moderationCase, gate, actionKey, (started) => { actionStarted = started; }),
      });
      if (this.journal) {
        await this.completeAction(actionKey);
        actionStarted = false;
      }
      await this.record("t2.role.assigned", moderationCase, {
        actor: "deterministic",
        reason: "tier2_rule_matched",
        outcome: "restrictive_role_assigned",
      });
      return true;
    } catch (error) {
      if (error instanceof HumanDecisionError) {
        if (actionStarted) await this.resetAction(actionKey);
        await this.recordHumanDecisionSkip(moderationCase);
        return true;
      }
      if (isLeaseLost(error)) throw error;
      if (actionStarted && error?.status === 429) {
        await this.resetAction(actionKey);
        actionStarted = false;
      }
      await this.record("t2.role.failed", moderationCase, {
        actor: "deterministic",
        reason: "automated_enforcement_failed",
        outcome: "retry_required",
        error: safeErrorMessage(error),
      });
      this.logger.error("T2 role assignment failed", error, { caseId: moderationCase.caseId });
      return false;
    }
  }

  async loadUserForAutomation(moderationCase) {
    const user = await this.moderator.showUser(moderationCase.userId, {
      signal: this.signal,
      beforeRequest: () => this.assertActive(),
    });
    const observedAt = this.clock();
    if (!user || typeof user !== "object") throw new Error("Misskey returned invalid user state.");
    const hasProtectedRole = user.roles?.some((role) => role.isModerator || role.isAdministrator);
    if (user.isModerator || user.isAdministrator || hasProtectedRole) {
      await this.record("automation.skipped.protected", moderationCase, {
        actor: "deterministic",
        reason: "moderator_or_administrator_account",
        outcome: "automation_skipped",
      });
      return { allowed: false, user };
    }
    if (await this.authority.hasHumanDecision(moderationCase)) {
      await this.recordHumanDecisionSkip(moderationCase);
      return { allowed: false, user };
    }
    return { allowed: true, user, observedAt };
  }

  async prepareMutation(moderationCase, gate, actionKey, onStarted) {
    let started = false;
    try {
      await this.assertMutationAllowed(moderationCase);
      this.assertFreshUser(gate);
      if (this.journal) {
        await this.startAction(actionKey);
        started = true;
        onStarted(true);
        await this.assertMutationAllowed(moderationCase);
        this.assertFreshUser(gate);
      }
    } catch (error) {
      // A rejected preflight has not called fetch. Clear only under a still-live lease.
      if (started && !isLeaseLost(error)) {
        await this.resetAction(actionKey);
        onStarted(false);
      }
      throw error;
    }
  }

  assertFreshUser(gate) {
    if (this.clock() - gate.observedAt > this.userStateMaxAgeMs) {
      throw Object.assign(new Error("Misskey user state expired while waiting; refresh before retrying."), {
        code: "USER_STATE_STALE", retryable: true,
      });
    }
  }

  async assertMutationAllowed(moderationCase) {
    await this.assertActive();
    if (await this.authority.hasHumanDecision(moderationCase)) throw new HumanDecisionError();
  }

  async enqueuePurge(moderationCase) {
    await this.assertActive();
    if (await this.authority.hasHumanDecision(moderationCase)) {
      await this.recordHumanDecisionSkip(moderationCase);
      return true;
    }
    await this.purgeQueue.enqueue({ caseId: moderationCase.caseId, userId: moderationCase.userId });
    await this.record("t1.purge.queued", moderationCase, {
      actor: "deterministic",
      reason: "tier1_policy",
      outcome: "historical_purge_job_queued",
    });
    return true;
  }

  async readAction(key) {
    if (!this.journal) return null;
    return this.journal.get(key);
  }

  async startAction(key) {
    if (await this.journal.start(key) === false) throw leaseLostError();
  }

  async completeAction(key) {
    if (await this.journal.complete(key) === false) throw leaseLostError();
  }

  async resetAction(key) {
    if (await this.journal.reset(key) === false) throw leaseLostError();
  }

  recordHumanDecisionSkip(moderationCase) {
    return this.record("automation.skipped.human", moderationCase, {
      actor: "human",
      reason: "human_decision_prevented_automation",
      outcome: "automation_skipped",
    });
  }

  recordHumanStateSkip(moderationCase, reason) {
    return this.record("automation.skipped.human-state", moderationCase, {
      actor: "deterministic",
      reason,
      outcome: "automation_skipped",
    });
  }

  recordUncertain(moderationCase, actionKey) {
    return this.record("automation.skipped.uncertain", moderationCase, {
      actor: "deterministic",
      reason: `uncertain_external_action:${actionKey}`,
      outcome: "human_review_required",
    });
  }
}

function leaseLostError() {
  const error = new Error("The enforcement lease was lost before the action could be journaled.");
  error.name = "LeaseLostError";
  error.code = "LEASE_LOST";
  return error;
}

function isLeaseLost(error) {
  return error?.code === "LEASE_LOST" || error?.name === "LeaseLostError";
}

function safeErrorMessage(error) {
  if (isLeaseLost(error)) return "The enforcement lease was lost.";
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}
