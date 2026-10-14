const DEFAULT_MAX_RETRY_AFTER_MS = 60 * 60 * 1_000;

/** Shares a durable API request budget across every worker using the same store. */
export class DurableApiLimiter {
  constructor({
    store,
    intervalMs,
    sleep = abortableSleep,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    clock = Date.now,
  }) {
    if (!store || typeof store.tryApiSlot !== "function" || typeof store.blockApi !== "function") {
      throw new Error("A durable API budget store is required.");
    }
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error("API request interval must be a non-negative number.");
    }
    if (!Number.isFinite(maxRetryAfterMs) || maxRetryAfterMs < 0) {
      throw new Error("Maximum Retry-After must be a non-negative number.");
    }

    this.store = store;
    this.intervalMs = intervalMs;
    this.sleep = sleep;
    this.maxRetryAfterMs = maxRetryAfterMs;
    this.clock = clock;
    this.acquired = 0;
    this.waits = 0;
    this.lastWaitMs = 0;
  }

  async acquire(signal) {
    while (true) {
      throwIfAborted(signal);
      const waitMs = await this.store.tryApiSlot(this.intervalMs);
      throwIfAborted(signal);
      if (!Number.isFinite(waitMs) || waitMs < 0) {
        throw new Error("Durable API budget returned an invalid wait duration.");
      }
      if (waitMs === 0) {
        this.acquired += 1;
        return;
      }

      this.waits += 1;
      this.lastWaitMs = waitMs;
      await this.sleep(waitMs, signal);
    }
  }

  async penalize(retryAfterHeader, fallbackMs = 1_000) {
    const parsed = parseRetryAfter(retryAfterHeader, this.clock());
    const fallback = Number.isFinite(fallbackMs) && fallbackMs >= 0 ? fallbackMs : 1_000;
    const waitMs = Math.min(this.maxRetryAfterMs, parsed ?? fallback);
    await this.store.blockApi(waitMs);
    return waitMs;
  }

  snapshot() {
    return { acquired: this.acquired, waits: this.waits, lastWaitMs: this.lastWaitMs };
  }
}

export function abortableSleep(waitMs, signal) {
  throwIfAborted(signal);
  if (waitMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal));
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
  const reason = signal.reason;
  if (reason?.code === "LEASE_LOST" || reason?.name === "LeaseLostError") return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function parseRetryAfter(header, now) {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (!value) return null;

  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return Number.POSITIVE_INFINITY;
    const milliseconds = seconds * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : Number.POSITIVE_INFINITY;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}
