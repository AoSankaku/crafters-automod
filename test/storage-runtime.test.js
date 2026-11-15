import { afterEach, describe, expect, test } from "#test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { NodeSQLiteDatabase } from "../src/storage/sqlite-node.js";

const directories = [];
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "automod-sqlite-node-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("automod-sqlite-node-")) {
      throw new Error("Unexpected test fixture directory.");
    }
    await rm(path, { recursive: true, force: true });
  }
});

describe("Node SQLite driver", () => {
  test("supports the Bun-compatible query and statement surface", async () => {
    const database = new NodeSQLiteDatabase(join(await fixture(), "storage with spaces.sqlite"), {
      create: true,
      readwrite: true,
    });
    try {
      database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
      const insert = database.query("INSERT INTO sample (value) VALUES (?)");
      try {
        const result = insert.run("first");
        expect(Number(result.changes)).toBe(1);
        expect(Number(result.lastInsertRowid)).toBe(1);
      } finally {
        insert.finalize();
      }

      const select = database.query("SELECT id, value FROM sample WHERE id = ?");
      try {
        expect(select.get(1)).toEqual({ id: 1, value: "first" });
        expect(select.all(1)).toEqual([{ id: 1, value: "first" }]);
      } finally {
        select.finalize();
      }

      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      const pragmas = database.query("PRAGMA journal_mode;");
      const journalMode = pragmas.get();
      pragmas.finalize();
      expect(journalMode.journal_mode).toBe("wal");
      const synchronous = database.query("PRAGMA synchronous;");
      const synchronousMode = synchronous.get();
      synchronous.finalize();
      expect(synchronousMode.synchronous).toBe(2);
      const busyTimeout = database.query("PRAGMA busy_timeout;");
      const busyTimeoutValue = busyTimeout.get();
      busyTimeout.finalize();
      expect(busyTimeoutValue.timeout).toBe(5000);
    } finally {
      database.close(true);
    }
  });

  test("opens an existing database writable without changing its contents", async () => {
    const path = join(await fixture(), "source.sqlite");
    const created = new NodeSQLiteDatabase(path, { create: true, readwrite: true });
    created.exec("CREATE TABLE source_state (value TEXT NOT NULL); INSERT INTO source_state VALUES ('preserved');");
    created.close(true);

    const reopened = new NodeSQLiteDatabase(path, { create: false, readwrite: true });
    try {
      const query = reopened.query("SELECT value FROM source_state");
      try {
        expect(query.get().value).toBe("preserved");
      } finally {
        query.finalize();
      }
      reopened.exec("INSERT INTO source_state VALUES ('writable');");
    } finally {
      reopened.close(true);
    }
  });

  test("refuses to create a missing source when create is false", async () => {
    const path = join(await fixture(), "must-not-be-created.sqlite");
    expect(() => new NodeSQLiteDatabase(path, { create: false, readwrite: true })).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  test("rolls back a transaction using the shared BEGIN IMMEDIATE boundary", async () => {
    const database = new NodeSQLiteDatabase(join(await fixture(), "rollback.sqlite"), {
      create: true,
      readwrite: true,
    });
    database.exec("CREATE TABLE sample (value TEXT NOT NULL);");
    database.exec("BEGIN IMMEDIATE;");
    const insert = database.query("INSERT INTO sample (value) VALUES (?)");
    insert.run("rolled back");
    insert.finalize();
    database.exec("ROLLBACK;");

    const select = database.query("SELECT value FROM sample");
    try {
      expect(select.all()).toEqual([]);
    } finally {
      select.finalize();
      database.close(true);
    }
  });
});
