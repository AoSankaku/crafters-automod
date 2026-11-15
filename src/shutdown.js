/** PM2 uses IPC shutdown on Windows; systemd and terminals use signals. */
export function registerShutdownHandlers(controller, events = process) {
  const shutdown = () => controller.abort();
  const message = (value) => { if (value === "shutdown") shutdown(); };
  events.once("SIGINT", shutdown);
  events.once("SIGTERM", shutdown);
  events.on("message", message);
  return () => {
    events.removeListener("SIGINT", shutdown);
    events.removeListener("SIGTERM", shutdown);
    events.removeListener("message", message);
  };
}
