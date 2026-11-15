import generatedDocument from "../rules.generated.json" with { type: "json" };
import { loadEnvironment } from "./environment.js";
import { runApplication } from "./application.js";
import { loadConfig } from "./config.js";
import { loadGeneratedRules } from "./generated-rules.js";
import { Logger } from "./logger.js";
import { loadReputationPolicy } from "./reputation-policy.js";
import { registerShutdownHandlers } from "./shutdown.js";

async function main() {
  loadEnvironment();
  const logger = new Logger();
  const config = loadConfig();
  const rules = loadGeneratedRules(generatedDocument);
  const reputationPolicy = loadReputationPolicy(generatedDocument);
  const controller = new AbortController();
  const unregisterShutdown = registerShutdownHandlers(controller);
  try {
    await runApplication({
      config, rules, reputationPolicy, sourceSha256: generatedDocument.sourceSha256, logger, signal: controller.signal,
    });
  } finally {
    unregisterShutdown();
  }
}

main().catch((error) => {
  new Logger().error("Automod failed to start", error);
  process.exitCode = 1;
});
