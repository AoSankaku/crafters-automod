import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadGeneratedRules } from "../src/generated-rules.js";
import { loadReputationPolicy } from "../src/reputation-policy.js";

export const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

export async function checkRules() {
  const source = await readFile(new URL("../rules.md", import.meta.url), "utf8");
  const document = JSON.parse(await readFile(new URL("../rules.generated.json", import.meta.url), "utf8"));
  const hash = createHash("sha256").update(source.replace(/\r\n/gu, "\n")).digest("hex");
  if (document.sourceSha256 !== hash) throw new Error("Generated rules do not match rules.md. Regenerate and review the policy before building.");
  loadGeneratedRules(document);
  loadReputationPolicy(document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkRules();
    console.log("Generated policy validated.");
  } catch {
    console.error("Generated policy validation failed. Check rules.md and rules.generated.json.");
    process.exitCode = 1;
  }
}
