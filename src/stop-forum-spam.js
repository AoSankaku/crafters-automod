import { createHash } from "node:crypto";
import { isIP } from "node:net";

const DEFAULT_ENDPOINT = "https://api.stopforumspam.org/api";
const DEFAULT_INTERVAL_MS = 1_100;
const DEFAULT_DAILY_LIMIT = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_RESPONSE_BYTES = 16_384;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1_000;
const SAFE_CODES = new Set(["INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "RATE_LIMITED", "UNAVAILABLE", "NO_IDENTIFIERS"]);

export class SfsUnavailableError extends Error {
  constructor(code = "UNAVAILABLE", retryAfterMs = null) {
    const safeCode = SAFE_CODES.has(code) ? code : "UNAVAILABLE";
    super(safeCode === "RATE_LIMITED"
      ? "Stop Forum Spam lookup is rate limited."
      : safeCode === "NO_IDENTIFIERS" ? "No eligible reputation identifiers were supplied."
        : "Stop Forum Spam lookup is unavailable.");
    this.name = "SfsUnavailableError";
    this.code = safeCode;
    this.retryAfterMs = Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
    this.retryable = safeCode !== "NO_IDENTIFIERS";
  }
}

/** Read-only, privacy-minimized Stop Forum Spam reputation lookup. */
export class StopForumSpamClient {
  constructor({
    fetchImpl = fetch,
    budget,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxDailyRequests = DEFAULT_DAILY_LIMIT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_RESPONSE_BYTES,
    clock = Date.now,
  } = {}) {
    if (!budget || typeof budget.tryReputationSlot !== "function" || typeof budget.blockReputationApi !== "function") {
      throw new Error("A durable reputation API budget is required.");
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000 ||
        !Number.isSafeInteger(maxDailyRequests) || maxDailyRequests < 1 || maxDailyRequests > 100_000 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
        !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > 16_384 ||
        typeof clock !== "function" || typeof fetchImpl !== "function") {
      throw new Error("Stop Forum Spam client settings are invalid.");
    }
    this.fetchImpl = fetchImpl;
    this.budget = budget;
    this.intervalMs = intervalMs;
    this.maxDailyRequests = maxDailyRequests;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.clock = clock;
  }

  async lookup({ email, ip } = {}, { signal, beforeRequest } = {}) {
    const identifiers = {};
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail) identifiers.email = normalizedEmail;
    if (isPublicIp(ip)) identifiers.ip = ip;
    if (Object.keys(identifiers).length === 0) throw new SfsUnavailableError("NO_IDENTIFIERS");
    throwIfAborted(signal);

    let waitMs;
    try {
      waitMs = await this.budget.tryReputationSlot(this.intervalMs, this.maxDailyRequests);
    } catch {
      throw new SfsUnavailableError();
    }
    throwIfAborted(signal);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new SfsUnavailableError();
    // A busy shared budget must not occupy a worker or flood a provider retry loop.
    if (waitMs > 0) throw new SfsUnavailableError("RATE_LIMITED", waitMs);

    const url = new URL(DEFAULT_ENDPOINT);
    url.searchParams.set("f", "json");
    url.searchParams.set("confidence", "1");
    url.searchParams.set("unix", "1");
    url.searchParams.set("nobadall", "1");
    if (identifiers.email) {
      url.searchParams.set("emailhash", createHash("md5").update(identifiers.email, "utf8").digest("hex"));
    }
    if (identifiers.ip) url.searchParams.set("ip", identifiers.ip);

    throwIfAborted(signal);
    await beforeRequest?.();
    throwIfAborted(signal);

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetchImpl(url, { method: "GET", redirect: "error", signal: requestSignal,
        headers: { Accept: "application/json", "User-Agent": "crafters-automod/0.1.0" } });
    } catch {
      throwIfAborted(signal);
      throw new SfsUnavailableError();
    }
    throwIfAborted(signal);
    if (requestSignal.aborted) throw new SfsUnavailableError();

    if (response.status === 429 || response.status === 503) {
      throw new SfsUnavailableError("RATE_LIMITED", await persistCooldown(this.budget, response, this.clock));
    }
    if (!response.ok) throw new SfsUnavailableError();

    let text;
    try {
      text = await readBoundedBody(response, this.maxResponseBytes, requestSignal);
    } catch (error) {
      if (error?.code === "RESPONSE_TOO_LARGE") throw error;
      throwIfAborted(signal);
      throw new SfsUnavailableError();
    }
    throwIfAborted(signal);
    if (requestSignal.aborted) throw new SfsUnavailableError();

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SfsUnavailableError("INVALID_RESPONSE");
    }
    return parseResponse(payload, identifiers);
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  const separator = email.lastIndexOf("@");
  if (separator < 1 || separator > 64 || separator !== email.indexOf("@")) return null;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) return null;
  return email;
}

