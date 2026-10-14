import { describe, expect, mock, test } from "bun:test";

import { MisskeyApiClient, MisskeyApiError } from "../src/misskey.js";
import { buildStreamingUrl, MisskeyStream, parseStreamNote } from "../src/stream.js";

describe("MisskeyApiClient", () => {
  test("uses bearer authentication and the moderator delete endpoint", async () => {
    const fetchImpl = mock(async () => new Response("{}", { status: 204 }));
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
