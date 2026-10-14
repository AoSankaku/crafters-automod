import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyOverride, migrateToPostgres } from "../src/maintenance.js";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function config() {
  const directory = await mkdtemp(join(tmpdir(), "automod-maintenance-"));
  directories.push(directory);
  const sqlitePath = join(directory, "automod.sqlite");
  await writeFile(sqlitePath, "source-fixture");
  return { storageBackend: "postgres", sqlitePath, dataDirectory: directory, databaseUrl: "postgresql://placeholder", namespace: "same-namespace" };
}

describe("maintenance commands", () => {
  test("validates an override before opening storage and always closes after a write", async () => {
    const store = { setHumanDecision: mock(async () => {}), close: mock(async () => {}) };
    const open = mock(async () => store);
    await expect(applyOverride({}, ["--scope", "invalid", "--id", "user", "--reason", "Human"], open)).rejects.toThrow(/valid/);
    expect(open).not.toHaveBeenCalled();
    await applyOverride({}, ["--scope", "user", "--id", "user", "--reason", " Human "], open);
    expect(store.setHumanDecision).toHaveBeenCalledWith({ scope: "user", id: "user", reason: "Human" });
    expect(store.close).toHaveBeenCalledTimes(1);
    store.setHumanDecision.mockRejectedValueOnce(new Error("unavailable"));
    await expect(applyOverride({}, ["--scope", "case", "--id", "case", "--reason", "Human"], open)).rejects.toThrow(/unavailable/);
    expect(store.close).toHaveBeenCalledTimes(2);
  });

  test("streams state into the same namespace, requires existing source, and closes both connections", async () => {
    const settings = await config();
    const records = [{ kind: "meta" }, { kind: "human" }, { kind: "footer" }];
    const source = { hasImport: mock(async () => false), markImport() {}, importLegacyRecord() {}, setHumanDecision() {},
      async *exportState() { yield* records; }, close: mock(async () => {}) };
    const target = { importState: mock(async () => {}), stats: mock(async () => ({ completed: 7 })), close: mock(async () => {}) };
    const open = mock(async (options) => options.backend === "sqlite" ? source : target);
    expect(await migrateToPostgres(settings, open)).toEqual({ completed: 7 });
    expect(open.mock.calls[0][0]).toEqual(expect.objectContaining({ backend: "sqlite", requireExisting: true, namespace: "same-namespace" }));
    expect(target.importState.mock.calls.map(([record]) => record)).toEqual(records);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  test("a transfer failure never advances to footer and closes both sides", async () => {
    const settings = await config();
    const source = { hasImport() {}, markImport() {}, importLegacyRecord() {}, setHumanDecision() {},
      async *exportState() { yield { kind: "meta" }; yield { kind: "human" }; yield { kind: "footer" }; }, close: mock(async () => {}) };
    const target = { importState: mock(async (record) => { if (record.kind === "human") throw new Error("transfer failed"); }), close: mock(async () => {}) };
    const open = async (options) => options.backend === "sqlite" ? source : target;
    await expect(migrateToPostgres(settings, open)).rejects.toThrow(/transfer failed/);
    expect(target.importState.mock.calls.some(([record]) => record.kind === "footer")).toBe(false);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(target.close).toHaveBeenCalledTimes(1);
  });
});
