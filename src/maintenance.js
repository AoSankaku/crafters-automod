import { stat } from "node:fs/promises";
import { join } from "node:path";
import { importHumanOverrides, importLegacyJsonl } from "./legacy-import.js";
import { createStore } from "./storage/index.js";

export function storeOptions(config) {
  return {
    backend: config.storageBackend, sqlitePath: config.sqlitePath, databaseUrl: config.databaseUrl,
    namespace: config.namespace, maxInboxJobs: config.maxInboxJobs, maxQueuedJobs: config.maxQueuedJobs,
    maxAttempts: config.maxWorkAttempts,
  };
}

export async function applyOverride(config, args, open = createStore) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--scope", "--id", "--reason"].includes(key) || !args[index + 1] || options[key]) {
      throw new Error("Usage: bun run override --scope case|note|user --id ID --reason REASON");
    }
    options[key] = args[index + 1];
  }
  const scope = options["--scope"];
  const id = options["--id"];
  const reason = options["--reason"];
  if (!["case", "note", "user"].includes(scope) || !id || id.length > 128 || /[\s\x00-\x1f]/u.test(id) ||
      !reason?.trim() || reason.length > 2000) throw new Error("A valid scope, ID and reason are required.");
  const store = await open(storeOptions(config));
  try {
    await store.setHumanDecision({ scope, id, reason: reason.trim() });
  } finally {
    await store.close();
  }
}

/** Offline copy. Stop every producer and worker before invoking this command. */
export async function migrateToPostgres(config, open = createStore) {
  if (config.storageBackend !== "postgres") throw new Error("Migration requires AUTOMOD_BACKEND=postgres and the target database URL.");
  if (!(await stat(config.sqlitePath)).isFile()) throw new Error("The source SQLite database does not exist.");
  const source = await open({ ...storeOptions(config), backend: "sqlite", databaseUrl: null, requireExisting: true });
  let target;
  try {
    await importLegacyJsonl(source, config.dataDirectory);
    await importHumanOverrides(source, join(config.dataDirectory, "human-overrides.json"));
    target = await open(storeOptions(config));
    for await (const record of source.exportState()) await target.importState(record);
    return await target.stats();
  } finally {
    try { await target?.close(); } finally { await source.close(); }
  }
}
