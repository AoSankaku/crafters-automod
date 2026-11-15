export async function openSQLite(path, options) {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    return new Database(path, options);
  }
  const { NodeSQLiteDatabase } = await import("./sqlite-node.js");
  return new NodeSQLiteDatabase(path, options);
}

export async function openPostgres(databaseUrl, options = {}) {
  if (process.versions.bun) {
    const { SQL } = await import("bun");
    return new SQL(databaseUrl, options);
  }

  const postgresModule = await import("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, {
    max: options.max ?? 5,
    connect_timeout: options.connectionTimeout ?? 5,
    onnotice: () => {},
  });
  return new NodePostgresClient(sql);
}

class NodePostgresClient {
  constructor(sql) {
    this.sql = sql;
  }

  unsafe(query, parameters) {
    return this.sql.unsafe(query, parameters);
  }

  begin(callback) {
    return this.sql.begin((transaction) => callback(new NodePostgresTransaction(transaction)));
  }

  close() {
    return this.sql.end({ timeout: 5 });
  }
}

class NodePostgresTransaction {
  constructor(transaction) {
    this.transaction = transaction;
  }

  unsafe(query, parameters) {
    return this.transaction.unsafe(query, parameters);
  }
}
