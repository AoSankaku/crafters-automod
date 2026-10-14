import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
export { FileHumanAuthority } from "./human-authority.js";

export class JsonlAuditLedger {
  constructor(path, { append = appendFile } = {}) {
    this.path = path;
    this.append = append;
    this.processedNoteIds = new Set();
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    const events = await readJsonLines(this.path);
    for (const event of events) {
      if (event.type === "case.completed" && typeof event.noteId === "string") {
        this.processedNoteIds.add(event.noteId);
      }
    }
  }

  hasProcessed(noteId) {
    return this.processedNoteIds.has(noteId);
  }

  record(event) {
    const operation = this.writeChain.then(() => this.append(this.path, `${JSON.stringify(event)}\n`, "utf8"));
    this.writeChain = operation.catch(() => undefined);
    return operation.then(() => {
      if (event.type === "case.completed") this.processedNoteIds.add(event.noteId);
    });
  }
}

export class JsonlJobQueue {
  constructor(path, { append = appendFile, maxJobs = Number.POSITIVE_INFINITY } = {}) {
    this.path = path;
    this.append = append;
    this.maxJobs = maxJobs;
    this.knownJobs = new Set();
    this.pendingJobs = new Map();
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    const jobs = await readJsonLines(this.path);
    for (const job of jobs) this.knownJobs.add(jobKey(job));
    if (this.knownJobs.size > this.maxJobs) {
      throw new Error(`Durable queue exceeds its configured queue capacity of ${this.maxJobs}.`);
    }
  }

  enqueue(job) {
    const key = jobKey(job);
    if (this.knownJobs.has(key)) return Promise.resolve();
    if (this.pendingJobs.has(key)) return this.pendingJobs.get(key);
    if (this.knownJobs.size + this.pendingJobs.size >= this.maxJobs) {
      return Promise.reject(new Error(`Durable queue capacity of ${this.maxJobs} has been reached.`));
    }
    const queuedJob = {
      ...job,
      queuedAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + (job.delayMs ?? 0)).toISOString(),
    };
    const operation = this.writeChain.then(() =>
      this.append(this.path, `${JSON.stringify(queuedJob)}\n`, "utf8"),
    );
    this.writeChain = operation.catch(() => undefined);
    const completion = operation
      .then(() => this.knownJobs.add(key))
      .finally(() => this.pendingJobs.delete(key));
    this.pendingJobs.set(key, completion);
    return completion;
  }
}

async function readJsonLines(path) {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function jobKey(job) {
  return `${job.caseId}:${job.userId}`;
}
