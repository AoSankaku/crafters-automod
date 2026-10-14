import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const MAX_JSONL_LINE_BYTES = 64 * 1024;
const MAX_OVERRIDE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_OVERRIDE_IDS = 100_000;
const READ_CHUNK_BYTES = 16 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/u;
const AUDIT_ACTORS = new Set(["deterministic", "llm", "human"]);
const AUDIT_FIELDS = new Set([
  "type", "timestamp", "actor", "caseId", "noteId", "userId", "tier", "ruleIds", "reasons",
  "mode", "reason", "outcome", "error", "scope", "id", "username",
]);
const JOB_FIELDS = Object.freeze({
  review: new Set(["caseId", "noteId", "userId", "tier", "ruleIds", "delayMs", "queuedAt", "dueAt"]),
  purge: new Set(["caseId", "userId", "queuedAt", "dueAt"]),
});
const LEGACY_FILES = Object.freeze([
  { name: "audit.jsonl", kind: "audit" },
  { name: "llm-review-queue.jsonl", kind: "review" },
  { name: "t1-purge-queue.jsonl", kind: "purge" },
]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function importLegacyJsonl(store, directory) {
  if (!store || typeof store.importLegacyRecord !== "function" ||
      typeof store.hasImport !== "function" || typeof store.markImport !== "function") {
    throw new Error("Legacy import store is invalid.");
  }
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("Legacy import directory is invalid.");
  }

  const imported = { audit: 0, review: 0, purge: 0, skippedFiles: 0 };
  for (const { name, kind } of LEGACY_FILES) {
    const path = join(directory, name);
    let before;
    try {
      before = await stat(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Legacy JSONL file ${name} could not be inspected.`);
    }
    if (!before.isFile()) throw new Error(`Legacy JSONL file ${name} is not a regular file.`);

    const fingerprint = fileFingerprint(name, before);
    let complete;
    try {
      complete = await store.hasImport(fingerprint);
    } catch {
      throw new Error("Legacy import state could not be read.");
    }
    if (complete) {
      imported.skippedFiles += 1;
      continue;
    }

    try {
      for await (const { lineNumber, bytes } of readBoundedLines(path, name)) {
        if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 13)) continue;
        const value = parseAndValidateLine(bytes, name, lineNumber, kind);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const key = `${kind}:${lineNumber}:${digest}`;
        const result = await store.importLegacyRecord(kind, value, key);
        if (result?.imported) imported[kind] += 1;
      }
    } catch (error) {
      if (error instanceof LegacyImportError) throw error;
      throw new Error(`Legacy JSONL file ${name} could not be imported safely.`);
    }

    let after;
    try {
      after = await stat(path);
    } catch {
      throw new Error(`Legacy JSONL file ${name} changed during import.`);
    }
    if (!sameFileSnapshot(before, after)) {
      throw new Error(`Legacy JSONL file ${name} changed during import.`);
    }
    try {
      await store.markImport(fingerprint);
    } catch {
      throw new Error("Legacy import completion could not be recorded.");
    }
  }
  return imported;
}

export async function importHumanOverrides(store, path) {
  if (!store || typeof store.setHumanDecision !== "function" ||
      typeof store.hasImport !== "function" || typeof store.markImport !== "function") {
    throw new Error("Human decision store is invalid.");
  }
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Human override file path is invalid.");
  }

  let raw;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_OVERRIDE_FILE_BYTES) {
      throw new Error("invalid");
    }
    raw = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { imported: 0 };
    throw new Error("Human override file could not be read safely.");
  }

  let overrides;
  try {
    overrides = parseStrictJson(utf8.decode(raw));
  } catch {
    throw new Error("Human override file is invalid.");
  }
  if (!isPlainObject(overrides) || !hasExactKeys(overrides, ["caseIds", "noteIds", "userIds"])) {
    throw new Error("Human override file is invalid.");
  }

  const decisions = [];
  for (const [field, scope] of [["caseIds", "case"], ["noteIds", "note"], ["userIds", "user"]]) {
    const ids = overrides[field];
    if (!Array.isArray(ids) || ids.length > MAX_OVERRIDE_IDS || !ids.every(isIdentifier)) {
      throw new Error("Human override file is invalid.");
    }
    for (const id of new Set(ids)) decisions.push({ scope, id });
  }
  if (decisions.length > MAX_OVERRIDE_IDS) throw new Error("Human override file is invalid.");

  let imported = 0;
  for (const { scope, id } of decisions) {
    try {
      const key = "human-override:v1:" + createHash("sha256").update(JSON.stringify([scope, id])).digest("hex");
      if (await store.hasImport(key)) continue;
      await store.setHumanDecision({ scope, id, reason: "Imported from legacy human override file." });
      await store.markImport(key);
      imported += 1;
    } catch {
      throw new Error("A legacy human decision could not be imported safely.");
    }
  }
  return { imported };
}

async function* readBoundedLines(path, name) {
  const stream = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES });
  let pending = Buffer.alloc(0);
  let lineNumber = 1;
  try {
    for await (const chunk of stream) {
      const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let start = 0;
      while (true) {
        const newline = data.indexOf(10, start);
        if (newline < 0) break;
        if (newline - start > MAX_JSONL_LINE_BYTES) {
          throw invalidLine(name, lineNumber);
        }
        yield { lineNumber, bytes: data.subarray(start, newline) };
        lineNumber += 1;
        start = newline + 1;
      }
      pending = data.subarray(start);
      if (pending.length > MAX_JSONL_LINE_BYTES) throw invalidLine(name, lineNumber);
    }
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new Error(`Legacy JSONL file ${name} could not be read safely.`);
  }
  if (pending.length > 0) yield { lineNumber, bytes: pending };
}

function parseAndValidateLine(bytes, name, lineNumber, kind) {
  const normalized = bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes;
  let value;
  try {
    value = parseStrictJson(utf8.decode(normalized));
  } catch {
    throw invalidLine(name, lineNumber);
  }
  try {
    if (!isPlainObject(value)) throw new Error("invalid");
    if (kind === "audit") validateAudit(value);
    else validateJob(kind, value);
    return value;
  } catch {
    throw invalidLine(name, lineNumber);
  }
}

function validateAudit(event) {
  assertOnlyFields(event, AUDIT_FIELDS);
  if (event.username !== undefined && !isShortString(event.username, 0, 256)) throw new Error("invalid");
  delete event.username;
  if (!isShortString(event.type, 1, 120) || !isTimestamp(event.timestamp) || !AUDIT_ACTORS.has(event.actor)) {
    throw new Error("invalid");
  }
  validateOptionalIdentifier(event, "caseId");
  validateOptionalIdentifier(event, "noteId");
  validateOptionalIdentifier(event, "userId");
  if (event.tier !== undefined && !["T1", "T2", "T3"].includes(event.tier)) throw new Error("invalid");
  if (event.mode !== undefined && !["dry-run", "enforce"].includes(event.mode)) throw new Error("invalid");
  if (event.ruleIds !== undefined && !isIdentifierArray(event.ruleIds)) throw new Error("invalid");
  if (event.reasons !== undefined && !isStringArray(event.reasons, 128, 2_000)) throw new Error("invalid");
  for (const field of ["reason", "outcome", "error"]) {
    if (event[field] !== undefined && !isShortString(event[field], 0, field === "error" ? 500 : 2_000)) {
      throw new Error("invalid");
    }
  }
  if (event.scope !== undefined && !["case", "note", "user"].includes(event.scope)) throw new Error("invalid");
  if (event.id !== undefined && !isIdentifier(event.id)) throw new Error("invalid");
  if (event.type === "human.decision" && (event.actor !== "human" || !event.scope || !event.id)) {
    throw new Error("invalid");
  }
}

function validateJob(kind, job) {
  const allowed = JOB_FIELDS[kind];
  if (!allowed) throw new Error("invalid");
  assertOnlyFields(job, allowed);
  if (!isIdentifier(job.caseId) || !isIdentifier(job.userId) ||
      !isTimestamp(job.queuedAt) || !isTimestamp(job.dueAt)) {
    throw new Error("invalid");
  }
  if (kind === "review") {
    if (!isIdentifier(job.noteId) || !["T2", "T3"].includes(job.tier) ||
        !isIdentifierArray(job.ruleIds) || !Number.isSafeInteger(job.delayMs) || job.delayMs < 0) {
      throw new Error("invalid");
    }
  }
}

function assertOnlyFields(value, fields) {
  if (Object.keys(value).some((field) => !fields.has(field))) throw new Error("invalid");
}

function validateOptionalIdentifier(value, field) {
  if (value[field] !== undefined && !isIdentifier(value[field])) throw new Error("invalid");
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isIdentifierArray(value) {
  return Array.isArray(value) && value.length <= 128 && value.every(isIdentifier);
}

function isStringArray(value, maxLength, maxItemLength) {
  return Array.isArray(value) && value.length <= maxLength &&
    value.every((item) => isShortString(item, 1, maxItemLength));
}

function isShortString(value, minLength, maxLength) {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function isTimestamp(value) {
  if (typeof value !== "string" || value.length > 32 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseStrictJson(text) {
  let position = 0;
  const whitespace = () => {
    while (position < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[position])) position += 1;
  };
  const stringToken = () => {
    const start = position;
    position += 1;
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code === 34) {
        position += 1;
        return JSON.parse(text.slice(start, position));
      }
      if (code === 92) {
        position += 2;
      } else {
        if (code < 32) throw new Error("invalid");
        position += 1;
      }
    }
    throw new Error("invalid");
  };
  const valueToken = (depth = 0) => {
    if (depth > 32) throw new Error("invalid");
    whitespace();
    const current = text[position];
    if (current === "\"") {
      stringToken();
      return;
    }
    if (current === "{") {
      position += 1;
      whitespace();
      if (text[position] === "}") {
        position += 1;
        return;
      }
      const keys = new Set();
      while (position < text.length) {
        whitespace();
        if (text[position] !== "\"") throw new Error("invalid");
        const key = stringToken();
        if (keys.has(key)) throw new Error("duplicate");
        keys.add(key);
        whitespace();
        if (text[position] !== ":") throw new Error("invalid");
        position += 1;
        valueToken(depth + 1);
        whitespace();
        if (text[position] === "}") {
          position += 1;
          return;
        }
        if (text[position] !== ",") throw new Error("invalid");
        position += 1;
      }
      throw new Error("invalid");
    }
    if (current === "[") {
      position += 1;
      whitespace();
      if (text[position] === "]") {
        position += 1;
        return;
      }
      while (position < text.length) {
        valueToken(depth + 1);
        whitespace();
        if (text[position] === "]") {
          position += 1;
          return;
        }
        if (text[position] !== ",") throw new Error("invalid");
        position += 1;
      }
      throw new Error("invalid");
    }
    const start = position;
    while (position < text.length && !/[\u0009\u000a\u000d\u0020,\]}]/u.test(text[position])) position += 1;
    if (position === start) throw new Error("invalid");
  };

  valueToken();
  whitespace();
  if (position !== text.length) throw new Error("invalid");
  return JSON.parse(text);
}

function fileFingerprint(name, info) {
  return `legacy-jsonl:${name}:${info.size}:${info.mtimeMs}`;
}

function sameFileSnapshot(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino && left.dev === right.dev;
}

function invalidLine(name, lineNumber) {
  return new LegacyImportError(`Legacy JSONL file ${name} line ${lineNumber} is invalid.`);
}

class LegacyImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegacyImportError";
  }
}
