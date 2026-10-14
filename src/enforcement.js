export class ModerationEnforcer {
  constructor({ record, moderator, purgeQueue, authority, logger, t2RoleId }) {
    this.record = record;
    this.moderator = moderator;
    this.purgeQueue = purgeQueue;
    this.authority = authority;
    this.logger = logger;
    this.t2RoleId = t2RoleId;
  }

  async enforceT1(moderationCase) {
    try {
      const gate = await this.loadUserForAutomation(moderationCase);
      if (!gate.allowed) return true;

      if (!gate.user.isSuspended) await this.moderator.suspendUser(moderationCase.userId);
      await this.record("t1.suspended", moderationCase, { actor: "deterministic" });

      if (await this.authority.hasHumanDecision(moderationCase)) {
        await this.record("automation.skipped.human", moderationCase, { actor: "human" });
        return true;
      }

      await this.purgeQueue.enqueue({ caseId: moderationCase.caseId, userId: moderationCase.userId });
      await this.record("t1.purge.queued", moderationCase, { actor: "deterministic" });
      return true;
    } catch (error) {
      await this.record("t1.enforcement.failed", moderationCase, {
        actor: "deterministic",
        error: safeErrorMessage(error),
      });
      this.logger.error("T1 enforcement failed", error, { caseId: moderationCase.caseId });
      return false;
    }
  }

  async enforceT2(moderationCase) {
    try {
      const gate = await this.loadUserForAutomation(moderationCase);
      if (!gate.allowed) return true;

      if (!this.t2RoleId) {
        await this.record("t2.role.failed", moderationCase, {
          actor: "deterministic",
          error: "T2_ROLE_ID is not configured.",
        });
        return false;
      }
      if (gate.user.roleAssigns?.some((assignment) => assignment.roleId === this.t2RoleId)) return true;
      await this.moderator.assignRole(moderationCase.userId, this.t2RoleId);
      await this.record("t2.role.assigned", moderationCase, { actor: "deterministic" });
      return true;
    } catch (error) {
      await this.record("t2.role.failed", moderationCase, {
        actor: "deterministic",
        error: safeErrorMessage(error),
      });
      this.logger.error("T2 role assignment failed", error, { caseId: moderationCase.caseId });
      return false;
    }
  }

  async loadUserForAutomation(moderationCase) {
    const user = await this.moderator.showUser(moderationCase.userId);
    const hasProtectedRole = user.roles?.some((role) => role.isModerator || role.isAdministrator);
    if (user.isModerator || user.isAdministrator || hasProtectedRole) {
      await this.record("automation.skipped.protected", moderationCase, { actor: "deterministic" });
      return { allowed: false, user };
    }
    if (await this.authority.hasHumanDecision(moderationCase)) {
      await this.record("automation.skipped.human", moderationCase, { actor: "human" });
      return { allowed: false, user };
    }
    return { allowed: true, user };
  }
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}
