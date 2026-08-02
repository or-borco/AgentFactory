import "./setup.js";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RUN_QUEUE_NAME, enqueueRunJob, queueConnection } from "../index.js";

const inspectQueue = new Queue(RUN_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

describe("enqueueRunJob", () => {
  it("adds a job carrying the run id to the queue", async () => {
    await enqueueRunJob(42);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("process-run");
    expect(jobs[0].data).toEqual({ runId: 42 });
  });

  it("enqueues multiple jobs independently", async () => {
    await enqueueRunJob(1);
    await enqueueRunJob(2);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs.map((job) => job.data.runId).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
