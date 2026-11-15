import { loadConfig } from "./config.js";
import { loadEnvironment } from "./environment.js";
import { applyOverride, migrateToPostgres, storeOptions } from "./maintenance.js";
import { createStore } from "./storage/index.js";

try {
  loadEnvironment();
  const config = loadConfig();
  const [command, ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (command === "override") {
    await applyOverride(config, args);
    console.log("Human override saved. Automation will honor it before further actions.");
  } else if (command === "migrate" && args.length === 0) {
    console.log(JSON.stringify(await migrateToPostgres(config)));
  } else if (command === "status" && args.length === 0) {
    const store = await createStore(storeOptions(config));
    try { console.log(JSON.stringify(await store.stats())); } finally { await store.close(); }
  } else {
    throw new Error("Use override, migrate, or status.");
  }
} catch {
  // Driver and filesystem errors may contain credentials or local source content.
  console.error("Maintenance command failed. Check the command arguments, configuration, database and offline migration prerequisites.");
  process.exitCode = 1;
}
