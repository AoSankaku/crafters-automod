import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export class NodeSQLiteDatabase {
  constructor(path, { create = true, readwrite = true } = {}) {
    const openPath = sqliteOpenPath(path, { create, readwrite });
    this.database = new DatabaseSync(openPath, {
      readOnly: !readwrite,
      timeout: 5_000,
    });
  }

  exec(query) {
    return this.database.exec(query);
  }

  query(query) {
    return new NodeSQLiteStatement(this.database.prepare(query));
  }

  close() {
    return this.database.close();
  }
}

function sqliteOpenPath(path, { create, readwrite }) {
  if (typeof path !== "string" || !path) throw new TypeError("SQLite path is required.");
  if (create || path === ":memory:") return path;

  // SQLite's URI mode=rw opens writable without CREATE, avoiding an existence-check race.
  const url = pathToFileURL(path);
  url.searchParams.set("mode", readwrite ? "rw" : "ro");
  return url;
}

class NodeSQLiteStatement {
  constructor(statement) {
    this.statement = statement;
  }

  all(...parameters) {
    return this.requireOpen().all(...parameters).map(toPlainRow);
  }

  get(...parameters) {
    const row = this.requireOpen().get(...parameters);
    return row === undefined ? null : toPlainRow(row);
  }

  run(...parameters) {
    return this.requireOpen().run(...parameters);
  }

  finalize() {
    // Node's StatementSync has no finalize API. Releasing this reference lets SQLite
    // dispose of the prepared statement; the durable adapter finalizes after each use.
    this.statement = null;
  }

  requireOpen() {
    if (!this.statement) throw new Error("SQLite statement is finalized.");
    return this.statement;
  }
}

function toPlainRow(row) {
  return Object.fromEntries(Object.entries(row));
}
