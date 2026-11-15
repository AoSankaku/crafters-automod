import { describe, expect, mock, test } from "bun:test";
import { StopForumSpamClient, SfsUnavailableError, isPublicIp } from "../src/stop-forum-spam.js";

const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const clean = { success: 1, emailhash: { appears: 0, frequency: 0 }, ip: { appears: 0, frequency: 0 } };
function setup({ result = clean, budget = {}, fetchImpl: customFetch, ...options } = {}) {
  const seen = [];
  const fetchImpl = customFetch ?? mock(async (url, init) => {
    seen.push([url, init]);
    if (typeof result === "function") return result(url, init);
    return result instanceof Response ? result : response(result);
  });
  const budgetStore = { tryReputationSlot: mock(async () => 0), blockReputationApi: mock(async () => {}), ...budget };
  const client = new StopForumSpamClient({ fetchImpl, budget: budgetStore, ...options });
  return { client, fetchImpl, seen, budgetStore };
}

describe("StopForumSpamClient", () => {
  test("looks up a normalized email only as an MD5 hash and requests aggregate confidence", async () => {
    const h = setup();
    const result = await h.client.lookup({ email: "  Alice.Example@example.invalid " });
    const [url, init] = h.seen[0];
    const parsed = new URL(url);
    expect(result).toEqual({ email: { appears: false, frequency: 0, confidence: null, lastSeen: null } });
    expect(parsed.origin + parsed.pathname).toBe("https://api.stopforumspam.org/api");
    expect(parsed.searchParams.get("emailhash")).toBe("79f72ca0f389199e7a4a1ea8709a9bd6");
    expect(parsed.searchParams.get("email")).toBeNull();
    expect(parsed.searchParams.get("f")).toBe("json");
    expect(parsed.searchParams.get("confidence")).toBe("1");
    expect(parsed.searchParams.get("unix")).toBe("1");
    expect(parsed.searchParams.get("nobadall")).toBe("1");
    expect(init).toEqual(expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(JSON.stringify([url, result])).not.toContain("Alice.Example");
  });

  test("queries only syntactically valid bounded email and public IP identifiers", async () => {
    const h = setup();
    await expect(h.client.lookup({ email: "not an address", ip: "127.0.0.1" }))
      .rejects.toMatchObject({ code: "NO_IDENTIFIERS" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.budgetStore.tryReputationSlot).not.toHaveBeenCalled();
    expect(await h.client.lookup({ email: `${"a".repeat(246)}@example.invalid`, ip: "8.8.8.8" })).toEqual({
      ip: { appears: false, frequency: 0, confidence: null, lastSeen: null },
    });
    expect(new URL(h.seen[0][0]).searchParams.get("ip")).toBe("8.8.8.8");
  });

  test("filters private, reserved, documentation, and malformed IPs", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.1.2", "192.168.1.1", "169.254.2.3", "100.64.1.1", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.175.48.1", "198.51.100.3", "203.0.113.4", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "2001:1::1", "3fff:1::1", "2001:4860:4860::8888%eth0", "bad-ip"]) {
      expect(isPublicIp(ip)).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicIp(ip)).toBe(true);
  });

  test("combines valid email hash and public IP in one request", async () => {
    const h = setup({ result: { success: 1,
      emailhash: { appears: 1, frequency: 4, confidence: 80.5, lastseen: 1760000000 },
      ip: { appears: 0, frequency: 0 } } });
    expect(await h.client.lookup({ email: "a@example.invalid", ip: "8.8.8.8" })).toEqual({
      email: { appears: true, frequency: 4, confidence: 80.5, lastSeen: 1760000000 },
      ip: { appears: false, frequency: 0, confidence: null, lastSeen: null },
    });
    const url = new URL(h.seen[0][0]);
    expect(url.searchParams.has("emailhash")).toBe(true);
    expect(url.searchParams.get("ip")).toBe("8.8.8.8");
  });

  test("does not call the provider or spend budget with no valid identifiers", async () => {
    const h = setup();
    await expect(h.client.lookup({ email: "", ip: "192.0.2.2" })).rejects.toMatchObject({ code: "NO_IDENTIFIERS" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.budgetStore.tryReputationSlot).not.toHaveBeenCalled();
  });

  test("rejects an exhausted shared budget without sleeping or making a request", async () => {
    const h = setup({ budget: { tryReputationSlot: mock(async (interval, maximum) => { expect([interval, maximum]).toEqual([1_100, 5_000]); return 250; }) } });
    await expect(h.client.lookup({ email: "a@example.invalid" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  test("applies the shared budget and final authority guard before the network request", async () => {
    const events = [];
    const h = setup({ budget: { tryReputationSlot: mock(async () => { events.push("budget"); return 0; }) } });
    await h.client.lookup({ email: "a@example.invalid" }, { beforeRequest: async () => events.push("guard") });
    expect(events).toEqual(["budget", "guard"]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("propagates lease and human guard failures unchanged without fetching", async () => {
    const h = setup();
    const lease = Object.assign(new Error("lease-lost"), { code: "LEASE_LOST" });
    await expect(h.client.lookup({ email: "a@example.invalid" }, { beforeRequest: () => { throw lease; } })).rejects.toBe(lease);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  test("validates response shape and numeric bounds without exposing provider text", async () => {
    for (const result of [null, {}, { success: 0, error: "private provider text" },
      { success: 1, email: { appears: 2, frequency: -1 } },
      { success: 1, emailhash: { appears: 1, frequency: 2, confidence: 100.1 } },
      { success: 1, emailhash: { appears: 1, frequency: 2, lastseen: "not-a-time" } }]) {
      const h = setup({ result: response(result) });
      await expect(h.client.lookup({ email: "a@example.invalid" })).rejects.toBeInstanceOf(SfsUnavailableError);
    }
    const h = setup({ result: response({ success: 1, emailhash: { appears: 1, frequency: 3 } }) });
    await expect(h.client.lookup({ email: "a@example.invalid" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("limits response bytes even when Content-Length is missing", async () => {
    const body = "{" + " ".repeat(2_000) + "}";
    const h = setup({ result: new Response(body) , maxResponseBytes: 1024 });
    await expect(h.client.lookup({ email: "a@example.invalid" })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("persists bounded shared cooldown on 429 and never returns a clean result", async () => {
    const h = setup({ result: response({ detail: "private" }, 429, { "Retry-After": "7200" }), clock: () => 1000 });
    await expect(h.client.lookup({ ip: "8.8.8.8" })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 3_600_000 });
    expect(h.budgetStore.blockReputationApi).toHaveBeenCalledWith(3_600_000);
  });

  test("persists shared cooldown for any 503 response without inspecting its body", async () => {
    const withHeader = setup({ result: response({ detail: "private provider text" }, 503, { "Retry-After": "30" }), clock: () => 1000 });
    await expect(withHeader.client.lookup({ ip: "8.8.8.8" })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 30_000 });
    expect(withHeader.budgetStore.blockReputationApi).toHaveBeenCalledWith(30_000);

    const withoutHeader = setup({ result: response({ arbitrary: "body" }, 503) });
    await expect(withoutHeader.client.lookup({ ip: "8.8.8.8" })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 60_000 });
    expect(withoutHeader.budgetStore.blockReputationApi).toHaveBeenCalledWith(60_000);
  });

  test("bounds a stalled response body by the request timeout and cancels its reader", async () => {
    let streamController;
    let canceled = false;
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('{"success":1'));
      },
      cancel() { canceled = true; },
    });
    const h = setup({ result: () => new Response(body), timeoutMs: 10 });
    const lookup = h.client.lookup({ email: "a@example.invalid" });
    let deadline;
    const outcome = await Promise.race([
      lookup.then(() => "resolved", (error) => error.code),
      new Promise((resolve) => { deadline = setTimeout(() => resolve("stalled"), 100); }),
    ]);
    clearTimeout(deadline);
    try { streamController.close(); } catch { /* The request timeout may already cancel the stream. */ }
    await lookup.catch(() => {});
    expect(outcome).toBe("UNAVAILABLE");
    expect(canceled).toBe(true);
  });

  test("fails closed on timeout, transport, 5xx and cooldown persistence errors", async () => {
    const transport = setup({ fetchImpl: async () => { throw new Error("private-address"); } });
    await expect(transport.client.lookup({ email: "a@example.invalid" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const timeout = setup({ timeoutMs: 2, fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }) });
    await expect(timeout.client.lookup({ email: "private@example.invalid" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const upstream = setup({ result: response({ private: "body" }, 503) });
    await expect(upstream.client.lookup({ email: "a@example.invalid" })).rejects.toBeInstanceOf(SfsUnavailableError);
    const failedCooldown = setup({ result: response({}, 429), budget: { blockReputationApi: async () => { throw new Error("secret"); } } });
    await expect(failedCooldown.client.lookup({ email: "a@example.invalid" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    try {
      await upstream.client.lookup({ email: "private@example.invalid" });
    } catch (error) {
      expect(error.message).not.toContain("private@example.invalid");
      expect(error.message).not.toContain("body");
    }
  });
});
