import "dotenv/config";
import { Worker } from "bullmq";
import { RUN_QUEUE_NAME, queueConnection, type RunJobData } from "@agentfactory/queue";
import {
  createEvent,
  createMessage,
  getAgent,
  getRun,
  getSession,
  listMessages,
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

      // The run doesn't carry a reference to the message that triggered it (not in the
      // domain model), so find it the same way a human would: the most recent user message
      // on this session at the time the run was enqueued.
      const messages = session ? await listMessages(session.id) : [];
      const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
      const replyText = draftReplyFor(agent?.id, lastUserMessage?.content ?? "");

      await createMessage(run.sessionId, "assistant", replyText);
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
