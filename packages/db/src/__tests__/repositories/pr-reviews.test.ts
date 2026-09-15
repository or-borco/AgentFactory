import { describe, expect, it } from "vitest";
import "../setup.js";
import { createRun } from "../../repositories/runs.js";
import { createPrReview, getLatestPrReview, listPrReviewsForTask } from "../../repositories/pr-reviews.js";
import { insertAgent, insertOrg, insertSession, insertTask, insertUser } from "../fixtures.js";

async function setupTaskAndRun() {
  const org = await insertOrg();
  const user = await insertUser();
  const agent = await insertAgent(org.id);
  const session = await insertSession(org.id, agent.id);
  const task = await insertTask(org.id, user.id);
  const run = await createRun(session.id);
  return { org, task, run };
}

const INPUT = {
  repoFullName: "acme-org/platform",
  prNumber: 42,
  baseSha: "basesha1",
  headSha: "headsha1",
  verdict: "comment" as const,
  postedAs: "comment" as const,
  githubReviewId: "555",
  url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
  commentCount: 3,
  truncated: false,
};

describe("pr-reviews repository", () => {
  it("creates a review row and reads it back", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const review = await createPrReview(org.id, task.id, run.id, INPUT);

    expect(review).toMatchObject({ orgId: org.id, taskId: task.id, runId: run.id, ...INPUT });
    expect(review.createdAt).toBeDefined();
  });

  it("getLatestPrReview returns the most recently created row for the task, org-scoped", async () => {
    const { org, task, run } = await setupTaskAndRun();
    await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha1" });
    const second = await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha2" });

    await expect(getLatestPrReview(task.id, org.id)).resolves.toEqual(second);
  });

  it("getLatestPrReview returns undefined for a task with no reviews", async () => {
    const { org, task } = await setupTaskAndRun();
    await expect(getLatestPrReview(task.id, org.id)).resolves.toBeUndefined();
  });

  it("getLatestPrReview does not leak a review across orgs", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const otherOrg = await insertOrg();
    await createPrReview(org.id, task.id, run.id, INPUT);
    await expect(getLatestPrReview(task.id, otherOrg.id)).resolves.toBeUndefined();
  });

  it("listPrReviewsForTask returns every pass, newest first", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const first = await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha1" });
    const second = await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha2" });

    await expect(listPrReviewsForTask(task.id, org.id)).resolves.toEqual([second, first]);
  });
});
