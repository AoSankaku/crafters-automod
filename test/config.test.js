import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  test("requires explicit opt-in for external reputation and extra IP disclosure", () => {
    const env = { MISSKEY_URL: "https://misskey.example", MISSKEY_TOKEN: "token" };
    expect(loadConfig(env).stopForumSpam).toEqual({ enabled: false, checkIp: false, intervalMs: 1100, maxDailyRequests: 5000, cacheTtlMs: 21600000, failureTtlMs: 300000 });
    expect(loadConfig({ ...env, SFS_ENABLED: "true", SFS_CHECK_IP: "true" }).stopForumSpam.checkIp).toBe(true);
    for (const change of [{ SFS_ENABLED: "yes" }, { SFS_CHECK_IP: "true" }, { SFS_MIN_INTERVAL_MS: "0" }, { SFS_MAX_DAILY_REQUESTS: "0" }]) {
      expect(() => loadConfig({ ...env, ...change })).toThrow();
    }
  });
  test("invalid URLs never echo credentials in errors", () => {
    expect(() => loadConfig({ MISSKEY_URL: "invalid-private-url", MISSKEY_TOKEN: "private-token" })).toThrow(/MISSKEY_URL must/);
  });
  test("defaults to dry-run", () => {
    const config = loadConfig(
      { MISSKEY_URL: "https://misskey.example/", MISSKEY_TOKEN: "token" },
      "C:\\automod",
    );

    expect(config.mode).toBe("dry-run");
    expect(config.baseUrl).toBe("https://misskey.example");
    expect(config.minimumActionIntervalMs).toBe(1_100);
    expect(config.maxQueuedJobs).toBe(100_000);
    expect(config.maxPendingNotes).toBe(1_000);
    expect(config.reviewDelayMs).toBe(900_000);
    expect(config.t2RoleId).toBeNull();
    expect(config.dataDirectory.toLowerCase()).toEndWith("automod\\data");
  });

  test("rejects missing secrets and unsafe URL components", () => {
    expect(() => loadConfig({ MISSKEY_URL: "https://misskey.example" })).toThrow(/MISSKEY_TOKEN/);
    expect(() =>
      loadConfig({ MISSKEY_URL: "https://user:pass@misskey.example", MISSKEY_TOKEN: "token" }),
    ).toThrow(/credentials/);
    expect(() =>
      loadConfig({ MISSKEY_URL: "file:///etc/passwd", MISSKEY_TOKEN: "token" }),
    ).toThrow(/http or https/);
  });

  test("rejects an unknown enforcement mode", () => {
    expect(() =>
      loadConfig({
        MISSKEY_URL: "https://misskey.example",
        MISSKEY_TOKEN: "token",
        AUTOMOD_MODE: "enabled",
      }),
    ).toThrow(/dry-run or enforce/);
  });

  test("bounds the in-memory note processing capacity", () => {
    const env = { MISSKEY_URL: "https://misskey.example", MISSKEY_TOKEN: "token", MAX_PENDING_NOTES: "25" };
    expect(loadConfig(env).maxPendingNotes).toBe(25);
    for (const value of ["0", "1.5", "100001", "invalid"]) {
      expect(() => loadConfig({ ...env, MAX_PENDING_NOTES: value })).toThrow(/MAX_PENDING_NOTES/);
    }
  });

  test("defaults to one SQLite process and validates distributed configuration", () => {
    const env = { MISSKEY_URL: "https://misskey.example", MISSKEY_TOKEN: "token" };
    const local = loadConfig(env);
    expect(local.storageBackend).toBe("sqlite");
    expect(local.role).toBe("all");
    expect(local.workerConcurrency).toBe(1);
    expect(local.maxInboxJobs).toBe(100_000);
    expect(local.maxWorkAttempts).toBe(5);
    expect(local.namespace).toMatch(/^[a-f0-9]{32}$/);
    const remote = loadConfig({ ...env, AUTOMOD_BACKEND: "postgres", AUTOMOD_ROLE: "worker", AUTOMOD_DATABASE_URL: "postgresql://automod:test-password@db/automod", WORKER_CONCURRENCY: "4" });
    expect(remote.storageBackend).toBe("postgres");
    expect(remote.role).toBe("worker");
    expect(remote.workerConcurrency).toBe(4);
    for (const changes of [
      { AUTOMOD_BACKEND: "unknown" }, { AUTOMOD_BACKEND: "postgres" },
      { AUTOMOD_ROLE: "worker" }, { WORKER_CONCURRENCY: "2" }, { MIN_ACTION_INTERVAL_MS: "0" },
      { WORK_MAX_ATTEMPTS: "0" }, { WORK_LEASE_MS: "100" },
    ]) {
      expect(() => loadConfig({ ...env, ...changes })).toThrow();
    }
  });
});
