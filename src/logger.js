export class Logger {
  write(level, message, context = {}) {
    const safeContext = sanitizeContext(context);
    const entry = { timestamp: new Date().toISOString(), level, message, ...safeContext };
    const output = JSON.stringify(entry);
    if (level === "error") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.info(output);
  }

  info(message, context) {
    this.write("info", message, context);
  }

  warn(message, context) {
    this.write("warn", message, context);
  }

  error(message, error, context = {}) {
    this.write("error", message, {
      ...context,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

function sanitizeContext(context) {
  return Object.fromEntries(
    Object.entries(context).filter(([key]) => !/(token|authorization|secret|password)/iu.test(key)),
  );
}