/** Only globally routable unicast addresses are eligible for a third-party query. */
export function isPublicIp(value) {
  if (typeof value !== "string" || value.includes("%") || isIP(value) === 0) return false;
  if (isIP(value) === 4) return isPublicIpv4(value);

  const address = value.toLowerCase();
  if (address.startsWith("::ffff:")) return false;
  const first = Number.parseInt(address.split(":", 1)[0] || "0", 16);
  // Global unicast space is 2000::/3. Other ranges include private, link-local,
  // loopback, multicast, and unspecified addresses.
  if (first < 0x2000 || first > 0x3fff) return false;
  const second = Number.parseInt(address.split(":")[1] || "0", 16);
  if ((first === 0x2001 && second <= 0x01ff) ||
      (first === 0x2001 && second === 0x0db8) ||
      (first === 0x3fff && second < 0x1000)) return false;
  if (/^2002:/u.test(address)) return false;
  return true;
}

function isPublicIpv4(value) {
  const octets = value.split(".").map(Number);
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 255) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 31 && c === 196) return false;
  if (a === 192 && b === 52 && c === 193) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 175 && c === 48) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseResponse(payload, identifiers) {
  if (!isPlainObject(payload) || payload.success !== 1) throw new SfsUnavailableError("INVALID_RESPONSE");
  const result = {};
  if (identifiers.email) result.email = parseReputationRecord(payload.emailhash);
  if (identifiers.ip) result.ip = parseReputationRecord(payload.ip, "ip");
  return result;
}

function parseReputationRecord(value) {
  if (!isPlainObject(value) || (value.appears !== 0 && value.appears !== 1) ||
      !Number.isSafeInteger(value.frequency) || value.frequency < 0) {
    throw new SfsUnavailableError("INVALID_RESPONSE");
  }
  const appears = value.appears === 1;
  let confidence = null;
  let lastSeen = null;
  if (value.confidence !== undefined) {
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 100) {
      throw new SfsUnavailableError("INVALID_RESPONSE");
    }
    confidence = value.confidence;
  } else if (appears) {
    throw new SfsUnavailableError("INVALID_RESPONSE");
  }
  if (value.lastseen !== undefined) {
    if (!Number.isSafeInteger(value.lastseen) || value.lastseen < 0) throw new SfsUnavailableError("INVALID_RESPONSE");
    lastSeen = value.lastseen;
  } else if (appears) {
    throw new SfsUnavailableError("INVALID_RESPONSE");
  }
  // Avoid retaining provider-supplied identifiers or other response fields.
  return { appears, frequency: value.frequency, confidence, lastSeen };
}

async function readBoundedBody(response, limit, signal) {
  if (!response.body) throw new SfsUnavailableError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let onAbort;
  const aborted = signal ? new Promise((_, reject) => {
    onAbort = () => {
      void reader.cancel().catch(() => {});
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }) : null;
  try {
    while (true) {
      throwIfAborted(signal);
      const read = reader.read();
      const { done, value } = await (aborted ? Promise.race([read, aborted]) : read);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new SfsUnavailableError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  try {
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SfsUnavailableError("INVALID_RESPONSE");
  }
}

async function persistCooldown(budget, response, clock) {
  const retryAfterMs = parseRetryAfter(response.headers?.get?.("Retry-After"), clock());
  try {
    await budget.blockReputationApi(retryAfterMs);
  } catch {
    throw new SfsUnavailableError();
  }
  return retryAfterMs;
}

function parseRetryAfter(value, now) {
  if (typeof value !== "string" || !value.trim()) return 60_000;
  const header = value.trim();
  let delay;
  if (/^\d+(?:\.\d+)?$/u.test(header)) delay = Number(header) * 1_000;
  else {
    const timestamp = Date.parse(header);
    delay = Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 60_000;
  }
  if (!Number.isFinite(delay)) return MAX_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(delay)));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason?.code === "LEASE_LOST" || reason?.name === "LeaseLostError") throw reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
