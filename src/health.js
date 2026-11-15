import { createServer } from "node:http";

export class HealthState {
  constructor(mode, role = "all") {
    this.startedAt = new Date().toISOString();
    this.mode = mode;
    this.role = role;
    this.storageConnected = true;
    this.workerRunning = false;
    this.queue = null;
    this.api = null;
    this.streamConnected = false;
    this.rulesLoaded = 0;
    this.lastNoteAt = null;
    this.noteProcessing = null;
  }

  snapshot() {
    return {
      status: this.storageConnected && (this.role === "worker" || this.streamConnected) &&
        (this.role === "ingest" || this.workerRunning) ? "ok" : "degraded",
      mode: this.mode,
      role: this.role,
      storageConnected: this.storageConnected,
      workerRunning: this.workerRunning,
      worker: this.worker ? { ...this.worker } : null,
      queue: this.queue ? { ...this.queue } : null,
      api: this.api ? { ...this.api } : null,
      reputation: this.reputation ? { ...this.reputation } : { enabled: false },
      streamConnected: this.streamConnected,
      rulesLoaded: this.rulesLoaded,
      startedAt: this.startedAt,
      lastNoteAt: this.lastNoteAt,
      noteProcessing: this.noteProcessing ? { ...this.noteProcessing } : null,
    };
  }
}

export function startHealthServer({ host, port, state, logger }) {
  const server = createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const snapshot = state.snapshot();
    response.writeHead(snapshot.status === "ok" ? 200 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(snapshot));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      logger.info("Health endpoint listening", { host, port: server.address().port });
      resolve(server);
    });
  });
}
