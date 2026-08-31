import IORedis from "ioredis";
import { Queue } from "bullmq";

export const RUN_QUEUE_NAME = "runs";
export const SANDBOX_TEARDOWN_QUEUE_NAME = "sandbox-teardown";
export const REPO_MAP_WARM_QUEUE_NAME = "repo-map-warm";
export const EVAL_QUEUE_NAME = "evals";
export const CONTEXT_INGEST_QUEUE_NAME = "context-ingest";

export interface RunJobData {
  runId: number;
}

// Docker is only reachable from the worker process (see DockerSandboxProvider), so the web app
// can't destroy a session's sandbox directly — it enqueues this job and the worker does it.
export interface SandboxTeardownJobData {
  sessionId: number;
}

export interface RepoMapWarmJobData {
  orgId: number;
  repoFullName: string;
}

export interface EvalJobData {
  evalId: number;
}

export interface ContextIngestJobData {
  itemId: number;
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set");
}

export const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const runQueue = new Queue<RunJobData>(RUN_QUEUE_NAME, { connection: queueConnection });
const sandboxTeardownQueue = new Queue<SandboxTeardownJobData>(SANDBOX_TEARDOWN_QUEUE_NAME, {
  connection: queueConnection,
});
const repoMapWarmQueue = new Queue<RepoMapWarmJobData>(REPO_MAP_WARM_QUEUE_NAME, { connection: queueConnection });
const evalQueue = new Queue<EvalJobData>(EVAL_QUEUE_NAME, { connection: queueConnection });
const contextIngestQueue = new Queue<ContextIngestJobData>(CONTEXT_INGEST_QUEUE_NAME, {
  connection: queueConnection,
});

export async function enqueueRunJob(runId: number): Promise<void> {
  await runQueue.add("process-run", { runId });
}

export async function enqueueSandboxTeardownJob(sessionId: number): Promise<void> {
  await sandboxTeardownQueue.add("teardown-sandbox", { sessionId });
}

// jobId collapses duplicate warm requests for the same org+repo (e.g. an agent's and a team's
// defaultCodebase both naming it) into a single queued job. removeOnComplete/removeOnFail clean
// up the job once it settles — BullMQ retains completed jobs by default, and .add() with an
// already-used jobId silently no-ops even after that job has completed, which would otherwise
// permanently block every future warm request for the same org+repo pair.
export async function enqueueRepoMapWarmJob(orgId: number, repoFullName: string): Promise<void> {
  await repoMapWarmQueue.add(
    "warm-repo-map",
    { orgId, repoFullName },
    { jobId: `${orgId}-${repoFullName}`, removeOnComplete: true, removeOnFail: { count: 100 } },
  );
}

// Own queue rather than the run queue: an eval job would otherwise wait behind ~60s agent
// runs, and grading should start when the user clicks Evaluate.
export async function enqueueEvalJob(evalId: number): Promise<void> {
  await evalQueue.add("process-eval", { evalId });
}

// The first queue here to set attempts/backoff — every other one in this file runs a job
// exactly once, deliberately (ARCHITECTURE.md §4: a run may already have pushed a commit or
// commented on a PR, so re-running one is not safe). Ingestion is different: it touches
// nothing outside our own tables and blob store, and the handler deletes an item's chunks
// before inserting, so a second pass over the same item is a no-op that lands on the same
// rows. The retries that actually matter here are BullMQ's stalled-job redelivery after a
// worker crash — the row is left at "indexing", which the handler's status guard accepts.
// jobId collapses a double upload-click on one item; removeOnComplete matters for the same
// reason it does on the repo-map warm queue — .add() with an already-used jobId silently
// no-ops even after that job completed, which would otherwise block re-ingesting the item
// forever.
export async function enqueueContextIngestJob(itemId: number): Promise<void> {
  await contextIngestQueue.add(
    "ingest-context-item",
    { itemId },
    {
      jobId: `item-${itemId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    },
  );
}
