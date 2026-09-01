import "./setup.js";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TEAM_CONTEXT_INGEST_QUEUE_NAME, enqueueTeamContextIngestJob, queueConnection } from "../index.js";

const inspectQueue = new Queue(TEAM_CONTEXT_INGEST_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

describe("enqueueTeamContextIngestJob", () => {
  it("adds a job carrying the item id to the queue", async () => {
    await enqueueTeamContextIngestJob(12);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("ingest-context-item");
    expect(jobs[0].data).toEqual({ itemId: 12 });
  });

  // The first retry configuration in this repo — asserted rather than assumed, because the
  // ingest handler's status guard (pending | indexing) is only correct in company with it.
  it("configures three attempts with exponential backoff", async () => {
    await enqueueTeamContextIngestJob(12);

    const [job] = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: "exponential", delay: 5000 });
  });

  it("collapses a double upload of the same item into one job", async () => {
    await enqueueTeamContextIngestJob(12);
    await enqueueTeamContextIngestJob(12);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("item-12");
  });

  it("keeps jobs for different items independent", async () => {
    await enqueueTeamContextIngestJob(1);
    await enqueueTeamContextIngestJob(2);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs.map((job) => job.data.itemId).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
