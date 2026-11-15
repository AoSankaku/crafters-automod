import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DurableIntake } from "./durable-intake.js";
import { DurableWorker } from "./durable-worker.js";
import { HealthState, startHealthServer } from "./health.js";
import { validateInboxEnvelope } from "./inbox-envelope.js";
import { importLegacyJsonl } from "./legacy-import.js";
import { Logger } from "./logger.js";
import { MisskeyApiClient } from "./misskey.js";
import { TieredModerationEngine } from "./moderation.js";
import { DurableApiLimiter } from "./rate-limiter.js";
import { SharedHumanAuthority } from "./shared-authority.js";
import { createStore } from "./storage/index.js";
import { MisskeyStream } from "./stream.js";
import { AccountReputation } from "./account-reputation.js";
import { StopForumSpamClient } from "./stop-forum-spam.js";
import { reputationPolicyKey } from "./reputation-policy.js";

/** Bind all per-case writes to the worker's current lease. */
export function createCaseHandler({ store, config, rules, sourceSha256, client, authority, logger, selfUserId, createEngine,
  reputationPolicy = null, reputationService = null }) {
  const makeEngine = createEngine ?? ((options) => new TieredModerationEngine(options));
  return async (payload, context) => {
    const envelope = validateInboxEnvelope(payload, { rules, sourceSha256, mode: config.mode, reputationPolicy });
    if (envelope.userId === selfUserId) {
      const error = new Error("Inbox case targets the automod account.");
      error.code = "INVALID_ENVELOPE";
      error.permanent = true;
      throw error;
    }
    const { claim, assertActive, signal } = context;
    const guarded = (operation) => async (...args) => {
      await assertActive();
      return operation(...args);
    };
    const ledger = {
      hasProcessed: (noteId) => store.hasProcessed(noteId),
      record: guarded((event) => store.record(event, { lease: claim })),
    };
    const queue = (kind) => ({ enqueue: guarded((job) => store.enqueueJob(kind, job, { lease: claim })) });
    const journal = {
      get: guarded((key) => store.getAction(envelope.caseId, key)),
      start: guarded((key) => store.startAction(claim, key)),
      complete: guarded((key) => store.completeAction(claim, key)),
      reset: guarded((key) => store.resetAction(claim, key)),
    };
    const engine = makeEngine({
      mode: config.mode, moderator: client, ledger, reviewQueue: queue("review"), purgeQueue: queue("purge"),
      authority, logger, selfUserId, t2RoleId: config.t2RoleId, reviewDelayMs: config.reviewDelayMs,
      journal, assertActive, signal,
      moderationNoteEnabled: config.moderationNoteEnabled,
      moderationNoteLanguage: config.moderationNoteLanguage,
      userStateMaxAgeMs: Math.max(5000, config.minimumActionIntervalMs + 2000),
    });
    const { caseId, noteId, userId, tier, ruleIds, reasons } = envelope;
    const candidate = envelope.schemaVersion === 2;
    if (!candidate) {
      const succeeded = await engine.processCase({ caseId, noteId, userId, tier, ruleIds, reasons });
      if (!succeeded || tier === "T1") return succeeded;
    }
    if (!config.stopForumSpam?.enabled || !reputationService) {
      if (candidate) await ledger.record({ type: "case.completed", timestamp: new Date().toISOString(),
        caseId, noteId, userId, actor: "deterministic", ruleIds: [], reason: "reputation_disabled", outcome: "skipped" });
      return true;
    }
    const assessment = await reputationService.check(envelope, context);
    const result = assessment.result;
    const human = result.code === "HUMAN_DECISION";
    await ledger.record({ type: human ? "automation.skipped.human" : "reputation.assessed",
      timestamp: new Date().toISOString(), caseId, noteId, userId, actor: human ? "human" : "deterministic",
      ruleIds: [reputationPolicy.id], reason: reputationPolicy.reason, outcome: result.status,
      riskScore: result.score, reputation: { provider: "stopforumspam", ...result }, cached: assessment.cached });
    if (candidate && result.status === "listed" && assessment.caseId === caseId && !human) {
      return engine.processCase({ caseId, noteId, userId, tier: "T3", ruleIds: [reputationPolicy.id],
        reasons: [reputationPolicy.reason], reputation: { provider: "stopforumspam", ...result } });
    }
    if (candidate) await ledger.record({ type: "case.completed", timestamp: new Date().toISOString(),
      caseId, noteId, userId, actor: human ? "human" : "deterministic", ruleIds: [],
      reason: "reputation_observation_complete", outcome: result.status });
    return true;
  };
}

