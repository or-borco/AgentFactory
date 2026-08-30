import "./setup.js";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EVAL_QUEUE_NAME, enqueueEvalJob, queueConnection } from "../index.js";

const inspectQueue = new Queue(EVAL_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

describe("enqueueEvalJob", () => {
  it("adds a job carrying the eval id to the queue", async () => {
    await enqueueEvalJob(7);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("process-eval");
    expect(jobs[0].data).toEqual({ evalId: 7 });
  });

  it("enqueues multiple jobs independently", async () => {
    await enqueueEvalJob(1);
    await enqueueEvalJob(2);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs.map((job) => job.data.evalId).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
