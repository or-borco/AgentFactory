import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, logger } from "../index";

// process.stdout.isTTY is false under vitest, so the logger always takes its JSON branch here —
// exactly the shape a log aggregator in production would see. Everything goes to stdout: pino's
// default single-stream behavior, with `level` field distinguishing severity for the aggregator
// rather than the process splitting streams itself.
function captured() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

function lastLine(spy: ReturnType<typeof captured>) {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error("logger never wrote to the stream");
  return JSON.parse(String(call[0]));
}

// pino's numeric level values: debug=20, info=30, warn=40, error=50.
const LEVEL = { debug: 20, info: 30, warn: 40, error: 50 };

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes info to stdout with the right level and message", () => {
    const stdout = captured();
    logger.info("hello", { runId: 42 });
    const entry = lastLine(stdout);
    expect(entry).toMatchObject({ level: LEVEL.info, msg: "hello", runId: 42 });
    expect(typeof entry.time).toBe("string");
  });

  it("writes warn and error with their own level", () => {
    const stdout = captured();
    logger.error("boom");
    expect(lastLine(stdout)).toMatchObject({ level: LEVEL.error, msg: "boom" });

    logger.warn("careful");
    expect(lastLine(stdout)).toMatchObject({ level: LEVEL.warn, msg: "careful" });
  });

  it("serializes Error context into message/stack instead of dropping it", () => {
    const stdout = captured();
    const err = new Error("db timeout");
    logger.error("query failed", { err });
    const entry = lastLine(stdout);
    expect(entry.err).toMatchObject({ message: "db timeout" });
    expect(typeof entry.err.stack).toBe("string");
  });

  it("child() merges bindings into every subsequent entry", () => {
    const stdout = captured();
    const scoped = createLogger("worker", { runId: 7 });
    scoped.info("started");
    expect(lastLine(stdout)).toMatchObject({ module: "worker", runId: 7, msg: "started" });

    const nested = scoped.child({ jobId: "abc" });
    nested.info("progressing");
    expect(lastLine(stdout)).toMatchObject({ module: "worker", runId: 7, jobId: "abc", msg: "progressing" });
  });

  it("call-site context overrides bound context with the same key", () => {
    const stdout = captured();
    const scoped = createLogger("worker", { runId: 7 });
    scoped.info("overridden", { runId: 99 });
    expect(lastLine(stdout)).toMatchObject({ runId: 99 });
  });
});
