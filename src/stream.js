const CHANNEL_ID = "automod-local-notes";

export function buildStreamingUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/streaming`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("i", token);
  return url.toString();
}

export function parseStreamNote(data, channelId = CHANNEL_ID) {
  try {
    const message = typeof data === "string" ? JSON.parse(data) : JSON.parse(String(data));
    if (
      message?.type !== "channel" ||
      message.body?.id !== channelId ||
      message.body?.type !== "note" ||
      !message.body?.body?.id
    ) {
      return null;
    }
    return message.body.body;
  } catch {
    return null;
  }
}

export function reconnectDelay(attempt, random = Math.random) {
  const exponential = Math.min(1_000 * 2 ** attempt, 30_000);
  return Math.round(exponential * (0.8 + random() * 0.4));
}

export class MisskeyStream {
  constructor({ baseUrl, token, logger, onNote, onConnectionChange, webSocketFactory }) {
    this.url = buildStreamingUrl(baseUrl, token);
    this.logger = logger;
    this.onNote = onNote;
    this.onConnectionChange = onConnectionChange;
    this.webSocketFactory = webSocketFactory ?? ((url) => new WebSocket(url));
    this.socket = null;
  }

  async run(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      const connected = await this.connectOnce(signal);
      if (signal.aborted) break;
      attempt = connected ? 0 : attempt + 1;
      const delay = reconnectDelay(attempt);
      this.logger.warn("Misskey stream disconnected; reconnecting", { delayMs: delay });
      await wait(delay, signal);
    }
  }

  connectOnce(signal) {
    return new Promise((resolve) => {
      let opened = false;
      let settled = false;
      const socket = this.webSocketFactory(this.url);
      this.socket = socket;

      const finish = () => {
        if (settled) return;
        settled = true;
        this.onConnectionChange(false);
        signal.removeEventListener("abort", abort);
        resolve(opened);
      };
      const abort = () => {
        try {
          socket.close(1000, "shutdown");
        } finally {
          finish();
        }
      };

      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => {
        opened = true;
        this.onConnectionChange(true);
        socket.send(
          JSON.stringify({
            type: "connect",
            body: { channel: "localTimeline", id: CHANNEL_ID, params: {} },
          }),
        );
        this.logger.info("Connected to Misskey local timeline");
      });
      socket.addEventListener("message", (event) => {
        const note = parseStreamNote(event.data);
        if (note) this.onNote(note);
      });
      socket.addEventListener("error", () => {
        this.logger.warn("Misskey websocket error");
      });
      socket.addEventListener("close", finish);
    });
  }

  close() {
    this.socket?.close(1000, "shutdown");
  }
}

function wait(delayMs, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
