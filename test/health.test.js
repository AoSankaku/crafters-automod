import { describe, expect, mock, test } from "#test";
import { createServer } from "node:http";

import { HealthState, startHealthServer } from "../src/health.js";

describe("health lifecycle", () => {
  test("reports startup failures through the returned promise", async () => {
    const occupied = createServer();
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    try {
      await expect(startHealthServer({
        host: "127.0.0.1", port: occupied.address().port,
        state: new HealthState("dry-run"), logger: { info() {} },
      })).rejects.toThrow();
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
  });

  test("waits for listening and exposes processing metrics with connection status", async () => {
    const state = new HealthState("dry-run");
    state.noteProcessing = { pending: 1, capacity: 2, rejected: 3, failed: 4 };
    const server = await startHealthServer({ host: "127.0.0.1", port: 0, state, logger: { info: mock(() => {}) } });
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const disconnected = await fetch(`${url}/health`);
      expect(disconnected.status).toBe(503);
      expect(await disconnected.json()).toEqual(expect.objectContaining({ noteProcessing: state.noteProcessing }));
      state.streamConnected = true;
      state.workerRunning = true;
      const connected = await fetch(`${url}/health`);
      expect(connected.status).toBe(200);
      expect(connected.headers.get("cache-control")).toBe("no-store");
      expect((await fetch(`${url}/missing`)).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("worker health uses storage and worker state without requiring a streaming socket", () => {
    const state = new HealthState("dry-run", "worker");
    state.workerRunning = true;
    expect(state.snapshot().status).toBe("ok");
    state.storageConnected = false;
    expect(state.snapshot().status).toBe("degraded");
    const ingest = new HealthState("dry-run", "ingest");
    ingest.streamConnected = true;
    expect(ingest.snapshot().status).toBe("ok");
  });
});
