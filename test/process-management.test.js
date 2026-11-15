import { describe, expect, test } from "#test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { registerShutdownHandlers } from "../src/shutdown.js";

describe("process-manager shutdown", () => {
  for (const event of ["SIGINT", "SIGTERM"]) test(`${event} requests graceful application shutdown`, () => {
    const events = new EventEmitter();
    const controller = new AbortController();
    const unregister = registerShutdownHandlers(controller, events);
    events.emit(event);
    expect(controller.signal.aborted).toBe(true);
    unregister();
    expect(events.listenerCount("message")).toBe(0);
  });

  test("PM2's exact shutdown message aborts; unrelated IPC does not", () => {
    const events = new EventEmitter();
    const controller = new AbortController();
    const unregister = registerShutdownHandlers(controller, events);
    events.emit("message", { type: "shutdown" });
    events.emit("message", "ready");
    expect(controller.signal.aborted).toBe(false);
    events.emit("message", "shutdown");
    expect(controller.signal.aborted).toBe(true);
    unregister();
  });

  test("cleanup removes only its own handlers", () => {
    const events = new EventEmitter();
    const existing = () => {};
    events.on("SIGTERM", existing);
    const controller = new AbortController();
    const unregister = registerShutdownHandlers(controller, events);
    unregister();
    events.emit("SIGINT");
    events.emit("message", "shutdown");
    expect(controller.signal.aborted).toBe(false);
    expect(events.listeners("SIGTERM")).toEqual([existing]);
  });
});

describe("PM2 deployment safety", () => {
  const require = createRequire(import.meta.url);
  for (const filename of ["../ecosystem.config.cjs", "../ecosystem.bun.config.cjs"]) {
    test(`${filename} manages a single foreground process with a graceful stop budget`, () => {
      const { apps } = require(filename);
      expect(apps).toHaveLength(1);
      const app = apps[0];
      expect(app.name).toBe("crafters-automod");
      expect(app.exec_mode).toBe("fork");
      expect(app.instances).toBe(1);
      expect(app.force).not.toBe(true);
      expect(app.watch).toBe(false);
      expect(app.shutdown_with_message).toBe(true);
      expect(app.kill_timeout).toBeGreaterThanOrEqual(30000);
      expect(isAbsolute(app.cwd)).toBe(true);
      expect(isAbsolute(app.script)).toBe(true);
      expect(app.env?.AUTOMOD_MODE).not.toBe("enforce");
      expect(Object.keys(app.env ?? {}).some((key) => /TOKEN|PASSWORD|SECRET/u.test(key))).toBe(false);
    });
  }
});
