import "./setup.js";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { REPO_MAP_WARM_QUEUE_NAME, enqueueRepoMapWarmJob, queueConnection } from "../index.js";

const inspectQueue = new Queue(REPO_MAP_WARM_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

describe("enqueueRepoMapWarmJob", () => {
  it("adds a job carrying the org id and repo name", async () => {
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("warm-repo-map");
    expect(jobs[0].data).toEqual({ orgId: 1, repoFullName: "acme-corp/backend" });
  });

  it("collapses duplicate warm requests for the same org+repo into one job", async () => {
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
  });

  it("keeps jobs for different orgs or repos independent", async () => {
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");
    await enqueueRepoMapWarmJob(2, "acme-corp/backend");
    await enqueueRepoMapWarmJob(1, "acme-corp/frontend");

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(3);
  });
});
