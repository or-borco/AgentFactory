import "./setup.js";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MEMORY_RETROSPECTIVE_QUEUE_NAME, enqueueMemoryRetrospectiveJob, queueConnection } from "../index.js";

const inspectQueue = new Queue(MEMORY_RETROSPECTIVE_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

describe("enqueueMemoryRetrospectiveJob", () => {
  it("adds a job carrying orgId, agentId, and sessionId to the queue", async () => {
    await enqueueMemoryRetrospectiveJob(1, 2, 3);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("process-memory-retrospective");
    expect(jobs[0].data).toEqual({ orgId: 1, agentId: 2, sessionId: 3 });
  });

  it("is safely retriable: BullMQ's default job settings allow redelivery", async () => {
    await enqueueMemoryRetrospectiveJob(1, 2, 3);
    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    // No jobId collapsing (unlike the repo-map-warm queue) - unlike a warm request, two
    // retrospective jobs for the same session are not meant to be deduplicated; each terminal
    // status transition is its own event worth a pass, and the write path's own dedup (weight
    // reinforcement) is what makes a redelivered or duplicate pass safe, not queue-level jobId
    // collapsing.
    expect(jobs[0].opts.jobId).toBeUndefined();
  });
});
