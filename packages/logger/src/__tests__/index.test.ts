import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, logger } from "../index";

// process.stdout.isTTY is false under vitest, so the logger always takes its JSON branch here —
// exactly the shape a log aggregator in production would see.
function captured(stream: NodeJS.WriteStream) {
  const spy = vi.spyOn(stream, "write").mockImplementation(() => true);
  return spy;
}

function lastLine(spy: ReturnType<typeof captured>) {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error("logger never wrote to the stream");
  return JSON.parse(String(call[0]));
}

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes info/debug/warn to stdout and error/warn to the right level field", () => {
    const stdout = captured(process.stdout);
    logger.info("hello", { runId: 42 });
    const entry = lastLine(stdout);
    expect(entry).toMatchObject({ level: "info", msg: "hello", runId: 42 });
    expect(typeof entry.time).toBe("string");
  });

  it("routes warn and error to stderr", () => {
    const stderr = captured(process.stderr);
    logger.error("boom");
    expect(lastLine(stderr)).toMatchObject({ level: "error", msg: "boom" });

    logger.warn("careful");
    expect(lastLine(stderr)).toMatchObject({ level: "warn", msg: "careful" });
  });

  it("serializes Error context into name/message/stack instead of dropping it", () => {
    const stderr = captured(process.stderr);
    const err = new Error("db timeout");
    logger.error("query failed", { err });
    const entry = lastLine(stderr);
    expect(entry.err).toMatchObject({ name: "Error", message: "db timeout" });
    expect(typeof entry.err.stack).toBe("string");
  });

  it("child() merges bindings into every subsequent entry", () => {
    const stdout = captured(process.stdout);
    const scoped = createLogger("worker", { runId: 7 });
    scoped.info("started");
    expect(lastLine(stdout)).toMatchObject({ module: "worker", runId: 7, msg: "started" });

    const nested = scoped.child({ jobId: "abc" });
    nested.info("progressing");
    expect(lastLine(stdout)).toMatchObject({ module: "worker", runId: 7, jobId: "abc", msg: "progressing" });
  });

  it("call-site context overrides bound context with the same key", () => {
    const stdout = captured(process.stdout);
    const scoped = createLogger("worker", { runId: 7 });
    scoped.info("overridden", { runId: 99 });
    expect(lastLine(stdout)).toMatchObject({ runId: 99 });
  });
});
