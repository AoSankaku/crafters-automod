import { describe, expect, mock, test } from "bun:test";

import { runApplication } from "../src/application.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ user = { id: "automod", host: null }, rules = [], processNote = async () => {}, runStream } = {}) {
  const config = { mode: "dry-run", t2RoleId: null, maxPendingNotes: 2, reviewDelayMs: 60_000 };
  const logger = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
  const initialize = () => ({ initialize: mock(async () => {}) });
  const server = { close: mock((callback) => callback()) };
  const engine = { process: mock(processNote) };
  const stream = { close: mock(() => {}) };
  let health;
  const dependencies = {
    client: { getMe: mock(async () => user) },
    ledger: initialize(), reviewQueue: initialize(), purgeQueue: initialize(), authority: {},
    createEngine: mock(() => engine),
    startHealth: mock(({ state }) => { health = state; return server; }),
    createStream: mock((options) => {
      stream.run = mock(async (signal) => runStream?.(options, signal));
      return stream;
    }),
  };
  const run = () => runApplication({ config, rules, sourceSha256: "policy-hash", logger, signal: new AbortController().signal }, dependencies);
  return { run, config, rules, dependencies, engine, server, stream, health: () => health };
}

describe("application lifecycle", () => {
  test("wires account, rules, health and processing without side effects at import", async () => {
    const incoming = { id: "note-1" };
    const h = harness({ runStream: (options) => {
      options.onConnectionChange(true);
      options.onNote(incoming);
    } });
    await h.run();

    expect(h.dependencies.ledger.initialize).toHaveBeenCalledTimes(1);
    expect(h.dependencies.reviewQueue.initialize).toHaveBeenCalledTimes(1);
    expect(h.dependencies.purgeQueue.initialize).toHaveBeenCalledTimes(1);
    expect(h.dependencies.createEngine).toHaveBeenCalledWith(expect.objectContaining({ selfUserId: "automod", mode: "dry-run" }));
    expect(h.engine.process).toHaveBeenCalledWith(incoming, h.rules);
    expect(h.health().snapshot()).toEqual(expect.objectContaining({
      streamConnected: true,
      lastNoteAt: expect.any(String),
      noteProcessing: { pending: 0, capacity: 2, rejected: 0, failed: 0 },
    }));
    expect(h.stream.close).toHaveBeenCalledTimes(1);
    expect(h.server.close).toHaveBeenCalledTimes(1);
  });

  test("drains accepted work and closes resources even when the stream fails", async () => {
    const started = deferred();
    const release = deferred();
    const h = harness({
      processNote: async (note) => {
        if (note.id === "first") { started.resolve(); await release.promise; }
      },
      runStream: (options) => {
        options.onNote({ id: "first" });
        options.onNote({ id: "second" });
        throw new Error("stream failed");
      },
    });
    const running = h.run();
    await started.promise;
    expect(h.server.close).not.toHaveBeenCalled();
    release.resolve();
    await expect(running).rejects.toThrow("stream failed");

    expect(h.engine.process.mock.calls.map(([note]) => note.id)).toEqual(["first", "second"]);
    expect(h.stream.close).toHaveBeenCalledTimes(1);
    expect(h.server.close).toHaveBeenCalledTimes(1);
  });

  test("closes health when stream creation fails", async () => {
    const h = harness();
    h.dependencies.createStream.mockImplementation(() => { throw new Error("socket setup failed"); });
    await expect(h.run()).rejects.toThrow("socket setup failed");
    expect(h.server.close).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid accounts before starting health or streaming", async () => {
    for (const user of [{}, { id: "remote", host: "other.example" }]) {
      const h = harness({ user });
      await expect(h.run()).rejects.toThrow(/authenticated user|local Misskey account/);
      expect(h.dependencies.startHealth).not.toHaveBeenCalled();
      expect(h.dependencies.createStream).not.toHaveBeenCalled();
    }
  });

  test("requires a T2 role only for enabled T2 rules in enforce mode", async () => {
    const h = harness({ rules: [{ enabled: true, tier: "T2" }] });
    h.config.mode = "enforce";
    await expect(h.run()).rejects.toThrow(/T2_ROLE_ID/);
    expect(h.dependencies.client.getMe).not.toHaveBeenCalled();
    h.rules[0].enabled = false;
    await h.run();
    expect(h.dependencies.client.getMe).toHaveBeenCalledTimes(1);
  });
});
