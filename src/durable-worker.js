import { randomUUID } from "node:crypto";

export class DurableWorker {
  constructor({ store, handle, workerId = randomUUID(), leaseMs = 60_000, concurrency = 1,
    pollMs = 250, retryBaseMs = 1_000, retryMaxMs = 60_000, logger, onStateChange = () => {} }) {
    this.store = store;
    this.handle = handle;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.concurrency = concurrency;
    this.pollMs = pollMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.active = 0;
    this.processed = 0;
    this.failed = 0;
    this.leaseLost = 0;
  }

  async run(signal) {
    await Promise.all(Array.from({ length: this.concurrency }, async () => {
      while (!signal.aborted) {
        if (!await this.processOne(signal)) await wait(this.pollMs, signal);
      }
    }));
  }

  async processOne(parentSignal = new AbortController().signal) {
    if (parentSignal.aborted) return false;
    const claim = await this.store.claim({ workerId: this.workerId, leaseMs: this.leaseMs });
    if (!claim) return false;
    const controller = new AbortController();
    let lost = false;
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) abort();
    let renewing = false;
    let renewal = Promise.resolve();
    const heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      renewal = this.store.renew(claim, this.leaseMs)
        .then((renewed) => { if (!renewed) loseLease(); })
        .catch(() => loseLease())
        .finally(() => { renewing = false; });
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    const loseLease = () => {
      lost = true;
      controller.abort(leaseError());
    };
    const assertActive = async () => {
      if (lost) throw leaseError();
      controller.signal.throwIfAborted();
      await this.store.assertLease(claim);
      controller.signal.throwIfAborted();
    };
    this.active += 1;
    this.onStateChange(this.snapshot());
    try {
      await assertActive();
      const result = await this.handle(claim.payload, { claim, assertActive, signal: controller.signal });
      if (result === false) throw Object.assign(new Error("Moderation action did not complete."), { code: "MODERATION_FAILED" });
      await renewal;
      await assertActive();
      if (!await this.store.complete(claim)) throw leaseError();
      this.processed += 1;
    } catch (error) {
      if (lost || error?.code === "LEASE_LOST" || parentSignal.aborted) {
        this.leaseLost += 1;
      } else {
        const code = /^[A-Z0-9_]{1,64}$/u.test(error?.code ?? "") ? error.code : "PROCESSING_FAILED";
        const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(claim.attempts - 1, 20));
        const delayMs = Math.min(this.retryMaxMs, Math.max(backoff, Number(error?.retryAfterMs) || 0));
        try {
          await this.store.fail(claim, { code, delayMs, permanent: error?.permanent === true });
          this.failed += 1;
          this.logger.warn("Durable case processing failed", { noteId: claim.noteId, code, attempts: claim.attempts });
        } catch (failure) {
          if (failure?.code !== "LEASE_LOST") throw failure;
          this.leaseLost += 1;
        }
      }
    } finally {
      clearInterval(heartbeat);
      await renewal;
      parentSignal.removeEventListener("abort", abort);
      this.active -= 1;
      this.onStateChange(this.snapshot());
    }
    return true;
  }

  snapshot() {
    return { active: this.active, processed: this.processed, failed: this.failed, leaseLost: this.leaseLost };
  }
}

function leaseError() {
  return Object.assign(new Error("The work lease is no longer active."), { code: "LEASE_LOST" });
}

function wait(delayMs, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
