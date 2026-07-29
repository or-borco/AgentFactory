import "dotenv/config";
import { Worker } from "bullmq";
import { RUN_QUEUE_NAME, queueConnection, type RunJobData } from "@agentfactory/queue";
import {
  createEvent,
  createMessage,
  getAgent,
  getLatestProviderSessionRef,
  getMessage,
  getRun,
  getSession,
  touchSessionActivity,
  updateRunStatus,
} from "@agentfactory/db";
import { runAgentTurn } from "./agent-runtime";

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
      if (!session || !agent) throw new Error(`Run ${runId} has no session/agent to work with`);

      const triggeringMessage = run.triggeringMessageId ? await getMessage(run.triggeringMessageId) : undefined;
      const resumeSessionRef = await getLatestProviderSessionRef(session.id, runId);

      const { text, providerSessionRef } = await runAgentTurn({
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        userText: triggeringMessage?.content ?? "",
        resumeSessionRef,
      });

      await createMessage(run.sessionId, "assistant", text, runId);
      await createEvent(runId, 1, "text_delta", { text });
      await createEvent(runId, 2, "done", { reason: "completed" });

      await updateRunStatus(runId, "done", { finishedAt: new Date(), providerSessionRef });
      await touchSessionActivity(session.id);
    } catch (err) {
      await updateRunStatus(runId, "failed");
      throw err; // still let BullMQ mark the job failed
    }
  },
  { connection: queueConnection },
);

console.log(`apps/worker listening on queue "${RUN_QUEUE_NAME}"`);
