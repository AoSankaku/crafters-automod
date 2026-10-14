import { describe, expect, mock, test } from "bun:test";
import { DurableWorker } from "../src/durable-worker.js";

const claim = { id: "note-1", noteId: "note-1", userId: "user-1", token: "lease-1", attempts: 1, payload: { noteId: "note-1" } };
function harness(handle = async () => true, options = {}) {
  const store = {
    claim: mock(async () => claim), assertLease: mock(async () => {}), renew: mock(async () => true),
    complete: mock(async () => true), fail: mock(async () => "pending"),
  };
  const logger = { error: mock(() => {}), warn: mock(() => {}) };
  const worker = new DurableWorker({ store, handle, workerId: "worker-1", leaseMs: 60_000, pollMs: 10, retryBaseMs: 1_000, retryMaxMs: 60_000, logger, ...options });
  return { store, worker, logger };
}

describe("durable worker", () => {
  test("acknowledges only after successful handling with a live lease", async () => {
    let execution;
    const handle = mock(async (payload, context) => { execution = context; await context.assertActive(); return true; });
    const { store, worker } = harness(handle);
    expect(await worker.processOne()).toBe(true);
    expect(handle).toHaveBeenCalledWith(claim.payload, expect.objectContaining({ claim }));
    expect(execution.signal).toBeInstanceOf(AbortSignal);
    expect(store.assertLease).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledWith(claim);
    expect(store.fail).not.toHaveBeenCalled();
  });

  test("schedules bounded backoff and honors API retry delay", async () => {
    const error = Object.assign(new Error("temporarily unavailable"), { code: "API_UNAVAILABLE", retryAfterMs: 4_000 });
    const { store, worker } = harness(async () => { throw error; });
    await worker.processOne();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(claim, { code: "API_UNAVAILABLE", delayMs: 4_000, permanent: false });
  });

  test("invalid work becomes dead without repeated processing", async () => {
    const error = Object.assign(new Error("policy mismatch"), { code: "POLICY_MISMATCH", permanent: true });
    const { store, worker } = harness(async () => { throw error; });
    await worker.processOne();
    expect(store.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ code: "POLICY_MISMATCH", permanent: true }));
  });

  test("a stale worker cannot acknowledge or fail a reclaimed job", async () => {
    const error = Object.assign(new Error("lease expired"), { code: "LEASE_LOST" });
    const { store, worker } = harness(async (_, context) => context.assertActive());
    store.assertLease.mockRejectedValue(error);
    await worker.processOne();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });

  test("lease renewal failure aborts in-flight work", async () => {
    const { store, worker } = harness(async (_, context) => {
      await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      await context.assertActive();
    }, { leaseMs: 90 });
    store.renew.mockResolvedValue(false);
    await worker.processOne();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });

  test("shutdown stops claiming new work", async () => {
    const { store, worker } = harness();
    const controller = new AbortController();
    controller.abort();
    await worker.run(controller.signal);
    expect(store.claim).not.toHaveBeenCalled();
  });
});
