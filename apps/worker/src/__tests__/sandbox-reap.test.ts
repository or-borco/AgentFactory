import { describe, expect, it, vi } from "vitest";
import type { Session } from "@agentfactory/core";

const listIdleSandboxSessionsMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  listIdleSandboxSessions: (...args: unknown[]) => listIdleSandboxSessionsMock(...args),
}));

// @agentfactory/queue's module body throws unless REDIS_URL is set — mocked here so this stays
// a unit test with no Redis dependency, same as repo-map.test.ts.
const enqueueSandboxTeardownJobMock = vi.fn();
vi.mock("@agentfactory/queue", () => ({
  enqueueSandboxTeardownJob: (...args: unknown[]) => enqueueSandboxTeardownJobMock(...args),
}));

const { scanForIdleSandboxes } = await import("../sandbox-reap");

function fakeSession(id: number): Session {
  return {
    id,
    agentId: 1,
    title: "Test session",
    origin: "web",
    sandboxId: "sandbox-abc",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActivityAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("scanForIdleSandboxes", () => {
  it("enqueues a teardown job for exactly each session the scan returns, nothing else", async () => {
    listIdleSandboxSessionsMock.mockReset().mockResolvedValue([fakeSession(1), fakeSession(2)]);
    enqueueSandboxTeardownJobMock.mockReset().mockResolvedValue(undefined);

    const count = await scanForIdleSandboxes();

    expect(count).toBe(2);
    expect(enqueueSandboxTeardownJobMock).toHaveBeenCalledTimes(2);
    expect(enqueueSandboxTeardownJobMock).toHaveBeenNthCalledWith(1, 1);
    expect(enqueueSandboxTeardownJobMock).toHaveBeenNthCalledWith(2, 2);
  });

  it("enqueues nothing when the scan returns no idle sessions", async () => {
    listIdleSandboxSessionsMock.mockReset().mockResolvedValue([]);
    enqueueSandboxTeardownJobMock.mockReset().mockResolvedValue(undefined);

    const count = await scanForIdleSandboxes();

    expect(count).toBe(0);
    expect(enqueueSandboxTeardownJobMock).not.toHaveBeenCalled();
  });
});
