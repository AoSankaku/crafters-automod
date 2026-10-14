import { join } from "node:path";
import { HealthState, startHealthServer } from "./health.js";
import { FileHumanAuthority } from "./human-authority.js";
import { Logger } from "./logger.js";
import { MisskeyApiClient } from "./misskey.js";
import { TieredModerationEngine } from "./moderation.js";
import { NoteProcessor } from "./note-processor.js";
import { JsonlAuditLedger, JsonlJobQueue } from "./persistence.js";
import { MisskeyStream } from "./stream.js";

/** Compose the service without installing process handlers or reading environment variables. */
export async function runApplication(
  { config, rules, sourceSha256, logger = new Logger(), signal },
  dependencies = {},
) {
  const requiresT2Role = config.mode === "enforce" && rules.some((rule) => rule.enabled && rule.tier === "T2");
  if (requiresT2Role && !config.t2RoleId) {
    throw new Error("T2_ROLE_ID is required when an enabled T2 rule runs in enforce mode.");
  }
  logger.info("Static automod rules loaded", {
    count: rules.length,
    enabled: rules.filter((rule) => rule.enabled).length,
    sourceSha256,
  });

  const client = dependencies.client ?? new MisskeyApiClient({ baseUrl: config.baseUrl, token: config.token });
  const me = await client.getMe();
  if (!me?.id) throw new Error("The Misskey token did not return an authenticated user.");
  if (me.host != null) throw new Error("The automod token must belong to a local Misskey account.");

  const ledger = dependencies.ledger ?? new JsonlAuditLedger(join(config.dataDirectory, "audit.jsonl"));
  const reviewQueue = dependencies.reviewQueue ?? new JsonlJobQueue(
    join(config.dataDirectory, "llm-review-queue.jsonl"), { maxJobs: config.maxQueuedJobs },
  );
  const purgeQueue = dependencies.purgeQueue ?? new JsonlJobQueue(
    join(config.dataDirectory, "t1-purge-queue.jsonl"), { maxJobs: config.maxQueuedJobs },
  );
  await Promise.all([ledger.initialize(), reviewQueue.initialize(), purgeQueue.initialize()]);
  const authority = dependencies.authority ?? new FileHumanAuthority(
    join(config.dataDirectory, "human-overrides.json"), logger,
  );
  const createEngine = dependencies.createEngine ?? ((options) => new TieredModerationEngine(options));
  const engine = createEngine({
    mode: config.mode,
    moderator: client,
    ledger,
    reviewQueue,
    purgeQueue,
    authority,
    logger,
    selfUserId: me.id,
    t2RoleId: config.t2RoleId,
    reviewDelayMs: config.reviewDelayMs,
  });
  const health = new HealthState(config.mode);
  health.rulesLoaded = rules.length;
  const processor = new NoteProcessor({
    processNote: (note) => engine.process(note, rules),
    maxPendingNotes: config.maxPendingNotes,
    logger,
    onStateChange: (snapshot) => {
      health.noteProcessing = snapshot;
    },
  });
  health.noteProcessing = processor.snapshot();
  const startHealth = dependencies.startHealth ?? startHealthServer;
  const healthServer = await startHealth({
    host: config.healthHost, port: config.healthPort, state: health, logger,
  });
  let stream;

  try {
    const createStream = dependencies.createStream ?? ((options) => new MisskeyStream(options));
    stream = createStream({
      baseUrl: config.baseUrl,
      token: config.token,
      logger,
      onConnectionChange: (connected) => {
        health.streamConnected = connected;
      },
      onNote: (note) => {
        health.lastNoteAt = new Date().toISOString();
        processor.submit(note);
      },
    });
    logger.info("Automod started", { mode: config.mode, misskeyUrl: config.baseUrl, accountId: me.id });
    if (config.mode === "dry-run") {
      logger.warn("Dry-run mode is active; no notes or accounts will be modified");
    }
    if (rules.some((rule) => rule.enabled && rule.tier === "T1")) {
      logger.warn("T1 purge jobs are persisted but require a Misskey server-side deletion worker");
    }
    await stream.run(signal);
  } finally {
    const drained = processor.close();
    try {
      stream?.close();
    } finally {
      try {
        await drained;
      } finally {
        await new Promise((resolve) => healthServer.close(resolve));
        logger.info("Automod stopped");
      }
    }
  }
}
