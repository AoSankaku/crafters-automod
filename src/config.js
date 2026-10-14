import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

export function loadConfig(env = process.env, workingDirectory = process.cwd()) {
  const baseUrl = required(env.MISSKEY_URL, "MISSKEY_URL");
  const token = required(env.MISSKEY_TOKEN, "MISSKEY_TOKEN");
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch { throw new Error("MISSKEY_URL must be a valid HTTP or HTTPS URL."); }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("MISSKEY_URL must use http or https.");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("MISSKEY_URL must not contain credentials, a query, or a fragment.");
  }

  const mode = env.AUTOMOD_MODE ?? "dry-run";
  if (mode !== "dry-run" && mode !== "enforce") {
    throw new Error("AUTOMOD_MODE must be dry-run or enforce.");
  }

  const normalizedUrl = parsedUrl.toString().replace(/\/$/u, "");
  const storageBackend = env.AUTOMOD_BACKEND ?? "sqlite";
  if (!["sqlite", "postgres"].includes(storageBackend)) throw new Error("AUTOMOD_BACKEND must be sqlite or postgres.");
  const role = env.AUTOMOD_ROLE ?? "all";
  if (!["all", "ingest", "worker"].includes(role)) throw new Error("AUTOMOD_ROLE must be all, ingest, or worker.");
  const workerConcurrency = integer(env.WORKER_CONCURRENCY ?? "1", "WORKER_CONCURRENCY", 1, 32);
  if (storageBackend === "sqlite" && (role !== "all" || workerConcurrency !== 1)) {
    throw new Error("SQLite requires AUTOMOD_ROLE=all and WORKER_CONCURRENCY=1; use PostgreSQL for distributed workers.");
  }
  let databaseUrl = null;
  if (storageBackend === "postgres") {
    databaseUrl = required(env.AUTOMOD_DATABASE_URL, "AUTOMOD_DATABASE_URL");
    try {
      const database = new URL(databaseUrl);
      if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || database.pathname.length <= 1) throw new Error();
    } catch {
      throw new Error("AUTOMOD_DATABASE_URL must be a PostgreSQL connection URL with a database name.");
    }
  }
  const namespace = env.AUTOMOD_NAMESPACE ?? createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 32);
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(namespace)) throw new Error("AUTOMOD_NAMESPACE must contain 1 to 64 letters, digits, underscores, or hyphens.");
  const dataDirectory = resolve(workingDirectory, env.AUTOMOD_DATA_DIR ?? "data");

  return {
    baseUrl: normalizedUrl,
    token,
    mode,
    storageBackend,
    databaseUrl,
    namespace,
    role,
    workerConcurrency,
    sqlitePath: join(dataDirectory, "automod.sqlite"),
    maxInboxJobs: integer(env.MAX_INBOX_JOBS ?? "100000", "MAX_INBOX_JOBS", 1, 1_000_000),
    maxWorkAttempts: integer(env.WORK_MAX_ATTEMPTS ?? "5", "WORK_MAX_ATTEMPTS", 1, 20),
    workLeaseMs: integer(env.WORK_LEASE_MS ?? "60000", "WORK_LEASE_MS", 30_000, 600_000),
    workerPollMs: integer(env.WORKER_POLL_MS ?? "250", "WORKER_POLL_MS", 50, 60_000),
    retryBaseMs: integer(env.WORK_RETRY_BASE_MS ?? "1000", "WORK_RETRY_BASE_MS", 100, 60_000),
    retryMaxMs: integer(env.WORK_RETRY_MAX_MS ?? "60000", "WORK_RETRY_MAX_MS", 60_000, 3_600_000),
    t2RoleId: env.T2_ROLE_ID?.trim() || null,
    reviewDelayMs: integer(env.LLM_REVIEW_DELAY_MS ?? "900000", "LLM_REVIEW_DELAY_MS", 0, 86_400_000),
    maxQueuedJobs: integer(env.MAX_QUEUED_JOBS ?? "100000", "MAX_QUEUED_JOBS", 1, 1_000_000),
    maxPendingNotes: integer(env.MAX_PENDING_NOTES ?? "1000", "MAX_PENDING_NOTES", 1, 100_000),
    dataDirectory,
    healthHost: env.HEALTH_HOST ?? "0.0.0.0",
    healthPort: integer(env.HEALTH_PORT ?? "8787", "HEALTH_PORT", 1, 65_535),
    minimumActionIntervalMs: integer(
      env.MIN_ACTION_INTERVAL_MS ?? "1100",
      "MIN_ACTION_INTERVAL_MS",
      1,
      60_000,
    ),
  };
}

function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}
