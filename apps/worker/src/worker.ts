import "dotenv/config";
import { Worker } from "bullmq";
import {
  RUN_QUEUE_NAME,
  SANDBOX_TEARDOWN_QUEUE_NAME,
  queueConnection,
  type RunJobData,
  type SandboxTeardownJobData,
} from "@agentfactory/queue";
import { type Session, formatSharedContextForPrompt } from "@agentfactory/core";
import {
  clearSessionSandboxId,
  createEvent,
  createMessage,
  getAgent,
  getLatestProviderSessionRef,
  getMessage,
  getRun,
  getSession,
  getTaskBySessionId,
  getTeam,
  setSessionSandboxId,
  touchSessionActivity,
  updateRunStatus,
  updateRunWorkspace,
  updateTask,
} from "@agentfactory/db";
import { DockerSandboxProvider } from "./sandbox/docker-sandbox-provider";
import { runAgentTurn } from "./agent-runtime";
import {
  buildPullRequestBody,
  fetchIssue,
  openDraftPullRequest,
  parseIssueReference,
  pushChangesIfDirty,
  resolveCloneTarget,
  type CloneTarget,
} from "./scm-provider";

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

      const task = await getTaskBySessionId(session.id);
      let workspace: CloneTarget | undefined;
      if (task?.codebase) {
        workspace = await resolveCloneTarget(agent.orgId, task.codebase, `agent/session-${session.id}`);
        if (!workspace) {
          throw new Error(
            `Task ${task.ref}'s codebase "${task.codebase}" isn't accessible via any connected GitHub installation`,
          );
        }
      }

      // The sandbox has no GitHub credentials or HTTP client (see scm-provider.ts's fetchIssue
      // comment), so if the task's description is a GitHub issue link, resolve its content here
      // on the host and hand it to the agent as plain text — the only way it can see the issue
      // at all otherwise is by asking the human to paste it in.
      let issueContext = "";
      const issueRef = parseIssueReference(task?.description ?? "");
      if (issueRef) {
        try {
          const issue = await fetchIssue(agent.orgId, issueRef.repoFullName, issueRef.issueNumber);
          if (issue) {
            issueContext = `\n\nGitHub issue ${issueRef.repoFullName}#${issueRef.issueNumber}: ${issue.title}\n\n${issue.body}`;
          }
        } catch (err) {
          console.error(`Failed to fetch GitHub issue for task ${task?.ref}:`, err);
        }
      }

      const team = agent.teamId ? await getTeam(agent.teamId) : undefined;
      const teamContextPrefix = team ? formatSharedContextForPrompt(team.sharedContext) : "";

      let seq = 1;
      const { text, providerSessionRef } = await runAgentTurn({
        sandboxProvider,
        sandboxId,
        systemPrompt: teamContextPrefix + agent.systemPrompt,
        model: task?.model ?? agent.model,
        userText: (triggeringMessage?.content ?? "") + issueContext,
        resumeSessionRef,
        workspace,
        onEvent: async (type, data) => {
          await createEvent(runId, seq++, type, data);
        },
      });

      await createMessage(run.sessionId, "assistant", text, runId);
      await createEvent(runId, seq++, "text_delta", { text });
      await createEvent(runId, seq++, "done", { reason: "completed" });

      await updateRunStatus(runId, "finalizing");

      let changedFiles: string[] = [];
      if (workspace && task) {
        const result = await pushChangesIfDirty(
          sandboxProvider,
          sandboxId,
          workspace,
          `${agent.name}: ${task.title}`,
          agent.name,
        );
        changedFiles = result.changedFiles;
        if (result.pushed) {
          const pr = await openDraftPullRequest(
            workspace.installationId,
            workspace.repoFullName,
            workspace.branch,
            task.title,
            buildPullRequestBody({
              taskRef: task.ref,
              taskDescription: task.description,
              summary: text,
              changedFiles,
            }),
          );
          await updateTask(task.id, { prNumber: pr.number, prUrl: pr.url, status: "pr_open" });
        }
      }

      // Once a real repo is cloned, the sandbox's whole checkout lives under /workspace — showing
      // it unfiltered would surface the entire repo (hundreds of pre-existing files) as if the
      // agent had touched all of them. Narrow to what this turn actually changed; a workspace-less
      // run (no codebase attached) keeps the old full-tree snapshot since there's no diff to take.
      const fullSnapshot = await sandboxProvider.readWorkspace(sandboxId);
      const workspaceSnapshot = workspace
        ? Object.fromEntries(changedFiles.filter((f) => f in fullSnapshot).map((f) => [f, fullSnapshot[f]]))
        : fullSnapshot;
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

// Triggered when a task is marked done or deleted (apps/web's task routes) — tears down the
// session's warm sandbox since it's no longer needed, without touching the run/message history.
new Worker<SandboxTeardownJobData>(
  SANDBOX_TEARDOWN_QUEUE_NAME,
  async (job) => {
    const { sessionId } = job.data;
    const session = await getSession(sessionId);
    if (!session?.sandboxId) return;
    await sandboxProvider.destroy(session.sandboxId);
    await clearSessionSandboxId(sessionId);
  },
  { connection: queueConnection },
);

console.log(`apps/worker listening on queues "${RUN_QUEUE_NAME}", "${SANDBOX_TEARDOWN_QUEUE_NAME}"`);
