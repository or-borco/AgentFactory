// A structured logger shared by apps/web and apps/worker, built on pino — the most widely used
// structured logging library for Node.js. Wrapped behind the same small `Logger` interface the
// rest of the codebase already calls (`debug/info/warn/error` + `child()`) so call sites don't
// depend on pino's API directly and the backend can change without touching them again.
//
// pino-pretty is wired in as a plain synchronous destination stream (not through pino's
// `transport` option, which spawns a worker thread running a separate transport file off disk —
// that doesn't survive Next.js's server bundling). This way apps/web and apps/worker each stay a
// single process with no worker thread and no dynamic `require` for a transport target.

import pino from "pino";
import pinoPretty from "pino-pretty";

export type LogLevel = "debug" | "info" | "warn" | "error";

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

// JSON lines in production and under test (log-aggregator friendly, and what a TTY-less CI run
// sees); a short colored line in a local interactive terminal so it stays readable. Both carry
// the same fields.
function usePrettyOutput(): boolean {
  return process.env.NODE_ENV !== "production" && Boolean(process.stdout.isTTY);
}

// Explicit `process.stdout` rather than leaving the destination unset: pino's default (no
// destination given) writes straight to fd 1 through sonic-boom, bypassing `process.stdout.write`
// entirely — fine in production, but it means nothing can capture output in tests the normal way
// (`vi.spyOn(process.stdout, "write")`). Passing the stream directly keeps that working, at the
// cost of the (here, unneeded) extra throughput sonic-boom's fd-level writes buy you.
const destination = usePrettyOutput()
  ? pinoPretty({ colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" })
  : process.stdout;

// `base: null` drops pino's default pid/hostname fields — every line already carries `module`
// (see createLogger below), and pid/hostname are noise in a single-process container. `err` is
// serialized via pino's built-in error serializer (name/message/stack), so `logger.error("...",
// { err })` shows the failure instead of an empty `{}` from JSON.stringify-ing an Error.
const root = pino(
  {
    level: resolveLevel(),
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
);

class PinoLogger implements Logger {
  constructor(private readonly instance: pino.Logger) {}

  debug(message: string, context: LogContext = {}): void {
    this.instance.debug(context, message);
  }

  info(message: string, context: LogContext = {}): void {
    this.instance.info(context, message);
  }

  warn(message: string, context: LogContext = {}): void {
    this.instance.warn(context, message);
  }

  error(message: string, context: LogContext = {}): void {
    this.instance.error(context, message);
  }

  child(bindings: LogContext): Logger {
    return new PinoLogger(this.instance.child(bindings));
  }
}

/** Root logger. Prefer `createLogger(name)` at each call site instead of using this directly. */
export const logger: Logger = new PinoLogger(root);

/** A logger scoped to one module/component, tagged with `module` on every entry it writes. */
export function createLogger(module: string, bindings: LogContext = {}): Logger {
  return logger.child({ module, ...bindings });
}
