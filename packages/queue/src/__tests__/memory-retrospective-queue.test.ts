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
  it("adds a job carrying orgId, agentId and sessionId, keyed by session and latest run", async () => {
    await enqueueMemoryRetrospectiveJob(1, 2, 3, 40);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("process-memory-retrospective");
    expect(jobs[0].data).toEqual({ orgId: 1, agentId: 2, sessionId: 3 });
    expect(jobs[0].opts.jobId).toBe("retro-3-40");
    expect(jobs[0].opts.attempts).toBe(3);
    expect(jobs[0].opts.backoff).toEqual({ type: "exponential", delay: 5000 });
  });

  it("collapses a second enqueue for the same session state, but not a later run", async () => {
    await enqueueMemoryRetrospectiveJob(1, 2, 3, 40);
    await enqueueMemoryRetrospectiveJob(1, 2, 3, 40);
    await enqueueMemoryRetrospectiveJob(1, 2, 3, 41);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs.map((j) => j.opts.jobId).sort()).toEqual(["retro-3-40", "retro-3-41"]);
  });
});
