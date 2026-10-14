import generatedDocument from "../rules.generated.json";
import { runApplication } from "./application.js";
import { loadConfig } from "./config.js";
import { loadGeneratedRules } from "./generated-rules.js";
import { Logger } from "./logger.js";

async function main() {
  const logger = new Logger();
  const config = loadConfig();
  const rules = loadGeneratedRules(generatedDocument);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runApplication({
      config, rules, sourceSha256: generatedDocument.sourceSha256, logger, signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

main().catch((error) => {
  new Logger().error("Automod failed to start", error);
  process.exitCode = 1;
});
