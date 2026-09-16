import { describe, expect, it, vi } from "vitest";

const countPendingTaskContextItemsMock = vi.fn();
const countPendingTeamContextItemsMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  countPendingTaskContextItems: (...args: unknown[]) => countPendingTaskContextItemsMock(...args),
  countPendingTeamContextItems: (...args: unknown[]) => countPendingTeamContextItemsMock(...args),
}));

const {
  INGEST_POLL_INTERVAL_MS,
  INGEST_POLL_TIMEOUT_MS,
  waitForPendingContextIngest,
} = await import("../context-ingest-wait");

const instantSleep = () => Promise.resolve();
const POLL_ATTEMPTS = Math.floor(INGEST_POLL_TIMEOUT_MS / INGEST_POLL_INTERVAL_MS);

describe("waitForPendingContextIngest", () => {
  it("returns immediately without sleeping when nothing is pending", async () => {
    countPendingTaskContextItemsMock.mockReset().mockResolvedValue(0);
    countPendingTeamContextItemsMock.mockReset().mockResolvedValue(0);
    const sleep = vi.fn(instantSleep);

    await waitForPendingContextIngest({ teamId: 1, taskId: 2 }, { sleep });

    expect(sleep).not.toHaveBeenCalled();
  });

  it("only checks the scopes it was given", async () => {
    countPendingTaskContextItemsMock.mockReset().mockResolvedValue(0);
    countPendingTeamContextItemsMock.mockReset().mockResolvedValue(0);

    await waitForPendingContextIngest({ taskId: 2 }, { sleep: instantSleep });

    expect(countPendingTaskContextItemsMock).toHaveBeenCalledWith(2, expect.any(Date));
    expect(countPendingTeamContextItemsMock).not.toHaveBeenCalled();
  });

  it("polls until the pending count clears, then stops", async () => {
    countPendingTeamContextItemsMock.mockReset();
    countPendingTaskContextItemsMock
      .mockReset()
      .mockResolvedValueOnce(1) // initial check
      .mockResolvedValueOnce(1) // poll 1
      .mockResolvedValueOnce(1) // poll 2
      .mockResolvedValue(0); // poll 3
    const sleep = vi.fn(instantSleep);

    await waitForPendingContextIngest({ taskId: 2 }, { sleep });

    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(INGEST_POLL_INTERVAL_MS);
  });

  it("gives up after the full poll window rather than waiting forever", async () => {
    countPendingTeamContextItemsMock.mockReset();
    countPendingTaskContextItemsMock.mockReset().mockResolvedValue(1);
    const sleep = vi.fn(instantSleep);

    await waitForPendingContextIngest({ taskId: 2 }, { sleep });

    expect(sleep).toHaveBeenCalledTimes(POLL_ATTEMPTS);
    // One check before the loop, then one per attempt.
    expect(countPendingTaskContextItemsMock).toHaveBeenCalledTimes(POLL_ATTEMPTS + 1);
  });

  it("sums team and task pending counts to decide whether to poll", async () => {
    countPendingTaskContextItemsMock.mockReset().mockResolvedValue(0);
    countPendingTeamContextItemsMock.mockReset().mockResolvedValue(1);
    const sleep = vi.fn(instantSleep);

    await waitForPendingContextIngest({ teamId: 1, taskId: 2 }, { sleep });

    expect(sleep).toHaveBeenCalled();
  });

  it("does not throw when the count query itself throws", async () => {
    countPendingTaskContextItemsMock.mockReset().mockRejectedValue(new Error("db down"));
    countPendingTeamContextItemsMock.mockReset();

    await expect(
      waitForPendingContextIngest({ taskId: 2 }, { sleep: instantSleep }),
    ).resolves.toBeUndefined();
  });

  it("returns immediately when scope has neither teamId nor taskId", async () => {
    countPendingTaskContextItemsMock.mockReset();
    countPendingTeamContextItemsMock.mockReset();
    const sleep = vi.fn(instantSleep);

    await waitForPendingContextIngest({}, { sleep });

    expect(sleep).not.toHaveBeenCalled();
    expect(countPendingTaskContextItemsMock).not.toHaveBeenCalled();
    expect(countPendingTeamContextItemsMock).not.toHaveBeenCalled();
  });

  it("keeps the poll window and interval in a sane relationship", () => {
    expect(INGEST_POLL_TIMEOUT_MS).toBeGreaterThan(INGEST_POLL_INTERVAL_MS);
    expect(INGEST_POLL_TIMEOUT_MS % INGEST_POLL_INTERVAL_MS).toBe(0);
  });
});
