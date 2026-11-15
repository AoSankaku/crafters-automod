import { describe, expect, mock, test } from "#test";
import { runApplication } from "../src/application.js";
import { loadConfig } from "../src/config.js";

const sourceSha256 = "a".repeat(64);
const rules = [{ id: "observe", enabled: true, tier: "T3", field: "text", matchers: [{ type: "contains", value: "spam" }], excludedUsers: [], reason: "Observe" }];
const note = { id: "note-1", userId: "user-1", user: { id: "user-1", host: null }, text: "spam private content" };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function waitForAbort(signal) {
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
function harness({ user = { id: "automod", host: null }, role = "all", runStream, runWorker } = {}) {
  const config = loadConfig({
    MISSKEY_URL: "https://misskey.example", MISSKEY_TOKEN: "token",
    AUTOMOD_BACKEND: role === "all" ? "sqlite" : "postgres", AUTOMOD_ROLE: role,
    AUTOMOD_DATABASE_URL: "postgresql://test:placeholder@localhost/automod",
  });
  const order = [];
  const store = {
    tryApiSlot: mock(async () => 0), blockApi: mock(async () => {}),
    enqueue: mock(async () => ({ inserted: true })),
    stats: mock(async () => ({ pending: 0, running: 0, dead: 0, completed: 0, reviewJobs: 0, purgeJobs: 0, apiRequests: 0, apiBlockedUntil: 0 })),
    close: mock(async () => { order.push("store.closed"); }),
  };
  const logger = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
  const server = { close: mock((callback) => { order.push("health.closed"); callback(); }) };
  const stream = { close: mock(() => { order.push("stream.closed"); }) };
  const worker = {};
  const controller = new AbortController();
  let health;
  const dependencies = {
    store, client: { getMe: mock(async () => user) }, importLegacy: mock(async () => {}),
    createEngine: mock(() => ({ processCase: mock(async () => true) })),
    startHealth: mock(({ state }) => { health = state; return server; }),
    createWorker: mock((options) => {
      worker.run = mock(async (signal) => runWorker ? runWorker(options, signal) : waitForAbort(signal));
      return worker;
    }),
    createStream: mock((options) => {
      stream.run = mock(async (signal) => runStream?.(options, signal));
      return stream;
    }),
  };
  const run = () => runApplication({ config, rules, sourceSha256, logger, signal: controller.signal }, dependencies);
  return { config, run, store, dependencies, order, stream, worker, server, controller, health: () => health };
}

describe("durable application lifecycle", () => {
  test("defaults to standalone durable admission without processing notes inline", async () => {
    const h = harness({ runStream: (options) => { options.onConnectionChange(true); options.onNote(note); } });
    await h.run();
    expect(h.store.enqueue).toHaveBeenCalledWith(expect.objectContaining({ noteId: "note-1", tier: "T3", sourceSha256 }));
    expect(JSON.stringify(h.store.enqueue.mock.calls)).not.toContain("private");
    expect(h.dependencies.createEngine).not.toHaveBeenCalled();
    expect(h.dependencies.createWorker).toHaveBeenCalledWith(expect.objectContaining({ concurrency: 1 }));
    expect(h.health().snapshot().noteProcessing).toEqual(expect.objectContaining({ pending: 0, accepted: 1 }));
    expect(h.stream.close).toHaveBeenCalledTimes(1);
    expect(h.server.close).toHaveBeenCalledTimes(1);
    expect(h.order.at(-1)).toBe("store.closed");
  });

  test("drains pending persistence and closes all resources after stream failure", async () => {
    const queued = deferred();
    const release = deferred();
    const h = harness({ runStream: (options) => {
      options.onNote(note);
      queued.resolve();
      throw new Error("stream failed");
    } });
    h.store.enqueue.mockImplementation(() => release.promise);
    const running = h.run();
    await queued.promise;
    expect(h.store.close).not.toHaveBeenCalled();
    release.resolve({ inserted: true });
    await expect(running).rejects.toThrow("stream failed");
    expect(h.order.at(-1)).toBe("store.closed");
  });

  test("worker-only role never connects to streaming; ingest-only never starts a worker", async () => {
    const consumer = harness({ role: "worker", runWorker: () => {} });
    await consumer.run();
    expect(consumer.dependencies.createStream).not.toHaveBeenCalled();
    expect(consumer.dependencies.createWorker).toHaveBeenCalledTimes(1);
    const producer = harness({ role: "ingest", runStream: (options) => options.onNote(note) });
    await producer.run();
    expect(producer.dependencies.createWorker).not.toHaveBeenCalled();
    expect(producer.store.enqueue).toHaveBeenCalledTimes(1);
  });

  test("closes storage on authentication failure and closes health on socket setup failure", async () => {
    for (const user of [{}, { id: "remote", host: "other.example" }]) {
      const h = harness({ user });
      await expect(h.run()).rejects.toThrow(/authenticated user|local Misskey account/);
      expect(h.dependencies.startHealth).not.toHaveBeenCalled();
      expect(h.store.close).toHaveBeenCalledTimes(1);
    }
    const h = harness();
    h.dependencies.createStream.mockImplementation(() => { throw new Error("socket setup failed"); });
    await expect(h.run()).rejects.toThrow("socket setup failed");
    expect(h.server.close).toHaveBeenCalledTimes(1);
    expect(h.store.close).toHaveBeenCalledTimes(1);
  });

  test("validates enforced T2 configuration before opening the store or contacting Misskey", async () => {
    const h = harness();
    h.config.mode = "enforce";
    const mixedRules = [...rules, { ...rules[0], id: "restrict", tier: "T2" }];
    await expect(runApplication({ config: h.config, rules: mixedRules, sourceSha256 }, h.dependencies)).rejects.toThrow(/T2_ROLE_ID/);
    expect(h.dependencies.client.getMe).not.toHaveBeenCalled();
  });

  test("persistence failure stops intake instead of reporting a successful receipt", async () => {
    const h = harness({ runStream: async (options, signal) => {
      options.onNote(note);
      await waitForAbort(signal);
    } });
    h.store.enqueue.mockRejectedValue(new Error("storage unavailable"));
    const timeout = setTimeout(() => h.controller.abort(), 100);
    try {
      await expect(h.run()).rejects.toThrow(/intake|storage/i);
    } finally {
      clearTimeout(timeout);
      h.controller.abort();
    }
    expect(h.store.close).toHaveBeenCalledTimes(1);
  });
});
