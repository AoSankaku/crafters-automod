import { afterEach, describe, expect, mock, test } from "#test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileHumanAuthority, JsonlAuditLedger, JsonlJobQueue } from "../src/persistence.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "automod-test-"));
  temporaryDirectories.push(path);
  return path;
}

describe("persistent moderation state", () => {
  test("restores only completed note ids from the append-only audit ledger", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "audit.jsonl");
    const ledger = new JsonlAuditLedger(path);
    await ledger.initialize();
    await ledger.record({ type: "case.classified", noteId: "note-1" });

    const classifiedOnly = new JsonlAuditLedger(path);
    await classifiedOnly.initialize();
    expect(classifiedOnly.hasProcessed("note-1")).toBe(false);

    await ledger.record({ type: "case.completed", noteId: "note-1" });

    const restored = new JsonlAuditLedger(path);
    await restored.initialize();

    expect(restored.hasProcessed("note-1")).toBe(true);
  });

  test("does not cache a completed case when audit append fails, then retries successfully", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "audit.jsonl");
    let attempts = 0;
    const append = mock(async (target, contents) => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk temporarily unavailable");
      return writeFile(target, contents);
    });
    const ledger = new JsonlAuditLedger(path, { append });
    await ledger.initialize();
    const event = { type: "case.completed", noteId: "note-1" };

    await expect(ledger.record(event)).rejects.toThrow("disk temporarily unavailable");
    expect(ledger.hasProcessed("note-1")).toBe(false);
    await ledger.record(event);

    expect(ledger.hasProcessed("note-1")).toBe(true);
    expect(append).toHaveBeenCalledTimes(2);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("does not enqueue the same durable job twice", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "jobs.jsonl");
    const queue = new JsonlJobQueue(path);
    await queue.initialize();
    await queue.enqueue({ caseId: "case-1", userId: "user-1" });
    await queue.enqueue({ caseId: "case-1", userId: "user-1" });

    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("retries a job after a transient append failure without duplicating concurrent work", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "jobs.jsonl");
    let attempts = 0;
    const append = mock(async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk temporarily unavailable");
      return writeFile(args[0], args[1]);
    });
    const queue = new JsonlJobQueue(path, { append });
    await queue.initialize();
    const job = { caseId: "case-1", userId: "user-1" };

    await expect(queue.enqueue(job)).rejects.toThrow("disk temporarily unavailable");
    await Promise.all([queue.enqueue(job), queue.enqueue(job)]);

    expect(append).toHaveBeenCalledTimes(2);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("fails closed when a durable queue reaches its configured capacity", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "jobs.jsonl");
    const queue = new JsonlJobQueue(path, { maxJobs: 1 });
    await queue.initialize();
    await queue.enqueue({ caseId: "case-1", userId: "user-1" });

    await expect(queue.enqueue({ caseId: "case-2", userId: "user-2" })).rejects.toThrow(
      "queue capacity",
    );
  });

  test("counts pending writes toward capacity and deduplicates the same pending job", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "jobs.jsonl");
    let releaseAppend;
    const append = mock(
      () =>
        new Promise((resolve) => {
          releaseAppend = async () => resolve(await writeFile(path, `${JSON.stringify({ caseId: "case-1", userId: "user-1" })}\n`));
        }),
    );
    const queue = new JsonlJobQueue(path, { append, maxJobs: 1 });
    await queue.initialize();

    const first = queue.enqueue({ caseId: "case-1", userId: "user-1" });
    const duplicate = queue.enqueue({ caseId: "case-1", userId: "user-1" });
    await Promise.resolve();
    await expect(queue.enqueue({ caseId: "case-2", userId: "user-2" })).rejects.toThrow("queue capacity");
    releaseAppend();
    await Promise.all([first, duplicate]);

    expect(append).toHaveBeenCalledTimes(1);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("human overrides take priority and malformed override state fails closed", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "human-overrides.json");
    const logger = { error: mock(() => undefined) };
    const authority = new FileHumanAuthority(path, logger);
    await writeFile(path, JSON.stringify({ caseIds: ["case-1"], userIds: ["user-1"], noteIds: [] }));

    expect(await authority.hasHumanDecision({ userId: "user-1", noteId: "note-1" })).toBe(true);
    expect(
      await authority.hasHumanDecision({ caseId: "case-1", userId: "user-2", noteId: "note-2" }),
    ).toBe(true);
    await writeFile(path, "not json");
    expect(await authority.hasHumanDecision({ userId: "user-2", noteId: "note-2" })).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