export async function runApplication(
  { config, rules, sourceSha256, reputationPolicy = null, logger = new Logger(), signal }, dependencies = {},
) {
  if (config.stopForumSpam?.enabled && !reputationPolicy?.enabled) {
    throw new Error("SFS_ENABLED requires an enabled compiled account reputation policy.");
  }
  if (config.mode === "enforce" && !config.t2RoleId && rules.some((rule) => rule.enabled && rule.tier === "T2")) {
    throw new Error("T2_ROLE_ID is required when an enabled T2 rule runs in enforce mode.");
  }
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  if (signal?.aborted) shutdown();
  else signal?.addEventListener("abort", shutdown, { once: true });
  let store, healthServer, stream, intake, poll;
  let pollPending = Promise.resolve();
  let fatal;
  const tasks = [];
  const fail = (error) => {
    fatal ??= error;
    controller.abort();
  };
  try {
    if (controller.signal.aborted) return;
    if (config.storageBackend === "sqlite") await mkdir(config.dataDirectory, { recursive: true });
    store = dependencies.store ?? await createStore({
      backend: config.storageBackend, sqlitePath: config.sqlitePath, databaseUrl: config.databaseUrl,
      namespace: config.namespace, maxInboxJobs: config.maxInboxJobs, maxQueuedJobs: config.maxQueuedJobs,
      maxAttempts: config.maxWorkAttempts,
    });
    const limiter = dependencies.rateLimiter ?? new DurableApiLimiter({ store, intervalMs: config.minimumActionIntervalMs });
    const client = dependencies.client ?? new MisskeyApiClient({ baseUrl: config.baseUrl, token: config.token, rateLimiter: limiter });
    const me = await client.getMe({ signal: controller.signal });
    if (!me?.id) throw new Error("The Misskey token did not return an authenticated user.");
    if (me.host != null) throw new Error("The automod token must belong to a local Misskey account.");
    if (config.storageBackend === "sqlite") await (dependencies.importLegacy ?? importLegacyJsonl)(store, config.dataDirectory);
    const authority = dependencies.authority ?? new SharedHumanAuthority({
      store, logger, localPath: config.storageBackend === "sqlite" ? join(config.dataDirectory, "human-overrides.json") : null,
    });
    const sfs = config.stopForumSpam;
    const policyKey = sfs?.enabled ? reputationPolicyKey(reputationPolicy, { sourceSha256, checkIp: sfs.checkIp }) : null;
    const reputationService = sfs?.enabled ? dependencies.reputationService ?? new AccountReputation({
      store, misskey: client, authority, policy: reputationPolicy, policyKey, checkIp: sfs.checkIp,
      cacheTtlMs: sfs.cacheTtlMs, failureTtlMs: sfs.failureTtlMs,
      userStateMaxAgeMs: Math.max(5000, config.minimumActionIntervalMs + 2000),
      provider: dependencies.reputationProvider ?? new StopForumSpamClient({ budget: store,
        intervalMs: sfs.intervalMs, maxDailyRequests: sfs.maxDailyRequests }),
    }) : null;
    const health = new HealthState(config.mode, config.role);
    health.rulesLoaded = rules.length;
    const refresh = async () => {
      try {
        health.queue = await store.stats();
        health.api = limiter.snapshot();
        health.reputation = sfs?.enabled ? { enabled: true, ...await store.reputationStats() } : { enabled: false };
        health.storageConnected = true;
      } catch (error) {
        health.storageConnected = false;
        fail(error);
      }
    };
    await refresh();
    if (fatal) throw fatal;
    healthServer = await (dependencies.startHealth ?? startHealthServer)({
      host: config.healthHost, port: config.healthPort, state: health, logger,
    });
    // One database health request in flight at a time, including during shutdown.
    let polling = false;
    poll = setInterval(() => {
      if (polling) return;
      polling = true;
      pollPending = refresh().finally(() => { polling = false; });
    }, 1000);
    if (config.role !== "worker") {
      intake = new DurableIntake({
        store, rules, sourceSha256, mode: config.mode, selfUserId: me.id,
        reputationPolicy: sfs?.enabled ? reputationPolicy : null, reputationPolicyKey: policyKey,
        maxPendingNotes: config.maxPendingNotes, logger,
        onStateChange: (snapshot) => { health.noteProcessing = snapshot; },
      });
      health.noteProcessing = intake.snapshot();
      stream = (dependencies.createStream ?? ((options) => new MisskeyStream(options)))({
        baseUrl: config.baseUrl, token: config.token, logger,
        onConnectionChange: (connected) => { health.streamConnected = connected; },
        onNote: (note) => {
          health.lastNoteAt = new Date().toISOString();
          try {
            intake.submit(note).catch(() => fail(new Error("Durable intake failed; ingestion stopped.")));
          } catch {
            fail(new Error("Durable intake failed; ingestion stopped."));
          }
        },
      });
    }
    if (config.role !== "ingest") {
      const worker = (dependencies.createWorker ?? ((options) => new DurableWorker(options)))({
        store, concurrency: config.workerConcurrency, leaseMs: config.workLeaseMs, pollMs: config.workerPollMs,
        retryBaseMs: config.retryBaseMs, retryMaxMs: config.retryMaxMs, logger,
        handle: createCaseHandler({ store, config, rules, sourceSha256, client, authority, logger,
          selfUserId: me.id, createEngine: dependencies.createEngine, reputationPolicy, reputationService }),
        onStateChange: (snapshot) => { health.worker = snapshot; },
      });
      health.workerRunning = true;
      tasks.push(Promise.resolve().then(() => worker.run(controller.signal)).finally(() => { health.workerRunning = false; }));
    }
    if (stream) tasks.push(Promise.resolve().then(() => stream.run(controller.signal)));
    logger.info("Automod started", { mode: config.mode, role: config.role, backend: config.storageBackend,
      namespace: config.namespace, misskeyUrl: config.baseUrl, accountId: me.id, sourceSha256 });
    if (config.mode === "dry-run") logger.warn("Dry-run mode is active; no notes or accounts will be modified");
    if (rules.some((rule) => rule.enabled && rule.tier === "T1")) {
      logger.warn("T1 purge jobs require a verified Misskey server-side deletion worker");
    }
    await Promise.race(tasks);
    if (fatal) throw fatal;
  } finally {
    clearInterval(poll);
    signal?.removeEventListener("abort", shutdown);
    controller.abort();
    const drained = intake?.close();
    try {
      stream?.close();
    } finally {
      await Promise.allSettled([...tasks, drained, pollPending]);
      try {
        if (healthServer) await new Promise((resolve) => healthServer.close(resolve));
      } finally {
        await store?.close();
      }
    }
    logger.info("Automod stopped");
  }
  if (fatal) throw fatal;
}
