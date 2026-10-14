import { createHash, randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { SQL } from "bun";
import { Database } from "bun:sqlite";

export class StorageError extends Error {
  constructor(message = "Durable storage operation failed.") {
    super(message);
    this.name = "StorageError";
  }
}

export class QueueCapacityError extends StorageError {
  constructor(queue) {
    super(`Durable ${queue} queue capacity has been reached.`);
    this.name = "QueueCapacityError";
  }
}

export class LeaseLostError extends StorageError {
  constructor() {
    super("Inbox lease is no longer owned by this worker.");
    this.name = "LeaseLostError";
    this.code = "LEASE_LOST";
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS automod_inbox (
    namespace TEXT NOT NULL,
    note_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'dead', 'completed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at BIGINT NOT NULL,
    lease_token TEXT,
    worker_id TEXT,
    lease_expires_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS automod_inbox_claim_idx
    ON automod_inbox (namespace, status, available_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS automod_inbox_expiry_idx
    ON automod_inbox (namespace, status, lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS automod_user_leases (
    namespace TEXT NOT NULL,
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    lease_expires_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS automod_audit_events (
    event_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    event JSONB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS automod_audit_namespace_idx
    ON automod_audit_events (namespace, created_at)`,
  `CREATE TABLE IF NOT EXISTS automod_completed_cases (
    namespace TEXT NOT NULL,
    note_id TEXT NOT NULL,
    case_id TEXT,
    user_id TEXT,
    completed_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, note_id)
  )`,
  `CREATE TABLE IF NOT EXISTS automod_jobs (
    namespace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('review', 'purge')),
    case_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, kind, case_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS automod_human_decisions (
    namespace TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('case', 'note', 'user')),
    decision_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, scope, decision_id)
  )`,
  `CREATE TABLE IF NOT EXISTS automod_action_journal (
    namespace TEXT NOT NULL,
    case_id TEXT NOT NULL,
    action_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, case_id, action_key)
  )`,
  `CREATE TABLE IF NOT EXISTS automod_api_budget (
    namespace TEXT PRIMARY KEY,
    next_at BIGINT NOT NULL,
    blocked_until BIGINT NOT NULL,
    api_requests BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS automod_store_metadata (
    namespace TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    source_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS automod_state_imports (
    namespace TEXT NOT NULL,
    source_id TEXT NOT NULL,
    import_id TEXT NOT NULL,
    imported_at BIGINT NOT NULL,
    record_digest TEXT,
    PRIMARY KEY (namespace, source_id, import_id)
  )`,
  `CREATE TABLE IF NOT EXISTS automod_state_migrations (
    namespace TEXT NOT NULL,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
    updated_at BIGINT NOT NULL,
    imported_count BIGINT NOT NULL DEFAULT 0,
    rolling_digest TEXT NOT NULL DEFAULT '',
    expected_count BIGINT,
    expected_digest TEXT,
    PRIMARY KEY (namespace, source_id)
  )`,
];

const sqliteMutexes = new Map();

function sqliteMutex(key) {
  if (!sqliteMutexes.has(key)) {
    let tail = Promise.resolve();
    sqliteMutexes.set(key, {
      run(callback) {
        const operation = tail.then(callback, callback);
        tail = operation.catch(() => undefined);
        return operation;
      },
    });
  }
  return sqliteMutexes.get(key);
}

class SQLiteAdapter {
  constructor(database) {
    this.database = database;
  }

  async all(query, parameters = []) {
    const statement = this.database.query(query);
    try {
      return statement.all(...parameters);
    } finally {
      statement.finalize();
    }
  }

  async run(query, parameters = []) {
    const statement = this.database.query(query);
    try {
      return statement.run(...parameters);
    } finally {
      statement.finalize();
    }
  }

  async now(clock) {
    return clock();
  }
}

class PostgresAdapter {
  constructor(sql) {
    this.sql = sql;
  }

  async all(query, parameters = []) {
    return this.sql.unsafe(toPostgresPlaceholders(query), parameters);
  }

  async run(query, parameters = []) {
    await this.sql.unsafe(toPostgresPlaceholders(query), parameters);
  }

  async now() {
    const rows = await this.all(
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now",
    );
    return Number(rows[0].now);
  }
}

function toPostgresPlaceholders(query) {
  let index = 0;
  return query.replace(/\?/gu, () => `$${++index}`);
}

function first(rows) {
  return rows[0] ?? null;
}

function decodeJson(value) {
  if (typeof value === "string") return JSON.parse(value);
  if (value instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(value));
  return value;
}

function json(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new StorageError("Durable storage accepts JSON values only.");
  return serialized;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageError(`A valid ${label} is required.`);
  }
  return value;
}

function positiveNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StorageError(`${label} must be a positive integer.`);
  }
  return value;
}

function nonnegativeNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function safeCode(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 64);
  return normalized || "unknown";
}

function validateJob(kind, job) {
  if (kind !== "review" && kind !== "purge") throw new StorageError("Job kind must be review or purge.");
  requiredString(job?.caseId, "case ID");
  requiredString(job?.userId, "user ID");
  json(job);
}

function stateTime(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError(`Migration ${label} is invalid.`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const properties = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${properties.join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordDigest(record) {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

function appendDigest(previous, digest) {
  return createHash("sha256").update(`${previous}:${digest}`).digest("hex");
}

function safeError(error) {
  if (error instanceof StorageError) return error;
  return new StorageError();
}

export async function createStore(options = {}) {
  const backend = options.backend ?? "sqlite";
  const namespace = options.namespace ?? "default";
  let database;
  let sql;
  try {
    requiredString(namespace, "namespace");
    const maxInboxJobs = positiveNumber(options.maxInboxJobs ?? 100_000, "maxInboxJobs");
    const maxQueuedJobs = positiveNumber(options.maxQueuedJobs ?? 100_000, "maxQueuedJobs");
    const maxAttempts = positiveNumber(options.maxAttempts ?? 5, "maxAttempts");
    const requireExisting = options.requireExisting ?? false;
    if (typeof requireExisting !== "boolean") throw new StorageError("requireExisting must be a boolean.");
    const clock = options.clock ?? Date.now;
    if (typeof clock !== "function") throw new StorageError("clock must be a function.");

    if (backend === "sqlite") {
      const sqlitePath = requiredString(options.sqlitePath, "SQLite path");
      database = new Database(sqlitePath, { create: !requireExisting });
      if (requireExisting) database.exec("PRAGMA busy_timeout = 5000;");
      else database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      options.sqliteMutex = sqliteMutex(sqlitePath === ":memory:" ? randomUUID() : resolvePath(sqlitePath));
    } else if (backend === "postgres") {
      const databaseUrl = requiredString(options.databaseUrl, "PostgreSQL URL");
      sql = new SQL(databaseUrl, { max: 5, connectionTimeout: 5 });
    } else {
      throw new StorageError("Storage backend must be sqlite or postgres.");
    }

    const store = new DurableStore({
      backend,
      namespace,
      maxInboxJobs,
      maxQueuedJobs,
      maxAttempts,
      requireExisting,
      clock,
      database,
      sql,
      sqliteMutex: options.sqliteMutex,
    });
    await store.initialize();
    return store;
  } catch (error) {
    try {
      database?.close(true);
      await sql?.close();
    } catch {
      // Initialization errors are deliberately reported without driver details.
    }
    throw safeError(error);
  }
}

class DurableStore {
  constructor(options) {
    Object.assign(this, options);
    this.adapter = this.backend === "sqlite"
      ? new SQLiteAdapter(this.database)
      : new PostgresAdapter(this.sql);
    this.closed = false;
  }

  async initialize() {
    if (this.requireExisting) {
      const checkExisting = async (tx) => {
        if (this.backend === "postgres") {
          const table = first(await tx.all("SELECT to_regclass('automod_store_metadata') AS table_name"));
          if (!table?.table_name) throw new StorageError("Existing durable storage namespace was not found.");
        } else {
          const table = first(await tx.all(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automod_store_metadata'",
          ));
          if (!table) throw new StorageError("Existing durable storage namespace was not found.");
        }
        const metadata = first(await tx.all(
          "SELECT schema_version, source_id FROM automod_store_metadata WHERE namespace = ?",
          [this.namespace],
        ));
        if (!metadata) throw new StorageError("Existing durable storage namespace was not found.");
        if (Number(metadata.schema_version) !== 1) throw new StorageError("Durable storage schema version is unsupported.");
        this.sourceId = metadata.source_id;
      };
      if (this.backend === "postgres") {
        await this.sql.begin(async (sqlTx) => {
          const tx = new PostgresAdapter(sqlTx);
          await tx.run("SELECT set_config('statement_timeout', ?, true)", ["5000ms"]);
          await tx.run("SELECT set_config('lock_timeout', ?, true)", ["5000ms"]);
          await checkExisting(tx);
        });
      } else {
        await checkExisting(this.adapter);
      }
      return;
    }

    return this.transaction(async (tx) => {
      if (this.backend === "postgres") {
        await tx.run("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["automod-schema-v1"]);
      }
      for (const statement of SCHEMA) await tx.run(statement);
      await this.ensureMigrationColumns(tx);
      await tx.run(
        `INSERT INTO automod_api_budget (namespace, next_at, blocked_until, api_requests)
         VALUES (?, 0, 0, 0) ON CONFLICT (namespace) DO NOTHING`,
        [this.namespace],
      );
      await tx.run(
        `INSERT INTO automod_store_metadata (namespace, schema_version, source_id)
         VALUES (?, 1, ?) ON CONFLICT (namespace) DO NOTHING`,
        [this.namespace, randomUUID()],
      );
      const metadata = first(await tx.all(
        "SELECT schema_version, source_id FROM automod_store_metadata WHERE namespace = ?",
        [this.namespace],
      ));
      if (Number(metadata?.schema_version) !== 1) throw new StorageError("Durable storage schema version is unsupported.");
      this.sourceId = metadata.source_id;
    }, { allowMigration: true });
  }

  async ensureMigrationColumns(tx) {
    if (this.backend === "postgres") {
      await tx.run("ALTER TABLE automod_state_imports ADD COLUMN IF NOT EXISTS record_digest TEXT");
      await tx.run("ALTER TABLE automod_state_migrations ADD COLUMN IF NOT EXISTS imported_count BIGINT NOT NULL DEFAULT 0");
      await tx.run("ALTER TABLE automod_state_migrations ADD COLUMN IF NOT EXISTS rolling_digest TEXT NOT NULL DEFAULT ''");
      await tx.run("ALTER TABLE automod_state_migrations ADD COLUMN IF NOT EXISTS expected_count BIGINT");
      await tx.run("ALTER TABLE automod_state_migrations ADD COLUMN IF NOT EXISTS expected_digest TEXT");
      return;
    }

    const importColumns = new Set((await tx.all("PRAGMA table_info(automod_state_imports)")).map((row) => row.name));
    if (!importColumns.has("record_digest")) {
      await tx.run("ALTER TABLE automod_state_imports ADD COLUMN record_digest TEXT");
    }
    const migrationColumns = new Set((await tx.all("PRAGMA table_info(automod_state_migrations)")).map((row) => row.name));
    const additions = [
      ["imported_count", "BIGINT NOT NULL DEFAULT 0"],
      ["rolling_digest", "TEXT NOT NULL DEFAULT ''"],
      ["expected_count", "BIGINT"],
      ["expected_digest", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!migrationColumns.has(name)) await tx.run(`ALTER TABLE automod_state_migrations ADD COLUMN ${name} ${type}`);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.backend === "sqlite") this.database.close(true);
      else await this.sql.close();
    } catch {
      throw new StorageError();
    }
  }

  async transaction(callback, { allowMigration = false } = {}) {
    if (this.closed) throw new StorageError("Durable store is closed.");
    const guardedCallback = async (tx) => {
      if (!allowMigration) {
        const activeMigration = first(await tx.all(
          `SELECT source_id FROM automod_state_migrations
           WHERE namespace = ? AND status = 'started' LIMIT 1`,
          [this.namespace],
        ));
        if (activeMigration) throw new StorageError("Durable state migration is incomplete.");
      }
      return callback(tx);
    };
    if (this.backend === "postgres") {
      try {
        return await this.sql.begin(async (sqlTx) => {
          const tx = new PostgresAdapter(sqlTx);
          await tx.run("SELECT set_config('statement_timeout', ?, true)", ["5000ms"]);
          await tx.run("SELECT set_config('lock_timeout', ?, true)", ["5000ms"]);
          return guardedCallback(tx);
        });
      } catch (error) {
        throw safeError(error);
      }
    }

    return this.sqliteMutex.run(async () => {
      try {
        this.database.exec("BEGIN IMMEDIATE");
        const result = await guardedCallback(this.adapter);
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // The original failure remains the useful signal.
        }
        throw safeError(error);
      }
    });
  }

  async read(callback) {
    if (this.closed) throw new StorageError("Durable store is closed.");
    if (this.backend === "postgres") return this.transaction(callback);
    try {
      const activeMigration = first(await this.adapter.all(
        `SELECT source_id FROM automod_state_migrations
         WHERE namespace = ? AND status = 'started' LIMIT 1`,
        [this.namespace],
      ));
      if (activeMigration) throw new StorageError("Durable state migration is incomplete.");
      return await callback(this.adapter);
    } catch (error) {
      throw safeError(error);
    }
  }

  async dbNow(tx = this.adapter) {
    if (this.backend === "postgres") return tx.now();
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new StorageError("Clock returned an invalid time.");
    return value;
  }

  async advisoryLock(tx, lockName) {
    if (this.backend === "postgres") {
      await tx.run("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [lockName]);
    }
  }

  async insertAudit(tx, event, createdAt) {
    await tx.run(
      "INSERT INTO automod_audit_events (event_id, namespace, created_at, event) VALUES (?, ?, ?, ?)",
      [randomUUID(), this.namespace, createdAt, json(event)],
    );
  }

  async hasLiveLease(tx, claim, now) {
    if (!claim || typeof claim !== "object") return false;
    const noteId = claim.noteId ?? claim.id;
    const lock = this.backend === "postgres" ? " FOR UPDATE" : "";
    const inbox = first(await tx.all(
      `SELECT note_id, lease_expires_at FROM automod_inbox
       WHERE namespace = ? AND note_id = ? AND user_id = ? AND status = 'running'
         AND lease_token = ? AND worker_id = ?${lock}`,
      [this.namespace, noteId, claim.userId, claim.token, claim.workerId],
    ));
    if (!inbox) return false;
    const checkNow = this.backend === "postgres" ? await tx.now() : now;
    if (Number(inbox.lease_expires_at) <= checkNow) return false;
    const lease = first(await tx.all(
      `SELECT note_id, lease_expires_at FROM automod_user_leases
       WHERE namespace = ? AND user_id = ? AND note_id = ? AND lease_token = ?
         AND worker_id = ?${lock}`,
      [this.namespace, claim.userId, noteId, claim.token, claim.workerId],
    ));
    return Boolean(lease && Number(lease.lease_expires_at) > checkNow);
  }

  async requireLease(tx, claim, now) {
    if (!await this.hasLiveLease(tx, claim, now)) throw new LeaseLostError();
  }

  async recoverExpired(tx, now) {
    const suffix = this.backend === "postgres" ? " FOR UPDATE SKIP LOCKED" : "";
    const expired = await tx.all(
      `SELECT note_id, user_id, lease_token, attempts FROM automod_inbox
       WHERE namespace = ? AND status = 'running' AND lease_expires_at <= ?
       ORDER BY lease_expires_at, created_at LIMIT 64${suffix}`,
      [this.namespace, now],
    );
    for (const row of expired) {
      const status = Number(row.attempts) >= this.maxAttempts ? "dead" : "pending";
      const changed = await tx.all(
        `UPDATE automod_inbox
         SET status = ?, available_at = ?, lease_token = NULL, worker_id = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE namespace = ? AND note_id = ? AND status = 'running' AND lease_token = ?
           AND lease_expires_at <= ? RETURNING note_id`,
        [status, now, now, this.namespace, row.note_id, row.lease_token, now],
      );
      if (changed.length === 0) continue;
      await tx.run(
        `DELETE FROM automod_user_leases
         WHERE namespace = ? AND user_id = ? AND note_id = ? AND lease_token = ?`,
        [this.namespace, row.user_id, row.note_id, row.lease_token],
      );
      await this.insertAudit(tx, {
        type: "queue.transition",
        noteId: row.note_id,
        userId: row.user_id,
        from: "running",
        to: status,
        actor: "deterministic",
        reason: "lease_expired",
      }, now);
    }
  }

  async enqueue(envelope) {
    try {
      const noteId = requiredString(envelope?.noteId, "note ID");
      const userId = requiredString(envelope?.userId, "user ID");
      const payload = json(envelope);
      return await this.transaction(async (tx) => {
        await this.advisoryLock(tx, `automod-inbox-capacity:${this.namespace}`);
        const now = await this.dbNow(tx);
        const existing = first(await tx.all(
          "SELECT status FROM automod_inbox WHERE namespace = ? AND note_id = ?",
          [this.namespace, noteId],
        ));
        if (existing) return { inserted: false };
        const count = first(await tx.all(
          `SELECT count(*) AS count FROM automod_inbox
           WHERE namespace = ? AND status IN ('pending', 'running', 'dead')`,
          [this.namespace],
        ));
        if (Number(count.count) >= this.maxInboxJobs) throw new QueueCapacityError("inbox");
        const inserted = await tx.all(
          `INSERT INTO automod_inbox
             (namespace, note_id, user_id, payload, status, attempts, available_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT (namespace, note_id) DO NOTHING RETURNING note_id`,
          [this.namespace, noteId, userId, payload, now, now, now],
        );
        if (inserted.length === 0) return { inserted: false };
        await this.insertAudit(tx, {
          type: "queue.transition",
          noteId,
          userId,
          from: null,
          to: "pending",
          actor: "deterministic",
          reason: "received",
        }, now);
        return { inserted: true };
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async claim({ workerId, leaseMs }) {
    try {
      requiredString(workerId, "worker ID");
      positiveNumber(leaseMs, "leaseMs");
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        await this.recoverExpired(tx, now);
        const suffix = this.backend === "postgres" ? " FOR UPDATE OF i SKIP LOCKED" : "";
        for (let scanned = 0; scanned < 64; scanned += 1) {
          const claimNow = await this.dbNow(tx);
          const candidate = first(await tx.all(
            `SELECT i.note_id, i.user_id, i.payload, i.attempts
             FROM automod_inbox AS i
             WHERE i.namespace = ? AND i.status = 'pending' AND i.available_at <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM automod_user_leases AS l
                 WHERE l.namespace = i.namespace AND l.user_id = i.user_id AND l.lease_expires_at > ?
               )
             ORDER BY i.created_at, i.note_id LIMIT 1${suffix}`,
            [this.namespace, claimNow, claimNow],
          ));
          if (!candidate) return null;
          const token = randomUUID();
          const leaseExpiresAt = claimNow + leaseMs;
          const lease = await tx.all(
            `INSERT INTO automod_user_leases
               (namespace, user_id, note_id, lease_token, worker_id, lease_expires_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (namespace, user_id) DO UPDATE SET
               note_id = excluded.note_id, lease_token = excluded.lease_token,
               worker_id = excluded.worker_id, lease_expires_at = excluded.lease_expires_at
             WHERE automod_user_leases.lease_expires_at <= ?
             RETURNING user_id`,
            [this.namespace, candidate.user_id, candidate.note_id, token, workerId, leaseExpiresAt, claimNow],
          );
          if (lease.length === 0) continue;

          const updated = await tx.all(
            `UPDATE automod_inbox SET status = 'running', attempts = attempts + 1,
               lease_token = ?, worker_id = ?, lease_expires_at = ?, updated_at = ?
             WHERE namespace = ? AND note_id = ? AND status = 'pending' AND available_at <= ?
             RETURNING note_id, user_id, payload, attempts`,
            [token, workerId, leaseExpiresAt, claimNow, this.namespace, candidate.note_id, claimNow],
          );
          if (updated.length === 0) {
            await tx.run(
              `DELETE FROM automod_user_leases WHERE namespace = ? AND user_id = ?
               AND note_id = ? AND lease_token = ?`,
              [this.namespace, candidate.user_id, candidate.note_id, token],
            );
            continue;
          }
          const row = updated[0];
          await this.insertAudit(tx, {
            type: "queue.transition",
            noteId: row.note_id,
            userId: row.user_id,
            from: "pending",
            to: "running",
            actor: "deterministic",
            reason: "claimed",
          }, claimNow);
          return {
            id: row.note_id,
            noteId: row.note_id,
            userId: row.user_id,
            payload: decodeJson(row.payload),
            token,
            workerId,
            attempts: Number(row.attempts),
            leaseExpiresAt,
          };
        }
        return null;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async renew(claim, leaseMs) {
    try {
      positiveNumber(leaseMs, "leaseMs");
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        if (!await this.hasLiveLease(tx, claim, now)) return false;
        const noteId = claim.noteId ?? claim.id;
        const leaseExpiresAt = now + leaseMs;
        await tx.run(
          `UPDATE automod_inbox SET lease_expires_at = ?, updated_at = ?
           WHERE namespace = ? AND note_id = ? AND lease_token = ?`,
          [leaseExpiresAt, now, this.namespace, noteId, claim.token],
        );
        await tx.run(
          `UPDATE automod_user_leases SET lease_expires_at = ?
           WHERE namespace = ? AND user_id = ? AND note_id = ? AND lease_token = ?`,
          [leaseExpiresAt, this.namespace, claim.userId, noteId, claim.token],
        );
        return true;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async assertLease(claim) {
    try {
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        if (!await this.hasLiveLease(tx, claim, now)) throw new LeaseLostError();
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async complete(claim) {
    try {
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        if (!await this.hasLiveLease(tx, claim, now)) return false;
        const noteId = claim.noteId ?? claim.id;
        const updated = await tx.all(
          `UPDATE automod_inbox SET status = 'completed', payload = '{}', lease_token = NULL,
             worker_id = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE namespace = ? AND note_id = ? AND status = 'running' AND lease_token = ?
           RETURNING note_id, user_id`,
          [now, this.namespace, noteId, claim.token],
        );
        if (updated.length === 0) return false;
        const row = updated[0];
        await tx.run(
          `DELETE FROM automod_user_leases WHERE namespace = ? AND user_id = ?
           AND note_id = ? AND lease_token = ?`,
          [this.namespace, row.user_id, row.note_id, claim.token],
        );
        await this.insertAudit(tx, {
          type: "queue.transition",
          noteId: row.note_id,
          userId: row.user_id,
          from: "running",
          to: "completed",
          actor: "deterministic",
          reason: "acknowledged",
        }, now);
        return true;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async fail(claim, { code, delayMs = 0, permanent = false } = {}) {
    try {
      nonnegativeNumber(delayMs, "delayMs");
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        await this.requireLease(tx, claim, now);
        const noteId = claim.noteId ?? claim.id;
        const row = first(await tx.all(
          `SELECT note_id, user_id, attempts FROM automod_inbox
           WHERE namespace = ? AND note_id = ? AND lease_token = ?`,
          [this.namespace, noteId, claim.token],
        ));
        if (!row) throw new LeaseLostError();
        const status = permanent || Number(row.attempts) >= this.maxAttempts ? "dead" : "pending";
        await tx.run(
          `UPDATE automod_inbox SET status = ?, available_at = ?, lease_token = NULL,
             worker_id = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE namespace = ? AND note_id = ? AND lease_token = ?`,
          [status, now + delayMs, now, this.namespace, row.note_id, claim.token],
        );
        await tx.run(
          `DELETE FROM automod_user_leases WHERE namespace = ? AND user_id = ?
           AND note_id = ? AND lease_token = ?`,
          [this.namespace, row.user_id, row.note_id, claim.token],
        );
        await this.insertAudit(tx, {
          type: "queue.transition",
          noteId: row.note_id,
          userId: row.user_id,
          from: "running",
          to: status,
          actor: "deterministic",
          reason: safeCode(code),
        }, now);
        return status;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async stats() {
    return this.read(async (tx) => {
      const inboxRows = await tx.all(
        `SELECT status, count(*) AS count FROM automod_inbox WHERE namespace = ? GROUP BY status`,
        [this.namespace],
      );
      const counts = Object.fromEntries(inboxRows.map((row) => [row.status, Number(row.count)]));
      const jobRows = await tx.all(
        `SELECT kind, count(*) AS count FROM automod_jobs WHERE namespace = ? GROUP BY kind`,
        [this.namespace],
      );
      const jobs = Object.fromEntries(jobRows.map((row) => [row.kind, Number(row.count)]));
      const budget = first(await tx.all(
        `SELECT api_requests, blocked_until FROM automod_api_budget WHERE namespace = ?`,
        [this.namespace],
      ));
      const oldest = first(await tx.all(
        `SELECT min(created_at) AS oldest FROM automod_inbox WHERE namespace = ? AND status = 'pending'`,
        [this.namespace],
      ));
      return {
        pending: counts.pending ?? 0,
        running: counts.running ?? 0,
        dead: counts.dead ?? 0,
        completed: counts.completed ?? 0,
        reviewJobs: jobs.review ?? 0,
        purgeJobs: jobs.purge ?? 0,
        apiRequests: Number(budget?.api_requests ?? 0),
        apiBlockedUntil: Number(budget?.blocked_until ?? 0),
        oldestPendingAt: oldest?.oldest == null ? null : Number(oldest.oldest),
      };
    });
  }

  async record(event, { lease } = {}) {
    try {
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        if (lease) await this.requireLease(tx, lease, now);
        await this.recordTx(tx, event, now);
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async hasProcessed(noteId) {
    requiredString(noteId, "note ID");
    return this.read(async (tx) => Boolean(first(await tx.all(
      "SELECT note_id FROM automod_completed_cases WHERE namespace = ? AND note_id = ?",
      [this.namespace, noteId],
    ))));
  }

  async recordTx(tx, event, now, eventId = randomUUID()) {
    const serialized = json(event);
    let humanDecision = null;
    if (event?.type === "human.decision") {
      if (event.actor !== "human" || !new Set(["case", "note", "user"]).has(event.scope)) {
        throw new StorageError("Human decision audit is invalid.");
      }
      requiredString(event.id, "human decision ID");
      if (typeof event.reason !== "string" || event.reason.length === 0) {
        throw new StorageError("Human decision reason is required.");
      }
      humanDecision = { scope: event.scope, id: event.id, reason: event.reason };
    }
    await tx.run(
      "INSERT INTO automod_audit_events (event_id, namespace, created_at, event) VALUES (?, ?, ?, ?)",
      [eventId, this.namespace, now, serialized],
    );
    if (event?.type === "case.completed" && typeof event.noteId === "string") {
      await tx.run(
        `INSERT INTO automod_completed_cases (namespace, note_id, case_id, user_id, completed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (namespace, note_id) DO UPDATE SET
           case_id = excluded.case_id, user_id = excluded.user_id, completed_at = excluded.completed_at`,
        [this.namespace, event.noteId, event.caseId ?? null, event.userId ?? null, now],
      );
    }
    if ((event?.type === "automation.skipped.human" ||
      (event?.type === "case.completed" && event.actor === "human")) &&
      typeof event.caseId === "string") {
      await this.insertHumanDecision(tx, "case", event.caseId, event.reason ?? "human decision", now);
    }
    if (humanDecision) {
      await this.insertHumanDecision(tx, humanDecision.scope, humanDecision.id, humanDecision.reason, now);
    }
  }

  async importLegacyRecord(kind, value, key) {
    try {
      if (!new Set(["audit", "review", "purge"]).has(kind)) {
        throw new StorageError("Legacy record kind is invalid.");
      }
      requiredString(key, "legacy import key");
      json(value);
      if (kind === "review" || kind === "purge") validateJob(kind, value);
      return await this.transaction(async (tx) => {
        const importId = `${kind}:${key}`;
        await this.advisoryLock(tx, `automod-legacy-import:${this.namespace}:${importId}`);
        const prior = first(await tx.all(
          `SELECT import_id FROM automod_state_imports
           WHERE namespace = ? AND source_id = 'legacy-v1' AND import_id = ?`,
          [this.namespace, importId],
        ));
        if (prior) return { imported: false };
        const now = await this.dbNow(tx);
        if (kind === "audit") await this.recordTx(tx, value, now);
        else await this.enqueueJobTx(tx, kind, value, now, "legacy_import");
        await tx.run(
          `INSERT INTO automod_state_imports (namespace, source_id, import_id, imported_at)
           VALUES (?, 'legacy-v1', ?, ?)`,
          [this.namespace, importId, now],
        );
        return { imported: true };
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async hasImport(key) {
    requiredString(key, "import key");
    return this.read(async (tx) => Boolean(first(await tx.all(
      `SELECT import_id FROM automod_state_imports
       WHERE namespace = ? AND source_id = 'legacy-v1' AND import_id = ?`,
      [this.namespace, `file:${key}`],
    ))));
  }

  async markImport(key) {
    try {
      requiredString(key, "import key");
      return await this.transaction(async (tx) => {
        const importId = `file:${key}`;
        await this.advisoryLock(tx, `automod-legacy-import:${this.namespace}:${importId}`);
        const now = await this.dbNow(tx);
        await tx.run(
          `INSERT INTO automod_state_imports (namespace, source_id, import_id, imported_at)
           VALUES (?, 'legacy-v1', ?, ?) ON CONFLICT (namespace, source_id, import_id) DO NOTHING`,
          [this.namespace, importId, now],
        );
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async enqueueJob(kind, job, { lease } = {}) {
    try {
      validateJob(kind, job);
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        if (lease) await this.requireLease(tx, lease, now);
        return this.enqueueJobTx(tx, kind, job, now);
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async enqueueJobTx(tx, kind, job, now, eventReason = "queued") {
    validateJob(kind, job);
    const caseId = job.caseId;
    const userId = job.userId;
    await this.advisoryLock(tx, `automod-job-capacity:${this.namespace}:${kind}`);
    const existing = first(await tx.all(
      `SELECT case_id FROM automod_jobs
       WHERE namespace = ? AND kind = ? AND case_id = ? AND user_id = ?`,
      [this.namespace, kind, caseId, userId],
    ));
    if (existing) return { inserted: false };
    const count = first(await tx.all(
      "SELECT count(*) AS count FROM automod_jobs WHERE namespace = ? AND kind = ?",
      [this.namespace, kind],
    ));
    if (Number(count.count) >= this.maxQueuedJobs) throw new QueueCapacityError(`${kind} job`);
    const storedJob = {
      ...job,
      queuedAt: job.queuedAt ?? new Date(now).toISOString(),
      dueAt: job.dueAt ?? new Date(now + Math.max(0, Number(job.delayMs) || 0)).toISOString(),
    };
    const inserted = await tx.all(
      `INSERT INTO automod_jobs (namespace, kind, case_id, user_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (namespace, kind, case_id, user_id) DO NOTHING RETURNING case_id`,
      [this.namespace, kind, caseId, userId, json(storedJob), now],
    );
    if (inserted.length === 0) return { inserted: false };
    await this.insertAudit(tx, {
      type: "job.enqueued",
      kind,
      caseId,
      userId,
      actor: "deterministic",
      reason: eventReason,
    }, now);
    return { inserted: true };
  }

  async insertHumanDecision(tx, scope, id, reason, now) {
    await tx.run(
      `INSERT INTO automod_human_decisions (namespace, scope, decision_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (namespace, scope, decision_id) DO UPDATE SET
         reason = excluded.reason, created_at = excluded.created_at`,
      [this.namespace, scope, id, String(reason).slice(0, 2_000), now],
    );
  }

  async setHumanDecision({ scope, id, reason }) {
    try {
      if (!new Set(["case", "note", "user"]).has(scope)) throw new StorageError("Human decision scope is invalid.");
      requiredString(id, "decision ID");
      if (typeof reason !== "string" || reason.length === 0) throw new StorageError("Human decision reason is required.");
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        await this.insertHumanDecision(tx, scope, id, reason, now);
        await this.insertAudit(tx, {
          type: "human.decision",
          scope,
          id,
          actor: "human",
          reason: reason.slice(0, 2_000),
        }, now);
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async hasHumanDecision({ caseId, noteId, userId } = {}) {
    const candidates = [
      ["case", caseId],
      ["note", noteId],
      ["user", userId],
    ].filter(([, id]) => typeof id === "string" && id.length > 0);
    if (candidates.length === 0) return false;
    return this.read(async (tx) => {
      const clauses = candidates.map(() => "(scope = ? AND decision_id = ?)").join(" OR ");
      const parameters = [this.namespace, ...candidates.flatMap((entry) => entry)];
      return Boolean(first(await tx.all(
        `SELECT decision_id FROM automod_human_decisions WHERE namespace = ? AND (${clauses}) LIMIT 1`,
        parameters,
      )));
    });
  }

  async getAction(caseId, key) {
    requiredString(caseId, "case ID");
    requiredString(key, "action key");
    return this.read(async (tx) => {
      const row = first(await tx.all(
        `SELECT status FROM automod_action_journal
         WHERE namespace = ? AND case_id = ? AND action_key = ?`,
        [this.namespace, caseId, key],
      ));
      return row ? { status: row.status } : null;
    });
  }

  async startAction(claim, key) {
    try {
      requiredString(key, "action key");
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        await this.requireLease(tx, claim, now);
        const noteId = claim.noteId ?? claim.id;
        const existing = first(await tx.all(
          `SELECT status FROM automod_action_journal
           WHERE namespace = ? AND case_id = ? AND action_key = ?`,
          [this.namespace, noteId, key],
        ));
        if (existing) return false;
        await tx.run(
          `INSERT INTO automod_action_journal (namespace, case_id, action_key, status, updated_at)
           VALUES (?, ?, ?, 'started', ?)`,
          [this.namespace, noteId, key, now],
        );
        await this.insertAudit(tx, {
          type: "action.started",
          caseId: noteId,
          action: safeCode(key),
          actor: "deterministic",
          reason: "external_action_started",
        }, now);
        return true;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async completeAction(claim, key) {
    try {
      requiredString(key, "action key");
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        await this.requireLease(tx, claim, now);
        const noteId = claim.noteId ?? claim.id;
        const updated = await tx.all(
          `UPDATE automod_action_journal SET status = 'completed', updated_at = ?
           WHERE namespace = ? AND case_id = ? AND action_key = ? AND status = 'started'
           RETURNING action_key`,
          [now, this.namespace, noteId, key],
        );
        if (updated.length === 0) {
          const existing = first(await tx.all(
            `SELECT status FROM automod_action_journal
             WHERE namespace = ? AND case_id = ? AND action_key = ?`,
            [this.namespace, noteId, key],
          ));
          if (existing?.status === "completed") return false;
          throw new StorageError("Action must be started before it can be completed.");
        }
        await this.insertAudit(tx, {
          type: "action.completed",
          caseId: noteId,
          action: safeCode(key),
          actor: "deterministic",
          reason: "external_action_completed",
        }, now);
        return true;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async resetAction(claim, key) {
    try {
      requiredString(key, "action key");
      return await this.transaction(async (tx) => {
        const now = await this.dbNow(tx);
        await this.requireLease(tx, claim, now);
        const noteId = claim.noteId ?? claim.id;
        const existing = first(await tx.all(
          `SELECT status FROM automod_action_journal
           WHERE namespace = ? AND case_id = ? AND action_key = ?`,
          [this.namespace, noteId, key],
        ));
        if (!existing) return false;
        if (existing.status !== "started") throw new StorageError("Only a started action can be reset.");
        await tx.run(
          `DELETE FROM automod_action_journal
           WHERE namespace = ? AND case_id = ? AND action_key = ? AND status = 'started'`,
          [this.namespace, noteId, key],
        );
        await this.insertAudit(tx, {
          type: "action.reset",
          caseId: noteId,
          action: safeCode(key),
          actor: "deterministic",
          reason: "definitive_rejection",
        }, now);
        return true;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async tryApiSlot(intervalMs) {
    try {
      nonnegativeNumber(intervalMs, "intervalMs");
      return await this.transaction(async (tx) => {
        let now = await this.dbNow(tx);
        const lock = this.backend === "postgres" ? " FOR UPDATE" : "";
        const budget = first(await tx.all(
          `SELECT next_at, blocked_until FROM automod_api_budget WHERE namespace = ?${lock}`,
          [this.namespace],
        ));
        if (!budget) throw new StorageError();
        now = await this.dbNow(tx);
        const readyAt = Math.max(Number(budget.next_at), Number(budget.blocked_until));
        const waitMs = Math.max(0, readyAt - now);
        if (waitMs > 0) return waitMs;
        await tx.run(
          `UPDATE automod_api_budget SET next_at = ?, api_requests = api_requests + 1
           WHERE namespace = ?`,
          [now + intervalMs, this.namespace],
        );
        return 0;
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  async blockApi(delayMs) {
    try {
      nonnegativeNumber(delayMs, "delayMs");
      return await this.transaction(async (tx) => {
        let now = await this.dbNow(tx);
        const lock = this.backend === "postgres" ? " FOR UPDATE" : "";
        const budget = first(await tx.all(
          `SELECT blocked_until FROM automod_api_budget WHERE namespace = ?${lock}`,
          [this.namespace],
        ));
        if (!budget) throw new StorageError();
        now = await this.dbNow(tx);
        await tx.run(
          "UPDATE automod_api_budget SET blocked_until = ? WHERE namespace = ?",
          [Math.max(Number(budget.blocked_until), now + delayMs), this.namespace],
        );
      });
    } catch (error) {
      throw safeError(error);
    }
  }

  migrationRecord(kind, importId, fields = {}) {
    return {
      schemaVersion: 1,
      namespace: this.namespace,
      sourceId: this.sourceId,
      kind,
      importId,
      ...fields,
    };
  }

  async *exportState() {
    const active = await this.read(async (tx) => first(await tx.all(
      `SELECT source_id FROM automod_state_migrations
       WHERE namespace = ? AND status = 'started' LIMIT 1`,
      [this.namespace],
    )));
    if (active) throw new StorageError("Cannot export while a state migration is incomplete.");
    yield this.migrationRecord("meta", "meta", {});

    const now = await this.read((tx) => this.dbNow(tx));
    let recordCount = 0;
    let digest = "";
    const includeInFooter = (record) => {
      digest = appendDigest(digest, recordDigest(record));
      recordCount += 1;
      return record;
    };
    const tables = [
      {
        kind: "inbox",
        table: "automod_inbox",
        columns: "note_id, user_id, payload, status, attempts, available_at, created_at, updated_at",
        order: "note_id",
        map: (row) => {
          const status = row.status === "running" ? "pending" : row.status;
          return this.migrationRecord("inbox", `inbox:${row.note_id}`, {
            noteId: row.note_id,
            userId: row.user_id,
            payload: decodeJson(row.payload),
            status,
            attempts: Number(row.attempts),
            availableAt: Number(row.available_at),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
          });
        },
      },
      {
        kind: "job",
        table: "automod_jobs",
        columns: "kind, case_id, user_id, payload, created_at",
        order: "kind, case_id, user_id",
        map: (row) => this.migrationRecord("job", `job:${JSON.stringify([row.kind, row.case_id, row.user_id])}`, {
          jobKind: row.kind,
          caseId: row.case_id,
          userId: row.user_id,
          payload: decodeJson(row.payload),
          createdAt: Number(row.created_at),
        }),
      },
      {
        kind: "audit",
        table: "automod_audit_events",
        columns: "event_id, created_at, event",
        order: "created_at, event_id",
        map: (row) => this.migrationRecord("audit", `audit:${row.event_id}`, {
          eventId: row.event_id,
          createdAt: Number(row.created_at),
          event: decodeJson(row.event),
        }),
      },
      {
        kind: "completed",
        table: "automod_completed_cases",
        columns: "note_id, case_id, user_id, completed_at",
        order: "note_id",
        map: (row) => this.migrationRecord("completed", `completed:${row.note_id}`, {
          noteId: row.note_id,
          caseId: row.case_id,
          userId: row.user_id,
          completedAt: Number(row.completed_at),
        }),
      },
      {
        kind: "human",
        table: "automod_human_decisions",
        columns: "scope, decision_id, reason, created_at",
        order: "scope, decision_id",
        map: (row) => this.migrationRecord("human", `human:${JSON.stringify([row.scope, row.decision_id])}`, {
          scope: row.scope,
          id: row.decision_id,
          reason: row.reason,
          createdAt: Number(row.created_at),
        }),
      },
      {
        kind: "action",
        table: "automod_action_journal",
        columns: "case_id, action_key, status, updated_at",
        order: "case_id, action_key",
        map: (row) => this.migrationRecord("action", `action:${JSON.stringify([row.case_id, row.action_key])}`, {
          caseId: row.case_id,
          actionKey: row.action_key,
          status: row.status,
          updatedAt: Number(row.updated_at),
        }),
      },
      {
        kind: "import-ledger",
        table: "automod_state_imports",
        columns: "source_id, import_id, imported_at, record_digest",
        order: "source_id, import_id",
        map: (row) => this.migrationRecord("import-ledger", `import-ledger:${JSON.stringify([row.source_id, row.import_id])}`, {
          ledgerSourceId: row.source_id,
          ledgerImportId: row.import_id,
          ledgerImportedAt: Number(row.imported_at),
          ledgerRecordDigest: row.record_digest ?? null,
        }),
      },
    ];

    for (const table of tables) {
      let offset = 0;
      while (true) {
        const rows = await this.read((tx) => tx.all(
          `SELECT ${table.columns} FROM ${table.table}
           WHERE namespace = ? ORDER BY ${table.order} LIMIT ? OFFSET ?`,
          [this.namespace, 500, offset],
        ));
        if (rows.length === 0) break;
        for (const row of rows) yield includeInFooter(table.map(row));
        offset += rows.length;
      }
    }

    const budget = first(await this.read((tx) => tx.all(
      `SELECT next_at, blocked_until, api_requests FROM automod_api_budget WHERE namespace = ?`,
      [this.namespace],
    )));
    yield includeInFooter(this.migrationRecord("budget", "budget:api", {
      nextAt: Number(budget?.next_at ?? now),
      blockedUntil: Number(budget?.blocked_until ?? now),
      apiRequests: Number(budget?.api_requests ?? 0),
    }));
    yield this.migrationRecord("footer", "footer", { recordCount, digest });
  }

  async importState(record) {
    try {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new StorageError("Migration record is invalid.");
      }
      if (record.schemaVersion !== 1) throw new StorageError("Migration schema version is unsupported.");
      if (record.namespace !== this.namespace) throw new StorageError("Migration namespace does not match the destination.");
      const sourceId = requiredString(record.sourceId, "migration source ID");
      if (sourceId === this.sourceId) throw new StorageError("A store cannot import its own state.");

      if (record.kind === "meta") return this.importStateMeta(sourceId);
      if (record.kind === "footer") return this.importStateFooter(record, sourceId);
      requiredString(record.importId, "migration record ID");

      return await this.transaction(async (tx) => {
        await this.advisoryLock(tx, `automod-state-import:${this.namespace}`);
        const digest = recordDigest(record);
        const imported = first(await tx.all(
          `SELECT import_id, record_digest FROM automod_state_imports
           WHERE namespace = ? AND source_id = ? AND import_id = ?`,
          [this.namespace, sourceId, record.importId],
        ));
        if (imported) {
          if (imported.record_digest !== digest) {
            throw new StorageError("Previously imported migration record has changed.");
          }
          return { imported: false };
        }
        const migration = first(await tx.all(
          `SELECT status, imported_count, rolling_digest FROM automod_state_migrations
           WHERE namespace = ? AND source_id = ?${this.backend === "postgres" ? " FOR UPDATE" : ""}`,
          [this.namespace, sourceId],
        ));
        if (migration?.status !== "started") throw new StorageError("Migration must begin with a valid metadata record.");
        const now = await this.dbNow(tx);
        await this.importStateRow(tx, record, now);
        await tx.run(
          `INSERT INTO automod_state_imports (namespace, source_id, import_id, imported_at, record_digest)
           VALUES (?, ?, ?, ?, ?)`,
          [this.namespace, sourceId, record.importId, now, digest],
        );
        await tx.run(
          `UPDATE automod_state_migrations
           SET imported_count = ?, rolling_digest = ?, updated_at = ?
           WHERE namespace = ? AND source_id = ? AND status = 'started'`,
          [Number(migration.imported_count) + 1, appendDigest(migration.rolling_digest, digest), now, this.namespace, sourceId],
        );
        return { imported: true };
      }, { allowMigration: true });
    } catch (error) {
      throw safeError(error);
    }
  }

  async importStateMeta(sourceId) {
    return this.transaction(async (tx) => {
      await this.advisoryLock(tx, `automod-state-import:${this.namespace}`);
      const existing = first(await tx.all(
        `SELECT status FROM automod_state_migrations
         WHERE namespace = ? AND source_id = ?`,
        [this.namespace, sourceId],
      ));
      if (existing) return { imported: false };
      const otherMigration = first(await tx.all(
        `SELECT source_id FROM automod_state_migrations WHERE namespace = ? LIMIT 1`,
        [this.namespace],
      ));
      if (otherMigration) throw new StorageError("Another state migration already exists for this namespace.");
      const occupied = [
        "automod_inbox",
        "automod_jobs",
        "automod_audit_events",
        "automod_completed_cases",
        "automod_human_decisions",
        "automod_action_journal",
        "automod_state_imports",
      ];
      for (const table of occupied) {
        const count = first(await tx.all(`SELECT count(*) AS count FROM ${table} WHERE namespace = ?`, [this.namespace]));
        if (Number(count.count) > 0) throw new StorageError("State migration requires an empty destination namespace.");
      }
      const budget = first(await tx.all(
        `SELECT next_at, blocked_until, api_requests FROM automod_api_budget WHERE namespace = ?`,
        [this.namespace],
      ));
      if (budget && (Number(budget.next_at) > 0 || Number(budget.blocked_until) > 0 || Number(budget.api_requests) > 0)) {
        throw new StorageError("State migration requires an unused destination namespace.");
      }
      const now = await this.dbNow(tx);
      await tx.run(
        `INSERT INTO automod_state_migrations (namespace, source_id, status, updated_at)
         VALUES (?, ?, 'started', ?)`,
        [this.namespace, sourceId, now],
      );
      return { imported: true };
    }, { allowMigration: true });
  }

  async importStateFooter(record, sourceId) {
    return this.transaction(async (tx) => {
      await this.advisoryLock(tx, `automod-state-import:${this.namespace}`);
      const migration = first(await tx.all(
        `SELECT status, imported_count, rolling_digest, expected_count, expected_digest
         FROM automod_state_migrations
         WHERE namespace = ? AND source_id = ?${this.backend === "postgres" ? " FOR UPDATE" : ""}`,
        [this.namespace, sourceId],
      ));
      if (!migration) throw new StorageError("Migration footer has no matching metadata record.");
      const expectedCount = stateTime(record.recordCount, "record count");
      if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)) {
        throw new StorageError("Migration footer digest is invalid.");
      }
      if (Number(migration.imported_count) !== expectedCount || migration.rolling_digest !== record.digest) {
        throw new StorageError("Migration is incomplete or its source records changed.");
      }
      if (migration.status === "completed") {
        if (Number(migration.expected_count) !== expectedCount || migration.expected_digest !== record.digest) {
          throw new StorageError("Completed migration footer does not match its original source.");
        }
        return { imported: false };
      }
      const now = await this.dbNow(tx);
      await tx.run(
        `UPDATE automod_state_migrations
         SET status = 'completed', expected_count = ?, expected_digest = ?, updated_at = ?
         WHERE namespace = ? AND source_id = ? AND status = 'started'`,
        [expectedCount, record.digest, now, this.namespace, sourceId],
      );
      return { imported: true };
    }, { allowMigration: true });
  }

  async importStateRow(tx, record, now) {
    const exists = async (table, keys, values) => Boolean(first(await tx.all(
      `SELECT 1 AS found FROM ${table} WHERE namespace = ? AND ${keys} LIMIT 1`,
      [this.namespace, ...values],
    )));
    const requireUnused = async (table, keys, values) => {
      if (await exists(table, keys, values)) throw new StorageError("Migration destination changed after preflight.");
    };

    switch (record.kind) {
      case "inbox": {
        const noteId = requiredString(record.noteId, "migration note ID");
        const userId = requiredString(record.userId, "migration user ID");
        const sourceStatus = record.status;
        if (!new Set(["pending", "running", "dead", "completed"]).has(sourceStatus)) {
          throw new StorageError("Migration inbox status is invalid.");
        }
        const status = sourceStatus === "running" ? "pending" : sourceStatus;
        const attempts = stateTime(record.attempts, "attempt count");
        const availableAt = stateTime(record.availableAt, "queue availability time");
        const createdAt = stateTime(record.createdAt, "inbox creation time");
        const updatedAt = stateTime(record.updatedAt, "inbox update time");
        await requireUnused("automod_inbox", "note_id = ?", [noteId]);
        await tx.run(
          `INSERT INTO automod_inbox
             (namespace, note_id, user_id, payload, status, attempts, available_at,
              lease_token, worker_id, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
          [this.namespace, noteId, userId, json(record.payload), status, attempts, availableAt, createdAt, updatedAt],
        );
        return;
      }
      case "job": {
        validateJob(record.jobKind, record.payload);
        if (record.payload.caseId !== record.caseId || record.payload.userId !== record.userId) {
          throw new StorageError("Migration job identifiers do not match its payload.");
        }
        const createdAt = stateTime(record.createdAt, "job creation time");
        await requireUnused("automod_jobs", "kind = ? AND case_id = ? AND user_id = ?", [record.jobKind, record.caseId, record.userId]);
        await tx.run(
          `INSERT INTO automod_jobs (namespace, kind, case_id, user_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [this.namespace, record.jobKind, record.caseId, record.userId, json(record.payload), createdAt],
        );
        return;
      }
      case "audit": {
        const eventId = requiredString(record.eventId, "migration audit event ID");
        const createdAt = stateTime(record.createdAt, "audit creation time");
        await tx.run(
          `INSERT INTO automod_audit_events (event_id, namespace, created_at, event)
           VALUES (?, ?, ?, ?)`,
          [eventId, this.namespace, createdAt, json(record.event)],
        );
        return;
      }
      case "completed": {
        const noteId = requiredString(record.noteId, "migration note ID");
        const completedAt = stateTime(record.completedAt, "completion time");
        await requireUnused("automod_completed_cases", "note_id = ?", [noteId]);
        await tx.run(
          `INSERT INTO automod_completed_cases (namespace, note_id, case_id, user_id, completed_at)
           VALUES (?, ?, ?, ?, ?)`,
          [this.namespace, noteId, record.caseId ?? null, record.userId ?? null, completedAt],
        );
        return;
      }
      case "human": {
        const scope = record.scope;
        if (!new Set(["case", "note", "user"]).has(scope)) throw new StorageError("Migration human decision scope is invalid.");
        const id = requiredString(record.id, "migration human decision ID");
        const createdAt = stateTime(record.createdAt, "human decision time");
        await requireUnused("automod_human_decisions", "scope = ? AND decision_id = ?", [scope, id]);
        await tx.run(
          `INSERT INTO automod_human_decisions (namespace, scope, decision_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [this.namespace, scope, id, String(record.reason ?? "").slice(0, 2_000), createdAt],
        );
        return;
      }
      case "action": {
        const caseId = requiredString(record.caseId, "migration action case ID");
        const actionKey = requiredString(record.actionKey, "migration action key");
        if (!new Set(["started", "completed"]).has(record.status)) throw new StorageError("Migration action status is invalid.");
        const updatedAt = stateTime(record.updatedAt, "action update time");
        await requireUnused("automod_action_journal", "case_id = ? AND action_key = ?", [caseId, actionKey]);
        await tx.run(
          `INSERT INTO automod_action_journal (namespace, case_id, action_key, status, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [this.namespace, caseId, actionKey, record.status, updatedAt],
        );
        return;
      }
      case "import-ledger": {
        const ledgerSourceId = requiredString(record.ledgerSourceId, "migration import source ID");
        const ledgerImportId = requiredString(record.ledgerImportId, "migration import record ID");
        const ledgerImportedAt = stateTime(record.ledgerImportedAt, "migration import time");
        if (record.ledgerRecordDigest !== null &&
          (typeof record.ledgerRecordDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.ledgerRecordDigest))) {
          throw new StorageError("Migration import digest is invalid.");
        }
        await requireUnused("automod_state_imports", "source_id = ? AND import_id = ?", [ledgerSourceId, ledgerImportId]);
        await tx.run(
          `INSERT INTO automod_state_imports (namespace, source_id, import_id, imported_at, record_digest)
           VALUES (?, ?, ?, ?, ?)` ,
          [this.namespace, ledgerSourceId, ledgerImportId, ledgerImportedAt, record.ledgerRecordDigest],
        );
        return;
      }
      case "budget": {
        const nextAt = stateTime(record.nextAt, "API interval time");
        const blockedUntil = stateTime(record.blockedUntil, "API cooldown time");
        const apiRequests = stateTime(record.apiRequests, "API request count");
        await tx.run(
          `UPDATE automod_api_budget SET next_at = ?, blocked_until = ?, api_requests = ?
           WHERE namespace = ?`,
          [nextAt, blockedUntil, apiRequests, this.namespace],
        );
        return;
      }
      default:
        throw new StorageError("Migration record kind is unsupported.");
    }
  }
}
