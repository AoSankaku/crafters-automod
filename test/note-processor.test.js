import { describe, expect, mock, test } from "bun:test";

import { NoteProcessor } from "../src/note-processor.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(processNote, maxPendingNotes = 2) {
  const logger = { warn: mock(() => {}), error: mock(() => {}) };
  const onStateChange = mock(() => {});
  const processor = new NoteProcessor({ processNote, maxPendingNotes, logger, onStateChange });
  return { processor, logger, onStateChange };
}

describe("NoteProcessor", () => {
  test("processes accepted notes serially and drains them when closed", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order = [];
    const { processor } = harness(async (note) => {
      order.push(note.id);
      if (note.id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });

    expect(processor.submit({ id: "first" })).toBe(true);
    expect(processor.submit({ id: "second" })).toBe(true);
    await firstStarted.promise;
    const draining = processor.close();
    expect(order).toEqual(["first"]);
    expect(processor.snapshot().pending).toBe(2);
    expect(processor.submit({ id: "late" })).toBe(false);
    releaseFirst.resolve();
    await draining;

    expect(order).toEqual(["first", "second"]);
    expect(processor.snapshot().pending).toBe(0);
    await processor.close();
  });

  test("bounds pending notes including the active note and reports overflow without content", async () => {
    const release = deferred();
    const { processor, logger, onStateChange } = harness(() => release.promise, 1);
    processor.submit({ id: "first" });
    expect(processor.submit({ id: "overflow", text: "private note content" })).toBe(false);
    expect(processor.snapshot()).toEqual({ pending: 1, capacity: 1, rejected: 1, failed: 0 });
    expect(onStateChange).toHaveBeenLastCalledWith(processor.snapshot());
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      noteId: "overflow", reason: "capacity", capacity: 1,
    });
    release.resolve();
    await processor.close();
  });

  test("a failed note does not block subsequent notes", async () => {
    const processNote = mock(async (note) => {
      if (note.id === "failed") throw new Error("audit unavailable");
    });
    const { processor, logger } = harness(processNote);
    processor.submit({ id: "failed", text: "private" });
    processor.submit({ id: "next" });
    await processor.close();

    expect(processNote.mock.calls.map(([note]) => note.id)).toEqual(["failed", "next"]);
    expect(processor.snapshot()).toEqual({ pending: 0, capacity: 2, rejected: 0, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(Error), { noteId: "failed" });
  });

  test("rejects invalid capacity", () => {
    for (const maxPendingNotes of [0, -1, 1.5, Infinity]) {
      expect(() => harness(async () => {}, maxPendingNotes)).toThrow(/capacity/);
    }
  });
});
