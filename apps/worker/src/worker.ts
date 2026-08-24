import "dotenv/config";
import { Worker } from "bullmq";
import {
  RUN_QUEUE_NAME,
  SANDBOX_TEARDOWN_QUEUE_NAME,
  queueConnection,
  type RunJobData,
  type SandboxTeardownJobData,
} from "@agentfactory/queue";
import { type ModelSpec, type Session, buildModelSpec, formatSharedContextForPrompt } from "@agentfactory/core";
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
import { type AgentTurnResult, InsufficientCreditError, PromptTooLongError, runAgentTurn } from "./agent-runtime";
import { composeSystemPrompt, hashPrompt } from "./prompt-composition";
import {
  buildPullRequestBody,
  fetchIssue,
  openDraftPullRequest,
  parseIssueReference,
  pushChangesIfDirty,
  resolveCloneTarget,
  type CloneTarget,
} from "./scm-provider";
import { resolveEscalation } from "./model-escalation";

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

const runWorker = new Worker<RunJobData>(
  RUN_QUEUE_NAME,
  async (job) => {
    const { runId } = job.data;
    const run = await getRun(runId);
    if (!run) return;

    // Hoisted above the try block so the catch below can persist whichever model actually ran,
    // even when the failure happens after one or more escalation attempts (runs.model must record
    // the true final model, not go silent, on both the "done" and "failed" paths).
    let attemptModel: ModelSpec | undefined;
    // Hoisted for the same reason as attemptModel — a failure can happen before this run's own
    // `seq` would otherwise be declared (even before session/agent resolve), and the catch block
    // still needs a valid seq to append an "error" event without colliding with whatever events
    // were already written for this run.
    let seq = 1;
    try {
      const session = await getSession(run.sessionId);
      const agent = session ? await getAgent(session.agentId) : undefined;
      if (!session || !agent) throw new Error(`Run ${runId} has no session/agent to work with`);

      await updateRunStatus(runId, "provisioning");
      const sandboxId = await ensureSandbox(session);
      // Shrink back to base before this run starts — a sandbox that grew to handle a heavy
      // task on a prior run shouldn't keep that cap for this one (see docker-sandbox-provider.ts).
      await sandboxProvider.resetMemory(sandboxId);

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
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Failed to fetch GitHub issue for task ${task?.ref}:`, err);
          // Recorded as a run event (not just console.error) so this is visible in the
          // transcript — this failure previously vanished silently, leaving the agent to
          // fall back to an unauthenticated, always-doomed fetch attempt from inside its own
          // sandbox with no way for anyone to tell why it didn't have the issue content.
          await createEvent(runId, seq++, "error", {
            message: `Couldn't fetch GitHub issue ${issueRef.repoFullName}#${issueRef.issueNumber}: ${message}`,
          });
        }
      }

      const team = agent.teamId ? await getTeam(agent.teamId) : undefined;
      const teamContextPrefix = team ? formatSharedContextForPrompt(team.sharedContext) : "";

      if (teamContextPrefix) {
        await createEvent(runId, seq++, "context_included", {
          included: true,
          preview: teamContextPrefix.slice(0, 150).trim(),
        });
      }

      const systemPrompt = composeSystemPrompt(teamContextPrefix, "", agent.systemPrompt);
      await updateRunStatus(runId, "running", { promptHash: hashPrompt(systemPrompt) });

      attemptModel = task?.model ?? agent.model;
      let turnResult!: AgentTurnResult;
      for (;;) {
        try {
          turnResult = await runAgentTurn({
            sandboxProvider,
            sandboxId,
            systemPrompt,
            model: attemptModel,
            userText: (triggeringMessage?.content ?? "") + issueContext,
            resumeSessionRef,
            workspace,
            onEvent: async (type, data) => {
              await createEvent(runId, seq++, type, data);
            },
          });
          break;
        } catch (err) {
          if (!(err instanceof PromptTooLongError)) throw err;
          const nextModelId = resolveEscalation(attemptModel.id, agent.onContextOverflow);
          if (!nextModelId) throw err;
          const nextModel = buildModelSpec(nextModelId);
          await createEvent(runId, seq++, "model_escalated", {
            fromModel: attemptModel.id,
            toModel: nextModel.id,
            reason: "context_overflow",
          });
          attemptModel = nextModel;
        }
      }
      const { text, providerSessionRef } = turnResult;

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
        if (result.branchMismatch) {
          // The agent has full unrestricted bash access and occasionally switches off the
          // session's assigned branch mid-turn (see T-047) — surfaced as a run event rather than
          // left to vanish the way it did there, whether or not pushChangesIfDirty could recover
          // the work automatically.
          await createEvent(runId, seq++, "error", {
            message: result.pushed
              ? `Agent committed to branch "${result.branchMismatch.agentBranch}" instead of the assigned "${workspace.branch}" — recovered automatically and pushed from there.`
              : `Agent committed to branch "${result.branchMismatch.agentBranch}" instead of the assigned "${workspace.branch}" — left uncommitted; nothing was pushed this turn.`,
          });
        }
        // A push after the first one just updates the existing PR on GitHub's side automatically
        // (same head branch) — opening another PR for a branch that already has one 422s. Only
        // ever open once per task; task.prNumber is the record of whether that's already happened.
        if (result.pushed && !task.prNumber) {
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

      await updateRunStatus(runId, "done", { finishedAt: new Date(), providerSessionRef, model: attemptModel });
      await touchSessionActivity(session.id);
    } catch (err) {
      console.error(`Run ${runId} failed:`, err);
      // Persist the failure to the event log (the source of truth for what happened during a
      // run, per this repo's domain model) — without this, the only record of why a run died
      // was this stdout line, gone the moment the worker's logs rotate or the process restarts.
      const message = err instanceof Error ? err.message : String(err);
      // Classified so the web app can show a specific, safe message instead of its generic
      // "couldn't reply" fallback (see ErrorCode in @agentfactory/core) — without this, an
      // exhausted Claude API account and every other failure looked identical to the user.
      const code = err instanceof InsufficientCreditError ? "insufficient_credit" : undefined;
      await createEvent(runId, seq++, "error", { message, ...(code ? { code } : {}) });
      await updateRunStatus(runId, "failed", { finishedAt: new Date(), model: attemptModel });
      // Surface the failure on the owning task too — otherwise it's stuck at whatever status
      // it had when the run started, and the "failed" StatusPill can never actually show up.
      const task = await getTaskBySessionId(run.sessionId);
      if (task) await updateTask(task.id, { status: "failed" });
      throw err; // still let BullMQ mark the job failed
    }
  },
  { connection: queueConnection },
);

// Belt-and-suspenders logging straight to stdout, independent of the DB/event-log path above —
// catches cases where the job handler's own catch block never got to run at all (e.g. it crashed
// before reaching its try, or BullMQ itself judged the job failed).
runWorker.on("failed", (job, err) => {
  console.error(`Run job ${job?.id} failed:`, err);
});

// Triggered when a task is marked done or deleted (apps/web's task routes) — tears down the
// session's warm sandbox since it's no longer needed, without touching the run/message history.
const sandboxTeardownWorker = new Worker<SandboxTeardownJobData>(
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

sandboxTeardownWorker.on("failed", (job, err) => {
  console.error(`Sandbox teardown job ${job?.id} failed:`, err);
});

console.log(`apps/worker listening on queues "${RUN_QUEUE_NAME}", "${SANDBOX_TEARDOWN_QUEUE_NAME}"`);
