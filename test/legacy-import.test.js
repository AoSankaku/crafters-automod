import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { importHumanOverrides, importLegacyJsonl } from "../src/legacy-import.js";
import { createStore } from "../src/storage/index.js";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "automod-legacy-import-"));
  directories.push(path);
  return path;
}

function fakeStore(overrides = {}) {
  const imports = new Set();
  const records = [];
  const files = new Set();
  return {
    imports,
    records,
    files,
    hasImport: mock(async (key) => files.has(key)),
    markImport: mock(async (key) => files.add(key)),
    importLegacyRecord: mock(async (kind, value, key) => {
      const importId = `${kind}:${key}`;
      if (imports.has(importId)) return { imported: false };
      imports.add(importId);
      records.push({ kind, value, key });
      return { imported: true };
    }),
    setHumanDecision: mock(async (decision) => decision),
    ...overrides,
  };
}

const audit = {
  type: "case.completed",
  timestamp: "2026-01-02T03:04:05.000Z",
  actor: "human",
  caseId: "case-1",
  noteId: "note-1",
  userId: "user-1",
  reason: "reviewed by moderator",
};

describe("legacy persistent state importer", () => {
  test("accepts the prior audit username field without retaining extra profile evidence", async () => {
    const directory = await tempDir();
    await writeFile(join(directory, "audit.jsonl"), JSON.stringify({ ...audit, username: "legacy_user" }) + "\n");
    const store = fakeStore();
    await importLegacyJsonl(store, directory);
    expect(store.records[0].value).toEqual(audit);
  });
  test("streams supported audit and queue records, preserving human decisions and original files", async () => {
    const directory = await tempDir();
    const paths = {
      audit: join(directory, "audit.jsonl"),
      review: join(directory, "llm-review-queue.jsonl"),
      purge: join(directory, "t1-purge-queue.jsonl"),
    };
    const records = {
      audit,
      review: {
        caseId: "case-2",
        noteId: "note-2",
        userId: "user-2",
        tier: "T2",
        ruleIds: ["rule-1"],
        delayMs: 60_000,
        queuedAt: "2026-01-02T03:04:05.000Z",
        dueAt: "2026-01-02T03:05:05.000Z",
      },
      purge: {
        caseId: "case-3",
        userId: "user-3",
        queuedAt: "2026-01-02T03:04:05.000Z",
        dueAt: "2026-01-02T03:04:05.000Z",
      },
    };
    await writeFile(paths.audit, `${JSON.stringify(records.audit)}\n`);
    await writeFile(paths.review, `${JSON.stringify(records.review)}\n`);
    await writeFile(paths.purge, `${JSON.stringify(records.purge)}\n`);
    const original = await Promise.all(Object.values(paths).map((path) => readFile(path, "utf8")));
    const store = fakeStore();

    await importLegacyJsonl(store, directory);

    expect(store.records.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "audit", value: records.audit },
      { kind: "review", value: records.review },
      { kind: "purge", value: records.purge },
    ]);
    expect(store.records[0].key).toMatch(/^audit:1:/u);
    expect(store.records[0].key).toContain(":1:");
    expect(await Promise.all(Object.values(paths).map((path) => readFile(path, "utf8")))).toEqual(original);
    expect(store.markImport).toHaveBeenCalledTimes(3);
  });

  test("preserves completed cases and human decisions through the durable store importer", async () => {
    const directory = await tempDir();
    await writeFile(join(directory, "audit.jsonl"), `${JSON.stringify(audit)}\n`);
    const store = await createStore({ sqlitePath: join(directory, "state.sqlite") });
    try {
      await importLegacyJsonl(store, directory);
      expect(await store.hasProcessed("note-1")).toBe(true);
      expect(await store.hasHumanDecision({ caseId: "case-1" })).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("uses stable line import keys and a file fingerprint to skip completed scans", async () => {
    const directory = await tempDir();
    const path = join(directory, "audit.jsonl");
    await writeFile(path, `${JSON.stringify(audit)}\n`);
    const store = fakeStore();

    await importLegacyJsonl(store, directory);
    const originalKey = store.records[0].key;
    await importLegacyJsonl(store, directory);
    expect(store.records).toHaveLength(1);
    expect(store.markImport).toHaveBeenCalledTimes(1);

    await writeFile(path, `${JSON.stringify(audit)}\n${JSON.stringify({ ...audit, caseId: "case-4", noteId: "note-4" })}\n`);
    await importLegacyJsonl(store, directory);
    expect(store.records).toHaveLength(2);
    expect(store.records[0].key).toBe(originalKey);
    expect(store.records[1].key).not.toBe(originalKey);
    expect(store.markImport).toHaveBeenCalledTimes(2);
  });

  test("ignores absent legacy files", async () => {
    const directory = await tempDir();
    const store = fakeStore();

    await expect(importLegacyJsonl(store, directory)).resolves.toBeDefined();
    expect(store.records).toEqual([]);
    expect(store.markImport).not.toHaveBeenCalled();
  });

  test.each([
    ["malformed JSON", '{"type":"case.completed"'],
    ["unknown private fields", JSON.stringify({ ...audit, text: "private note body" })],
    ["duplicate fields", '{"type":"case.classified","type":"case.completed","timestamp":"2026-01-02T03:04:05.000Z","actor":"human","caseId":"case-1","noteId":"note-1"}'],
    ["invalid actor", JSON.stringify({ ...audit, actor: "llm-ish" })],
    ["invalid timestamp", JSON.stringify({ ...audit, timestamp: "yesterday" })],
    ["invalid case identifier", JSON.stringify({ ...audit, caseId: "case/one" })],
  ])("rejects %s without disclosing source data", async (_label, line) => {
    const directory = await tempDir();
    await writeFile(join(directory, "audit.jsonl"), `${line}\n`);
    const store = fakeStore();

    let caught;
    try {
      await importLegacyJsonl(store, directory);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).not.toContain("private note body");
    expect(caught.message).not.toContain(line);
    expect(store.markImport).not.toHaveBeenCalled();
  });

  test("rejects oversized JSONL lines before importing and does not include their contents in errors", async () => {
    const directory = await tempDir();
    const secret = "private-note-content";
    const oversized = JSON.stringify({ ...audit, reason: `${secret}${"x".repeat(70_000)}` });
    await writeFile(join(directory, "audit.jsonl"), `${oversized}\n`);
    const store = fakeStore();

    let caught;
    try {
      await importLegacyJsonl(store, directory);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).not.toContain(secret);
    expect(store.records).toEqual([]);
    expect(store.markImport).not.toHaveBeenCalled();
  });

  test("does not mark a file complete if it changes during a streaming scan", async () => {
    const directory = await tempDir();
    const path = join(directory, "audit.jsonl");
    await writeFile(path, `${JSON.stringify(audit)}\n`);
    const store = fakeStore({
      importLegacyRecord: mock(async (...args) => {
        await writeFile(path, `${JSON.stringify(audit)}\n${JSON.stringify({ ...audit, caseId: "case-5", noteId: "note-5" })}\n`);
        return { imported: true };
      }),
    });

    await expect(importLegacyJsonl(store, directory)).rejects.toThrow();
    expect(store.markImport).not.toHaveBeenCalled();
  });
});

describe("legacy human override migration", () => {
  test("does not rewrite the same human decisions when an offline migration resumes", async () => {
    const path = join(await tempDir(), "human-overrides.json");
    await writeFile(path, JSON.stringify({ caseIds: ["case"], noteIds: [], userIds: ["user"] }));
    const store = fakeStore();
    expect(await importHumanOverrides(store, path)).toEqual({ imported: 2 });
    expect(await importHumanOverrides(store, path)).toEqual({ imported: 0 });
    expect(store.setHumanDecision).toHaveBeenCalledTimes(2);
  });
  test("treats an absent optional override file as an empty decision set", async () => {
    const store = fakeStore();
    expect(await importHumanOverrides(store, join(await tempDir(), "human-overrides.json"))).toEqual({ imported: 0 });
    expect(store.setHumanDecision).not.toHaveBeenCalled();
  });
  test("imports each exact override scope into durable human decisions", async () => {
    const directory = await tempDir();
    const path = join(directory, "human-overrides.json");
    await writeFile(path, JSON.stringify({ caseIds: ["case-1"], noteIds: ["note-2"], userIds: ["user-3"] }));
    const store = fakeStore();

    await importHumanOverrides(store, path);

    expect(store.setHumanDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({ scope: "case", id: "case-1" }));
    expect(store.setHumanDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({ scope: "note", id: "note-2" }));
    expect(store.setHumanDecision).toHaveBeenNthCalledWith(3, expect.objectContaining({ scope: "user", id: "user-3" }));
    expect(store.setHumanDecision.mock.calls.every(([decision]) => decision.reason.length > 0)).toBe(true);
  });

  test.each([
    ["unexpected property", { caseIds: [], noteIds: [], userIds: [], content: "private" }],
    ["duplicate property", '{"caseIds":["case-1"],"caseIds":[],"noteIds":[],"userIds":[]}'],
    ["invalid identifier", { caseIds: ["case/1"], noteIds: [], userIds: [] }],
    ["wrong array shape", { caseIds: "case-1", noteIds: [], userIds: [] }],
  ])("rejects override files with %s", async (_label, overrides) => {
    const directory = await tempDir();
    const path = join(directory, "human-overrides.json");
    await writeFile(path, typeof overrides === "string" ? overrides : JSON.stringify(overrides));
    const store = fakeStore();

    await expect(importHumanOverrides(store, path)).rejects.toThrow();
    expect(store.setHumanDecision).not.toHaveBeenCalled();
  });
});
