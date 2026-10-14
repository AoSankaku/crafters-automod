const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_BYTES = 4_096;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1_000;

export class MisskeyApiError extends Error {
  constructor(endpoint, status, code, { retryAfterMs = null, cooldownPersisted = true } = {}) {
    const safeEndpoint = sanitizeEndpoint(endpoint);
    const safeCode = sanitizeApiCode(code);
    const safeStatus = Number.isInteger(status) ? status : 0;
    const cooldownNote = cooldownPersisted === false ? ", shared cooldown persistence failed" : "";
    super(`Misskey API ${safeEndpoint} failed (${safeStatus}${safeCode ? `, ${safeCode}` : ""}${cooldownNote}).`);
    this.name = "MisskeyApiError";
    this.endpoint = safeEndpoint;
    this.status = safeStatus;
    this.code = safeCode;
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
    this.retryable = safeStatus === 408 || safeStatus === 429 || safeStatus >= 500;
    this.cooldownPersisted = cooldownPersisted;
  }
}

export class MisskeyApiClient {
  constructor({ baseUrl, token, fetchImpl = fetch, rateLimiter }) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.rateLimiter = rateLimiter;
  }

  getMe(options) {
    return this.request("i", {}, options);
  }

  deleteNote(noteId, options) {
    return this.request("notes/delete", { noteId }, options);
  }

  suspendUser(userId, options) {
    return this.request("admin/suspend-user", { userId }, options);
  }

  showUser(userId, options) {
    return this.request("admin/show-user", { userId }, options);
  }

  assignRole(userId, roleId, options) {
    return this.request("admin/roles/assign", { userId, roleId }, options);
  }

  async request(endpoint, body, { signal, beforeRequest } = {}) {
    await this.rateLimiter?.acquire(signal);
    throwIfAborted(signal, endpoint);

    const requestSignal = createRequestSignal(signal);
    const request = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "crafters-automod/0.1.0",
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    };

    // The authority check must run after any shared-budget wait and directly before fetch.
    await beforeRequest?.();
    throwIfAborted(signal, endpoint);

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/${endpoint}`, request);
    } catch {
      if (requestSignal.aborted) throw abortError(requestSignal, endpoint);
      const error = new Error(`Misskey API ${sanitizeEndpoint(endpoint)} request failed.`);
      error.name = "MisskeyTransportError";
      error.retryable = true;
      throw error;
    }
    throwIfAborted(requestSignal, endpoint);

    if (!response.ok) {
      const code = await readSafeErrorCode(response, this.token, requestSignal, endpoint);
      let retryAfterMs = null;
      let cooldownPersisted = null;
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        retryAfterMs = retryAfterDuration(retryAfter) ?? 1_000;
        if (this.rateLimiter) {
          cooldownPersisted = false;
          try {
            const applied = await this.rateLimiter.penalize(retryAfter);
            if (Number.isFinite(applied) && applied >= 0) retryAfterMs = applied;
            cooldownPersisted = true;
          } catch {
            // Keep the safe 429 error, but expose that the shared cooldown could not be persisted.
          }
        }
      }
      throwIfAborted(requestSignal, endpoint);
      throw new MisskeyApiError(endpoint, response.status, code, { retryAfterMs, cooldownPersisted });
    }

    if (response.status === 204) return undefined;
    let text;
    try {
      text = await response.text();
    } catch {
      if (requestSignal.aborted) throw abortError(requestSignal, endpoint);
      throw new MisskeyApiError(endpoint, response.status, "INVALID_RESPONSE");
    }
    throwIfAborted(requestSignal, endpoint);
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new MisskeyApiError(endpoint, response.status, "INVALID_JSON");
    }
  }
}

function createRequestSignal(callerSignal) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function throwIfAborted(signal, endpoint) {
  if (signal?.aborted) throw abortError(signal, endpoint);
}

function abortError(signal, endpoint) {
  const reason = signal?.reason;
  if (reason?.code === "LEASE_LOST" || reason?.name === "LeaseLostError") return reason;
  return createAbortError(endpoint);
}

function createAbortError(endpoint) {
  const error = new Error(`Misskey API ${sanitizeEndpoint(endpoint)} request was aborted.`);
  error.name = "AbortError";
  return error;
}

function sanitizeEndpoint(endpoint) {
  return typeof endpoint === "string" ? endpoint.replace(/[^A-Za-z0-9/_-]/gu, "").slice(0, 80) : "unknown";
}

function sanitizeApiCode(code, token) {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return null;
  if (typeof token === "string" && token && code.toLowerCase().includes(token.toLowerCase())) return null;
  return code;
}

async function readSafeErrorCode(response, token, signal, endpoint) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BODY_BYTES - size;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        await reader.cancel();
        break;
      }
    }
    if (size === MAX_ERROR_BODY_BYTES) await reader.cancel();
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Error bodies are optional diagnostics and never affect API error reporting.
    }
    if (signal?.aborted) throw abortError(signal, endpoint);
    return null;
  } finally {
    reader.releaseLock();
  }

  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return sanitizeApiCode(parsed?.error?.code, token);
  } catch {
    return null;
  }
}

function retryAfterDuration(header) {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Math.min(MAX_RETRY_AFTER_MS, Number.isFinite(milliseconds) ? milliseconds : MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now())) : null;
}
