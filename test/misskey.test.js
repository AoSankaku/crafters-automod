import { describe, expect, mock, test } from "#test";

import { MisskeyApiClient, MisskeyApiError } from "../src/misskey.js";
import { buildStreamingUrl, MisskeyStream, parseStreamNote } from "../src/stream.js";

describe("MisskeyApiClient", () => {
  test("updates moderation notes through the shared budget and guarded admin endpoint", async () => {
    const order = [];
    const fetchImpl = mock(async () => { order.push("fetch"); return new Response(null, { status: 204 }); });
    const client = new MisskeyApiClient({ baseUrl: "https://misskey.example", token: "token", fetchImpl,
      rateLimiter: { acquire: async () => { order.push("budget"); } } });
    await client.updateUserNote("user-1", "Existing human note\nAutomod log", {
      beforeRequest: async () => { order.push("guard"); },
    });
    expect(order).toEqual(["budget", "guard", "fetch"]);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://misskey.example/api/admin/update-user-note");
    expect(JSON.parse(request.body)).toEqual({ userId: "user-1", text: "Existing human note\nAutomod log" });
  });
  test("uses bearer authentication and the moderator delete endpoint", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 204 }));
    const client = new MisskeyApiClient({
      baseUrl: "https://misskey.example/",
      token: "secret-token",
      fetchImpl,
    });

    await client.deleteNote("note-1");

    expect(fetchImpl).toHaveBeenCalledWith("https://misskey.example/api/notes/delete", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "User-Agent": "crafters-automod/0.1.0",
      },
      body: JSON.stringify({ noteId: "note-1" }),
      signal: expect.any(AbortSignal),
    });
  });

  test("throws a useful API error without exposing the access token", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { code: "ACCESS_DENIED", message: "No" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    const client = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "do-not-leak",
      fetchImpl,
    });

    try {
      await client.deleteNote("note-1");
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MisskeyApiError);
      expect(error.message).toContain("ACCESS_DENIED");
      expect(error.message).not.toContain("do-not-leak");
    }
  });

  test("uses current admin endpoints for user state and role assignment", async () => {
    const fetchImpl = mock(async () => Response.json({ isModerator: false, roleAssigns: [] }));
    const client = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "token",
      fetchImpl,
    });

    await client.showUser("user-1");
    await client.assignRole("user-1", "restricted-role");

    expect(fetchImpl.mock.calls[0][0]).toBe("https://misskey.example/api/admin/show-user");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ userId: "user-1" });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://misskey.example/api/admin/roles/assign");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      userId: "user-1",
      roleId: "restricted-role",
    });
  });

  test("waits for the shared API budget before rechecking authority and fetching", async () => {
    const calls = [];
    let humanDecision = false;
    const rateLimiter = {
      acquire: mock(async (receivedSignal) => {
        calls.push("acquire");
        humanDecision = true;
        expect(receivedSignal).toBe(signal);
      }),
      penalize: mock(async () => undefined),
    };
    const fetchImpl = mock(async () => {
      calls.push("fetch");
      return Response.json({});
    });
    const client = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "token",
      fetchImpl,
      rateLimiter,
    });
    const signal = new AbortController().signal;

    await expect(client.suspendUser("user-1", {
      signal,
      beforeRequest: async () => {
        calls.push("authority");
        if (humanDecision) throw new Error("human decision appeared");
      },
    })).rejects.toThrow("human decision appeared");

    expect(calls).toEqual(["acquire", "authority"]);
    expect(rateLimiter.acquire).toHaveBeenCalledWith(signal);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("applies Retry-After to the shared limiter and never retries a rejected mutation", async () => {
    const rateLimiter = {
      acquire: mock(async () => undefined),
      penalize: mock(async () => undefined),
    };
    const fetchImpl = mock(async () =>
      new Response(JSON.stringify({ error: { code: "SECRETTOKEN", message: "secrettoken body" } }), {
        status: 429,
        headers: { "Retry-After": "3" },
      }),
    );
    const client = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "secrettoken",
      fetchImpl,
      rateLimiter,
    });

    await expect(client.suspendUser("user-1")).rejects.toMatchObject({
      name: "MisskeyApiError",
      status: 429,
      code: null,
      retryAfterMs: 3_000,
      retryable: true,
      cooldownPersisted: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rateLimiter.penalize).toHaveBeenCalledWith("3");
  });

  test("keeps transport and malformed JSON errors from exposing tokens or response bodies", async () => {
    const transportClient = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "secret-token",
      fetchImpl: async () => {
        throw new Error("secret-token remote response body");
      },
    });
    await expect(transportClient.getMe()).rejects.toThrow(/^(?!.*secret-token).*$/u);

    const jsonClient = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "secret-token",
      fetchImpl: async () => new Response("secret-token malformed remote body", { status: 200 }),
    });
    await expect(jsonClient.getMe()).rejects.toThrow(/^(?!.*secret-token).*$/u);
  });

  test("aborts an in-flight request and preserves a lease-loss reason for the queue owner", async () => {
    const controller = new AbortController();
    const leaseLost = Object.assign(new Error("lease expired"), { code: "LEASE_LOST" });
    let requestSignal;
    const fetchImpl = mock((_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const client = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "token",
      fetchImpl,
    });
    const pending = client.getMe({ signal: controller.signal });
    while (!requestSignal) await Promise.resolve();

    controller.abort(leaseLost);

    await expect(pending).rejects.toBe(leaseLost);
    expect(requestSignal.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("passes the shared rate budget through read and mutation methods", async () => {
    const rateLimiter = { acquire: mock(async () => undefined), penalize: mock(async () => undefined) };
    const fetchImpl = mock(async () => Response.json({ isModerator: false, roleAssigns: [] }));
    const client = new MisskeyApiClient({
      baseUrl: "https://misskey.example",
      token: "token",
      fetchImpl,
      rateLimiter,
    });

    await client.getMe();
    await client.showUser("user-1");
    await client.assignRole("user-1", "restricted-role");
    await client.deleteNote("note-1");

    expect(rateLimiter.acquire).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("Misskey stream helpers", () => {
  test("builds an authenticated websocket URL", () => {
    expect(buildStreamingUrl("https://misskey.example/base/", "a+b&c")).toBe(
      "wss://misskey.example/base/streaming?i=a%2Bb%26c",
    );
  });

  test("extracts only note events for the selected channel", () => {
    const payload = JSON.stringify({
      type: "channel",
      body: { id: "local-notes", type: "note", body: note },
    });

    expect(parseStreamNote(payload, "local-notes")).toEqual(note);
    expect(parseStreamNote(payload, "another-channel")).toBeNull();
    expect(parseStreamNote("not json", "local-notes")).toBeNull();
  });

  test("subscribes to localTimeline and forwards note events", async () => {
    const socket = new FakeWebSocket();
    const received = [];
    const controller = new AbortController();
    const stream = new MisskeyStream({
      baseUrl: "https://misskey.example",
      token: "token",
      logger: { info() {}, warn() {} },
      onNote: (incomingNote) => received.push(incomingNote),
      onConnectionChange() {},
      webSocketFactory: () => socket,
    });
    const connection = stream.connectOnce(controller.signal);

    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "channel",
          body: { id: "automod-local-notes", type: "note", body: note },
        }),
      }),
    );
    socket.dispatchEvent(new Event("close"));

    expect(await connection).toBe(true);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "connect",
      body: { channel: "localTimeline", id: "automod-local-notes", params: {} },
    });
    expect(received).toEqual([note]);
  });
});

const note = {
  id: "note-1",
  text: "hello",
  userId: "user-1",
  user: { id: "user-1", username: "alice", host: null },
};

class FakeWebSocket extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }
}
