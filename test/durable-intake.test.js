import { describe, expect, mock, test } from "bun:test";
import { DurableIntake } from "../src/durable-intake.js";

const note = { id: "note-1", userId: "user-1", user: { id: "user-1", host: null }, text: "spam private content" };
const rules = [{ id: "spam", enabled: true, tier: "T3", field: "text", matchers: [{ type: "contains", value: "spam" }], excludedUsers: [], reason: "Observe" }];
function harness(enqueue = async () => ({ inserted: true }), capacity = 2) {
  const store = { enqueue: mock(enqueue) };
  const logger = { warn: mock(() => {}), error: mock(() => {}) };
  const intake = new DurableIntake({ store, rules, sourceSha256: "a".repeat(64), mode: "dry-run", selfUserId: "automod", maxPendingNotes: capacity, logger });
  return { intake, store, logger };
}

describe("durable intake", () => {
  test("accepts only after durable enqueue and never sends raw notes to storage", async () => {
    let release;
    const { intake, store } = harness(() => new Promise((resolve) => { release = resolve; }));
    const pending = intake.submit(note);
    expect(intake.snapshot().pending).toBe(1);
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.enqueue.mock.calls[0][0])).not.toContain("private");
    release({ inserted: true });
    expect(await pending).toBe(true);
    expect(intake.snapshot()).toEqual(expect.objectContaining({ pending: 0, accepted: 1 }));
    await intake.close();
  });

  test("reports duplicates separately and skips unmatched notes", async () => {
    const { intake, store } = harness(async () => ({ inserted: false }));
    expect(await intake.submit(note)).toBe(false);
    expect(await intake.submit({ ...note, text: "hello" })).toBe(false);
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    expect(intake.snapshot().duplicates).toBe(1);
  });

  test("bounds pending database writes and drains accepted writes on close", async () => {
    let release;
    const { intake, logger } = harness(() => new Promise((resolve) => { release = resolve; }), 1);
    const first = intake.submit(note);
    await expect(intake.submit({ ...note, id: "overflow" })).rejects.toThrow(/capacity/);
    expect(intake.snapshot().rejected).toBe(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private");
    const closing = intake.close();
    await expect(intake.submit({ ...note, id: "late" })).rejects.toThrow(/closed/);
    release({ inserted: true });
    await first;
    await closing;
    expect(intake.snapshot().pending).toBe(0);
  });

  test("surfaces persistence failures so the application can stop ingestion", async () => {
    const { intake } = harness(async () => { throw new Error("storage unavailable"); });
    await expect(intake.submit(note)).rejects.toThrow("storage unavailable");
    expect(intake.snapshot().failed).toBe(1);
    expect(intake.snapshot().accepted).toBe(0);
    await intake.close();
  });
});
