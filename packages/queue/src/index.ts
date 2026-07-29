import IORedis from "ioredis";
import { Queue } from "bullmq";

export const RUN_QUEUE_NAME = "runs";

export interface RunJobData {
  runId: number;
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set");
}

export const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const runQueue = new Queue<RunJobData>(RUN_QUEUE_NAME, { connection: queueConnection });

export async function enqueueRunJob(runId: number): Promise<void> {
  await runQueue.add("process-run", { runId });
}
