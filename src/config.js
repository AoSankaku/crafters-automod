import { resolve } from "node:path";

export function loadConfig(env = process.env, workingDirectory = process.cwd()) {
  const baseUrl = required(env.MISSKEY_URL, "MISSKEY_URL");
  const token = required(env.MISSKEY_TOKEN, "MISSKEY_TOKEN");
  const parsedUrl = new URL(baseUrl);
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

  return {
    baseUrl: parsedUrl.toString().replace(/\/$/u, ""),
    token,
    mode,
    t2RoleId: env.T2_ROLE_ID?.trim() || null,
    reviewDelayMs: integer(env.LLM_REVIEW_DELAY_MS ?? "900000", "LLM_REVIEW_DELAY_MS", 0, 86_400_000),
    maxQueuedJobs: integer(env.MAX_QUEUED_JOBS ?? "100000", "MAX_QUEUED_JOBS", 1, 1_000_000),
    maxPendingNotes: integer(env.MAX_PENDING_NOTES ?? "1000", "MAX_PENDING_NOTES", 1, 100_000),
    dataDirectory: resolve(workingDirectory, env.AUTOMOD_DATA_DIR ?? "data"),
    healthHost: env.HEALTH_HOST ?? "0.0.0.0",
    healthPort: integer(env.HEALTH_PORT ?? "8787", "HEALTH_PORT", 1, 65_535),
    minimumActionIntervalMs: integer(
      env.MIN_ACTION_INTERVAL_MS ?? "1100",
      "MIN_ACTION_INTERVAL_MS",
      0,
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
