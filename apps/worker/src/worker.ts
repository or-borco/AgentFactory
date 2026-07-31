import "dotenv/config";
import { Worker } from "bullmq";
import { RUN_QUEUE_NAME, queueConnection, type RunJobData } from "@agentfactory/queue";
import type { Session } from "@agentfactory/core";
import {
  createEvent,
  createMessage,
  getAgent,
  getLatestProviderSessionRef,
  getMessage,
  getRun,
  getSession,
  setSessionSandboxId,
  touchSessionActivity,
  updateRunStatus,
  updateRunWorkspace,
} from "@agentfactory/db";
import { DockerSandboxProvider } from "./sandbox/docker-sandbox-provider";
import { runAgentTurn } from "./agent-runtime";

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "agentfactory-sandbox:local";
const sandboxProvider = new DockerSandboxProvider();

// One sandbox per active session, kept warm across runs (ARCHITECTURE.md §4) — the SDK's own
// resume mechanism needs the same container's filesystem across turns (see the sessions.sandboxId
// migration). Idle teardown of long-unused sandboxes is a deliberate follow-up, not this slice.
async function ensureSandbox(session: Session): Promise<string> {
  if (session.sandboxId && (await sandboxProvider.exists(session.sandboxId))) {
    return session.sandboxId;
  }
  const sandbox = await sandboxProvider.create({
    image: SANDBOX_IMAGE,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  });
  await setSessionSandboxId(session.id, sandbox.id);
  return sandbox.id;
}

new Worker<RunJobData>(
  RUN_QUEUE_NAME,
  async (job) => {
    const { runId } = job.data;
    const run = await getRun(runId);
    if (!run) return;

    try {
      const session = await getSession(run.sessionId);
      const agent = session ? await getAgent(session.agentId) : undefined;
      if (!session || !agent) throw new Error(`Run ${runId} has no session/agent to work with`);

      await updateRunStatus(runId, "provisioning");
      const sandboxId = await ensureSandbox(session);

      await updateRunStatus(runId, "running");

      const triggeringMessage = run.triggeringMessageId ? await getMessage(run.triggeringMessageId) : undefined;
      const resumeSessionRef = await getLatestProviderSessionRef(session.id, runId);

      const { text, providerSessionRef } = await runAgentTurn({
        sandboxProvider,
        sandboxId,
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        userText: triggeringMessage?.content ?? "",
        resumeSessionRef,
      });

      await createMessage(run.sessionId, "assistant", text, runId);
      await createEvent(runId, 1, "text_delta", { text });
      await createEvent(runId, 2, "done", { reason: "completed" });

      const workspaceSnapshot = await sandboxProvider.readWorkspace(sandboxId);
      if (Object.keys(workspaceSnapshot).length > 0) {
        await updateRunWorkspace(runId, workspaceSnapshot);
      }

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
