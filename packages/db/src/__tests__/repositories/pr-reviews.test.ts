import { describe, expect, it } from "vitest";
import "../setup.js";
import { createRun } from "../../repositories/runs.js";
import {
  approvePrReview,
  createPendingPrReview,
  discardPrReview,
  getLatestPrReview,
  getPrReview,
  listPrReviewsForTask,
} from "../../repositories/pr-reviews.js";
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
  summary: "Looks good overall.",
  comments: [{ path: "src/index.ts", line: 10, body: "Nit: rename this." }],
  commentCount: 1,
  truncated: false,
};

const POSTED = {
  postedAs: "comment" as const,
  githubReviewId: "555",
  url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
};

describe("pr-reviews repository", () => {
  it("creates a pending review row and reads it back", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const review = await createPendingPrReview(org.id, task.id, run.id, INPUT);

    expect(review).toMatchObject({
      orgId: org.id,
      taskId: task.id,
      runId: run.id,
      status: "pending",
      postedAs: undefined,
      githubReviewId: undefined,
      url: undefined,
      ...INPUT,
    });
    expect(review.createdAt).toBeDefined();
  });

  it("approvePrReview flips a pending row to posted and sets the posted fields", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const review = await createPendingPrReview(org.id, task.id, run.id, INPUT);

    const approved = await approvePrReview(review.id, org.id, POSTED);

    expect(approved).toMatchObject({ id: review.id, status: "posted", ...POSTED });
    await expect(getPrReview(review.id, org.id)).resolves.toMatchObject({ status: "posted", ...POSTED });
  });

  it("approvePrReview is a no-op (returns undefined) on a row that isn't pending", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const review = await createPendingPrReview(org.id, task.id, run.id, INPUT);
    await approvePrReview(review.id, org.id, POSTED);

    await expect(approvePrReview(review.id, org.id, POSTED)).resolves.toBeUndefined();
  });

  it("discardPrReview flips a pending row to discarded", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const review = await createPendingPrReview(org.id, task.id, run.id, INPUT);

    const discarded = await discardPrReview(review.id, org.id);

    expect(discarded).toMatchObject({ id: review.id, status: "discarded" });
    await expect(getPrReview(review.id, org.id)).resolves.toMatchObject({ status: "discarded" });
  });

  it("discardPrReview is a no-op (returns undefined) on a row that isn't pending", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const review = await createPendingPrReview(org.id, task.id, run.id, INPUT);
    await discardPrReview(review.id, org.id);

    await expect(discardPrReview(review.id, org.id)).resolves.toBeUndefined();
  });

  it("getPrReview does not leak a review across orgs", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const otherOrg = await insertOrg();
    const review = await createPendingPrReview(org.id, task.id, run.id, INPUT);

    await expect(getPrReview(review.id, otherOrg.id)).resolves.toBeUndefined();
  });

  it("getLatestPrReview returns the most recently created row for the task, org-scoped", async () => {
    const { org, task, run } = await setupTaskAndRun();
    await createPendingPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha1" });
    const second = await createPendingPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha2" });

    await expect(getLatestPrReview(task.id, org.id)).resolves.toEqual(second);
  });

  it("getLatestPrReview returns undefined for a task with no reviews", async () => {
    const { org, task } = await setupTaskAndRun();
    await expect(getLatestPrReview(task.id, org.id)).resolves.toBeUndefined();
  });

  it("getLatestPrReview does not leak a review across orgs", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const otherOrg = await insertOrg();
    await createPendingPrReview(org.id, task.id, run.id, INPUT);
    await expect(getLatestPrReview(task.id, otherOrg.id)).resolves.toBeUndefined();
  });

  it("listPrReviewsForTask returns every pass, newest first, regardless of status", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const first = await createPendingPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha1" });
    const second = await createPendingPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha2" });
    const approvedSecond = await approvePrReview(second.id, org.id, POSTED);

    await expect(listPrReviewsForTask(task.id, org.id)).resolves.toEqual([approvedSecond, first]);
  });
});
