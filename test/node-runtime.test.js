import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore } from "../src/storage/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const directories = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "automod-node-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("automod-node-")) throw new Error("Unexpected test directory.");
    await rm(path, { recursive: true, force: true });
  }
});
function runNode(source, { cwd = root, env = {} } = {}) {
  const result = spawnSync(node, ["--input-type=module", "-e", source], {
    cwd, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PATH: dirname(node), ...env },
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
  return result.stdout.trim();
}
const storageUrl = pathToFileURL(join(root, "src/storage/index.js")).href;

describe("Node runtime without Bun", () => {
  test("persists SQLite authority and action state readable by either runtime", async () => {
    const sqlitePath = join(await directory(), "automod.sqlite");
    runNode(`import { createStore } from ${JSON.stringify(storageUrl)};
      const store = await createStore({ sqlitePath: ${JSON.stringify(sqlitePath)}, namespace: "node-runtime" });
      try {
        await store.enqueue({ noteId: "note", userId: "user" });
        const claim = await store.claim({ workerId: "node", leaseMs: 30000 });
        await store.startAction(claim, "moderation-note:example");
        await store.completeAction(claim, "moderation-note:example");
        await store.setHumanDecision({ scope: "user", id: "user", reason: "Human decision" });
        await store.record({ type: "case.completed", caseId: "note", noteId: "note", userId: "user", timestamp: new Date().toISOString(), actor: "human" }, { lease: claim });
        await store.complete(claim);
      } finally { await store.close(); }`);
    const store = await createStore({ sqlitePath, namespace: "node-runtime", requireExisting: true });
    try {
      expect(await store.hasProcessed("note")).toBe(true);
      expect(await store.hasHumanDecision({ userId: "user" })).toBe(true);
      expect(await store.getAction("note", "moderation-note:example")).toEqual(expect.objectContaining({ status: "completed" }));
    } finally { await store.close(); }
  });

  test("Node reopens SQLite written by the current runtime without dropping state", async () => {
    const sqlitePath = join(await directory(), "automod.sqlite");
    const store = await createStore({ sqlitePath, namespace: "reverse-runtime" });
    await store.setHumanDecision({ scope: "note", id: "note", reason: "Human decision" });
    await store.close();
    expect(runNode(`import { createStore } from ${JSON.stringify(storageUrl)};
      const store = await createStore({ sqlitePath: ${JSON.stringify(sqlitePath)}, namespace: "reverse-runtime", requireExisting: true });
      try { console.log(await store.hasHumanDecision({ noteId: "note" })); } finally { await store.close(); }`)).toBe("true");
  });

  test("loads .env on Node while keeping explicit process variables authoritative", async () => {
    const cwd = await directory();
    await writeFile(join(cwd, ".env"), "AUTOMOD_RUNTIME_FIXTURE=from-file\nAUTOMOD_RUNTIME_EXPLICIT=from-file\n");
    const environmentUrl = pathToFileURL(join(root, "src/environment.js")).href;
    expect(JSON.parse(runNode(`import { loadEnvironment } from ${JSON.stringify(environmentUrl)};
      loadEnvironment(); console.log(JSON.stringify([process.env.AUTOMOD_RUNTIME_FIXTURE, process.env.AUTOMOD_RUNTIME_EXPLICIT]));`,
    { cwd, env: { AUTOMOD_RUNTIME_EXPLICIT: "from-process" } }))).toEqual(["from-file", "from-process"]);
  });

  test("builds deployable artifacts on Node with no Bun on PATH", () => {
    const result = spawnSync(node, ["scripts/build.js"], { cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PATH: dirname(node) } });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
  }, 30000);
});
