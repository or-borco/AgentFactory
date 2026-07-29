import IORedis from "ioredis";
import { Queue } from "bullmq";

export const RUN_QUEUE_NAME = "runs";

export interface RunJobData {
  runId: number;
  // Set once at createRun and never changed afterward — safe to carry alongside runId
  // purely for observability (visible in redis-cli/Bull Board without a DB lookup). The
  // worker still treats Postgres as authoritative and re-reads the run itself; this is not
  // a substitute for that.
  sessionId: number;
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set");
}

export const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const runQueue = new Queue<RunJobData>(RUN_QUEUE_NAME, { connection: queueConnection });

export async function enqueueRunJob(runId: number, sessionId: number): Promise<void> {
  await runQueue.add("process-run", { runId, sessionId });
}
