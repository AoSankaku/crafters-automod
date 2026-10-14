import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
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
});
