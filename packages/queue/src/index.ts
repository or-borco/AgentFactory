import IORedis from "ioredis";
import { Queue } from "bullmq";

export const RUN_QUEUE_NAME = "runs";
export const SANDBOX_TEARDOWN_QUEUE_NAME = "sandbox-teardown";
export const REPO_MAP_WARM_QUEUE_NAME = "repo-map-warm";

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

export async function enqueueRunJob(runId: number): Promise<void> {
  await runQueue.add("process-run", { runId });
}

export async function enqueueSandboxTeardownJob(sessionId: number): Promise<void> {
  await sandboxTeardownQueue.add("teardown-sandbox", { sessionId });
}

// jobId collapses duplicate warm requests for the same org+repo (e.g. an agent's and a team's
// defaultCodebase both naming it) into a single queued job.
export async function enqueueRepoMapWarmJob(orgId: number, repoFullName: string): Promise<void> {
  await repoMapWarmQueue.add(
    "warm-repo-map",
    { orgId, repoFullName },
    { jobId: `${orgId}-${repoFullName}` },
  );
}
