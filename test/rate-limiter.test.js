import { describe, expect, mock, test } from "bun:test";

import { DurableApiLimiter } from "../src/rate-limiter.js";

describe("DurableApiLimiter", () => {
  test("waits outside the store transaction and retries the shared slot", async () => {
    const calls = [];
    const store = {
      tryApiSlot: mock(async (intervalMs) => {
        calls.push(["slot", intervalMs]);
        return calls.filter(([kind]) => kind === "slot").length === 1 ? 125 : 0;
      }),
      blockApi: mock(async () => undefined),
    };
    const sleep = mock(async (waitMs, signal) => calls.push(["sleep", waitMs, signal]));
    const signal = new AbortController().signal;
    const limiter = new DurableApiLimiter({ store, intervalMs: 500, sleep });

    await limiter.acquire(signal);

    expect(calls).toEqual([["slot", 500], ["sleep", 125, signal], ["slot", 500]]);
    expect(store.tryApiSlot).toHaveBeenCalledTimes(2);
  });

  test("aborts while waiting instead of taking a later API slot", async () => {
    const controller = new AbortController();
    const store = {
      tryApiSlot: mock(async () => 10_000),
      blockApi: mock(async () => undefined),
    };
    const sleep = (_waitMs, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
    const limiter = new DurableApiLimiter({ store, intervalMs: 100, sleep });
    const pending = limiter.acquire(controller.signal);
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(store.tryApiSlot).toHaveBeenCalledTimes(1);
  });

  test("parses Retry-After and clamps the shared cooldown", async () => {
    const store = {
      tryApiSlot: mock(async () => 0),
      blockApi: mock(async () => undefined),
    };
    const now = Date.parse("2026-10-15T00:00:00.000Z");
    const limiter = new DurableApiLimiter({
      store,
      intervalMs: 100,
      maxRetryAfterMs: 2_000,
      clock: () => now,
    });

    await limiter.penalize("120");
    await limiter.penalize(new Date(now + 500).toUTCString());
    await limiter.penalize("not-a-date", 750);

    expect(store.blockApi.mock.calls.map(([delay]) => delay)).toEqual([2_000, 500, 750]);
  });
});
