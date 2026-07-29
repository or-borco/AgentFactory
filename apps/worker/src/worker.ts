import "dotenv/config";
import { Worker } from "bullmq";
import { RUN_QUEUE_NAME, queueConnection, type RunJobData } from "@agentfactory/queue";
import {
  createEvent,
  createMessage,
  getAgent,
  getMessage,
  getRun,
  getSession,
  touchSessionActivity,
  updateRunStatus,
} from "@agentfactory/db";
import { draftReplyFor } from "./stub-runtime";

new Worker<RunJobData>(
  RUN_QUEUE_NAME,
  async (job) => {
    const { runId } = job.data;
    const run = await getRun(runId);
    if (!run) return;

    try {
      await updateRunStatus(runId, "running");

      const session = await getSession(run.sessionId);
      const agent = session ? await getAgent(session.agentId) : undefined;

      const triggeringMessage = run.triggeringMessageId ? await getMessage(run.triggeringMessageId) : undefined;
      const replyText = draftReplyFor(agent?.id, triggeringMessage?.content ?? "");

      await createMessage(run.sessionId, "assistant", replyText, runId);
      await createEvent(runId, 1, "text_delta", { text: replyText });
      await createEvent(runId, 2, "done", { reason: "completed" });

      await updateRunStatus(runId, "done", { finishedAt: new Date() });
      if (session) await touchSessionActivity(session.id);
    } catch (err) {
      await updateRunStatus(runId, "failed");
      throw err; // still let BullMQ mark the job failed
    }
  },
  { connection: queueConnection },
);

console.log(`apps/worker listening on queue "${RUN_QUEUE_NAME}"`);
