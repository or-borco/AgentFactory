// A small, dependency-free structured logger shared by apps/web and apps/worker.
//
// Why not pino/winston: apps/web runs inside Next.js's server bundler and apps/worker ships a
// sandbox image built from a slim Docker context — both are picky about native/worker-thread
// dependencies (pino's pretty-printer and transports pull in `thread-stream` and dynamic
// `require`s that don't survive bundling cleanly). A few dozen lines of plain JS avoids that
// whole class of problem while still giving every caller levels, timestamps, structured context,
// and per-module/per-request child loggers instead of bare `console.log`.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a new logger that merges `bindings` into every entry it logs. */
  child(bindings: LogContext): Logger;
}

function resolveLevel(): LogLevel {
  const fromEnv = process.env.LOG_LEVEL?.toLowerCase();
  if (fromEnv === "debug" || fromEnv === "info" || fromEnv === "warn" || fromEnv === "error") {
    return fromEnv;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

// Errors don't survive JSON.stringify (own properties only, no message/stack) — pull the fields
// that matter out explicitly so `logger.error("...", { err })` actually shows the failure.
function serializeContext(context: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return out;
}

const RESET = "\x1b[0m";
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};

// JSON lines in production (log-aggregator friendly); a short colored line in local dev so the
// terminal stays readable. Both branches carry the same information.
function usePrettyOutput(): boolean {
  return process.env.NODE_ENV !== "production" && Boolean(process.stdout.isTTY);
}

class BaseLogger implements Logger {
  private readonly bindings: LogContext;
  private readonly level: LogLevel;

  constructor(bindings: LogContext = {}, level: LogLevel = resolveLevel()) {
    this.bindings = bindings;
    this.level = level;
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;

    const mergedContext = { ...this.bindings, ...(context ? serializeContext(context) : {}) };
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;

    if (usePrettyOutput()) {
      const time = new Date().toISOString().slice(11, 23); // HH:mm:ss.sss, local terminal only
      const contextStr = Object.keys(mergedContext).length > 0 ? ` ${JSON.stringify(mergedContext)}` : "";
      stream.write(`${LEVEL_COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET} ${time} ${message}${contextStr}\n`);
      return;
    }

    stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...mergedContext })}\n`);
  }

  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  child(bindings: LogContext): Logger {
    return new BaseLogger({ ...this.bindings, ...bindings }, this.level);
  }
}

/** Root logger. Prefer `createLogger(name)` at each call site instead of using this directly. */
export const logger: Logger = new BaseLogger();

/** A logger scoped to one module/component, tagged with `module` on every entry it writes. */
export function createLogger(module: string, bindings: LogContext = {}): Logger {
  return logger.child({ module, ...bindings });
}
