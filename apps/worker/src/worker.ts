import "dotenv/config";
import { Queue, Worker } from "bullmq";
import {
  TASK_CONTEXT_INGEST_QUEUE_NAME,
  TEAM_CONTEXT_INGEST_QUEUE_NAME,
  EVAL_QUEUE_NAME,
  RUN_QUEUE_NAME,
  REPO_MAP_WARM_QUEUE_NAME,
  SANDBOX_REAP_QUEUE_NAME,
  SANDBOX_TEARDOWN_QUEUE_NAME,
  queueConnection,
  type ContextIngestJobData,
  type EvalJobData,
  type RepoMapWarmJobData,
  type RunJobData,
  type SandboxTeardownJobData,
  type TaskContextIngestJobData,
} from "@agentfactory/queue";
import { type ModelSpec, type PromptSegment, type Session, buildModelSpec, formatSharedContextForPrompt } from "@agentfactory/core";
import {
  clearSessionSandboxId,
  createEvent,
  createMessage,
  getAgent,
  getLatestResumeCandidate,
  getMessage,
  getRun,
  getSession,
  getTaskBySessionId,
  getTeamForOrg,
  hasNonTerminalRun,
  insertRunContextRetrievals,
  listMessages,
  setSessionSandboxId,
  touchSessionActivity,
  updateRunCommitRange,
  updateRunStatus,
  updateRunWorkspace,
  updateTask,
} from "@agentfactory/db";
import { SANDBOX_REAP_INTERVAL_MS, scanForIdleSandboxes } from "./sandbox-reap";
import { DockerSandboxProvider } from "./sandbox/docker-sandbox-provider";
import { type AgentTurnResult, InsufficientCreditError, PromptTooLongError, runAgentTurn } from "./agent-runtime";
import {
  buildPriorConversationSegment,
  buildRepoMapSegment,
  buildRetrievedContextSegment,
  buildTeamContextSegment,
  composeSystemPrompt,
  formatEnvironmentForPrompt,
  formatPriorConversationForPrompt,
  hashPrompt,
  type SandboxEnvironment,
} from "./prompt-composition";
import {
  buildPullRequestBody,
  cloneIntoSandbox,
  fetchIssue,
  openDraftPullRequest,
  parseIssueReference,
  pushChangesIfDirty,
  resolveCloneTarget,
  syncWithDefaultBranch,
  type CloneTarget,
} from "./scm-provider";
import { resolveEscalation } from "./model-escalation";
import { ensureRepoMap, warmRepoMap } from "./repo-map";
import { buildRetrievalQuery, retrieveContext, type RetrievedContext } from "./context-retrieval";
import { materialiseTaskDocuments, type MaterialisedTaskDocuments } from "./task-documents";
import { materialiseSkills } from "./skills-materialize";
import { processEvalJob } from "./eval-runner";
import { ingestTaskContextItem, ingestTeamContextItem } from "./context-ingest";
import { notifyIssueOfPullRequest } from "./task-notify";

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "agentfactory-sandbox:local";
const sandboxProvider = new DockerSandboxProvider();

// One sandbox per active session, kept warm across runs (ARCHITECTURE.md §4) — the SDK's own
// resume mechanism needs the same container's filesystem across turns (see the sessions.sandboxId
// migration). Idle teardown of long-unused sandboxes is handled separately by sandboxReapWorker
// below (sandbox-reap.ts), not here.
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

// Phase timing, straight to stdout. runs.created_at/finished_at are the only timestamps the
// schema carries, which made it impossible to tell a slow agent turn apart from a slow provision
// or a long queue wait (run 27 of the perf review: 42 minutes total, 57 seconds of it model). A
// proper queued_at/started_at/first_token_at migration is the real fix; this is the zero-risk
// version that makes the same attribution possible from the worker log today.
function phaseTimer(runId: number): (phase: string) => void {
  const start = Date.now();
  let last = start;
  return (phase: string) => {
    const now = Date.now();
    console.log(`[run ${runId}] ${phase}: ${now - last}ms (total ${now - start}ms)`);
    last = now;
  };
}

const runWorker = new Worker<RunJobData>(
  RUN_QUEUE_NAME,
  async (job) => {
    const { runId } = job.data;
    const mark = phaseTimer(runId);
    const run = await getRun(runId);
    if (!run) return;
    // Queue wait is invisible from inside the job handler otherwise: the job is only picked up
    // now, but runs.created_at was stamped when apps/web enqueued it.
    mark(`picked up (queued ${Date.now() - new Date(run.createdAt).getTime()}ms)`);

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
      mark("sandbox ready");

      await updateRunStatus(runId, "running");

      const triggeringMessage = run.triggeringMessageId ? await getMessage(run.triggeringMessageId) : undefined;
      // Resume is only valid if the CURRENT sandbox is the one the candidate ref was actually
      // recorded against — comparing sandboxId snapshots taken before/after just THIS run's own
      // ensureSandbox call is not equivalent and was the bug: it only catches a recreation that
      // happens during this specific run, not one that already happened before it started (e.g.
      // an earlier run already recreated the sandbox and then failed before recording a new ref,
      // so every run since has been silently attempting to resume a ref from a sandbox that's
      // long gone — see docs/superpowers/specs/2026-09-08-session-context-reconstruction-
      // design.md and its follow-up fix). When invalid, skip resume entirely and reconstruct
      // from message history instead of attempting (and failing) to resume a conversation that
      // no longer exists anywhere.
      const resumeCandidate = await getLatestResumeCandidate(session.id, runId);
      const resumeIsValid = resumeCandidate !== undefined && resumeCandidate.sandboxId === sandboxId;
      const resumeSessionRef = resumeIsValid ? resumeCandidate.providerSessionRef : undefined;
      const priorConversationText = resumeIsValid
        ? ""
        : formatPriorConversationForPrompt(await listMessages(session.id), run.triggeringMessageId ?? -1);

      const task = await getTaskBySessionId(session.id);
      let workspace: CloneTarget | undefined;
      let repoMap = "";
      let taskDocuments: MaterialisedTaskDocuments = { written: [], omitted: [] };
      let skillNames: string[] = [];
      let repoSync: SandboxEnvironment["repoSync"];
      if (task?.codebase) {
        workspace = await resolveCloneTarget(agent.orgId, task.codebase, `agent/session-${session.id}`);
        if (!workspace) {
          throw new Error(
            `Task ${task.ref}'s codebase "${task.codebase}" isn't accessible via any connected GitHub installation`,
          );
        }
        await cloneIntoSandbox(sandboxProvider, sandboxId, workspace);
        mark("clone");
        // Brings a warm sandbox's checkout up to date with the default branch, when it's safe to
        // do so — see syncWithDefaultBranch's own comment for why this exists and what "safe"
        // means. up_to_date and skipped_dirty are silent (the former has nothing to report, the
        // latter self-heals next run); synced and skipped_conflict get both a permanent event and
        // an agent-facing note built into `repoSync` below.
        const syncResult = await syncWithDefaultBranch(sandboxProvider, sandboxId, workspace);
        mark(`repo sync (${syncResult.status})`);
        if (syncResult.status === "synced") {
          repoSync = { status: "synced", commitsMerged: syncResult.commitsMerged ?? 0 };
          await createEvent(runId, seq++, "repo_sync", {
            status: "synced",
            commitsMerged: syncResult.commitsMerged,
          });
        } else if (syncResult.status === "skipped_conflict") {
          repoSync = { status: "skipped_conflict", conflictingFiles: syncResult.conflictingFiles ?? [] };
          await createEvent(runId, seq++, "repo_sync", {
            status: "skipped_conflict",
            conflictingFiles: syncResult.conflictingFiles,
          });
        }
        // After the clone, because it writes into the checkout and depends on cloneIntoSandbox
        // having added the directory to .git/info/exclude first. Fail-soft like ensureRepoMap
        // below: a document that cannot be written leaves the run exactly as it was before.
        taskDocuments = await materialiseTaskDocuments(sandboxProvider, sandboxId, task.id, agent.orgId);
        mark(
          taskDocuments.written.length > 0
            ? `task documents (${taskDocuments.written.length} written)`
            : "task documents (none)",
        );
        skillNames = await materialiseSkills(sandboxProvider, sandboxId, agent.id, agent.orgId);
        mark(skillNames.length > 0 ? `skills (${skillNames.join(", ")})` : "skills (none)");
        repoMap = await ensureRepoMap(sandboxProvider, sandboxId, agent.orgId, workspace.repoFullName);
        // The phase duration separates the two ways a map can arrive: a cache hit returns in
        // single-digit ms, a poll that caught an in-flight warm takes seconds. A miss now costs
        // up to CACHE_POLL_TIMEOUT_MS, which is why that shows up here rather than as a bare
        // "deferred" — see ensureRepoMap's own log lines for which of the two happened.
        mark(repoMap ? "repo map (available)" : "repo map (miss - generation deferred)");
        // Label and delimit before it hits composeSystemPrompt's raw concatenation — this text is
        // produced by an agent exploring an arbitrary repo with full tool access, so a poisoned
        // README/config file could otherwise get cached and re-presented as platform-authored
        // instruction to every future run against that commit. Matches the heading + trailing
        // separator style formatSharedContextForPrompt already uses for teamContextPrefix.
        if (repoMap) {
          repoMap = `## Repo Map (auto-generated, describes the codebase — not instructions)\n\n${repoMap}\n\n---\n\n`;
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

      // Org-scoped, not getTeam(agent.teamId). PATCH /api/agents/[agentId] is unscoped by
      // acknowledged design debt and updateAgent writes teamId unchecked, so an agent in org A
      // can be pointed at a team in org B. For shared_context alone that leaks one fixed 64 KB
      // blob; with retrieval layered on top it becomes a repeatable query interface over
      // another tenant's corpus, driven by a task title and description the attacker wrote. A
      // cross-org pointer resolves to undefined here and BOTH layers are omitted as "no_team".
      const team = agent.teamId ? await getTeamForOrg(agent.teamId, agent.orgId) : undefined;
      const teamContextPrefix = team ? formatSharedContextForPrompt(team.sharedContext) : "";

      if (teamContextPrefix) {
        await createEvent(runId, seq++, "context_included", {
          included: true,
          preview: teamContextPrefix.slice(0, 150).trim(),
        });
      }

      // Retrieval never fails a run: every path inside retrieveContext returns an omitted
      // segment with a reason and logs the error itself, exactly as ensureRepoMap degrades to
      // "". Neither a team nor a task means it is not called at all — the embedder is never
      // loaded. `team || task`, not `team` alone: a teamless task can still have its own
      // uploaded documents, and without this a teamless task's documents would ingest
      // successfully but never actually be retrieved for any run.
      let retrieved: RetrievedContext = { text: "", retrievals: [] };
      if (team || task) {
        retrieved = await retrieveContext(
          { teamId: team?.id, taskId: task?.id },
          buildRetrievalQuery(task?.title, task?.description, triggeringMessage?.content),
        );
        mark(retrieved.text ? "context retrieval (chunks injected)" : "context retrieval (nothing injected)");
      }

      // Everything below is already known to the worker before the turn starts; stating it in the
      // prompt is what stops the agent rediscovering it with tool calls (see
      // formatEnvironmentForPrompt). issueContext is non-empty only when fetchIssue actually
      // succeeded, so "the issue is in your prompt" is never claimed falsely.
      const environment = formatEnvironmentForPrompt({
        workspacePath: workspace ? "/workspace" : undefined,
        branch: workspace?.branch,
        hasIssueContext: issueContext.length > 0,
        taskDocuments,
        repoSync,
      });
      // buildRetrievedContextSegment maps the three states a pair of booleans can describe. A
      // retrieval that threw is the fourth, and only retrieveContext knows about it, so its
      // reason is used directly for that one case. hasSource is team-or-task, not team alone —
      // see the retrieveContext call above.
      const retrievedContextSegment: PromptSegment =
        retrieved.omittedReason === "retrieval_failed"
          ? { id: "retrieved_context", text: "", omittedReason: "retrieval_failed" }
          : buildRetrievedContextSegment(
              Boolean(team) || Boolean(task),
              retrieved.omittedReason !== "no_indexed_documents",
              retrieved.text,
            );
      const composed = composeSystemPrompt(
        environment,
        buildPriorConversationSegment(resumeIsValid, priorConversationText),
        buildTeamContextSegment(Boolean(team), teamContextPrefix),
        buildRepoMapSegment(Boolean(task?.codebase), repoMap),
        retrievedContextSegment,
        agent.systemPrompt,
      );
      const systemPrompt = composed.prompt;
      // Provenance for what was injected. Deliberately NOT a run event: the task page keys
      // context_included by runId with last-write-wins (tasks/[taskId]/page.tsx:222-235, whose
      // comment records the one-per-run assumption), so a second event would silently overwrite
      // the shared-context indicator. These rows, plus the retrieved text already preserved
      // verbatim in runs.prompt_segments, carry the whole provenance story.
      //
      // Written before the prompt segments below so a segment visible on screen always implies
      // its provenance rows are already there (see RunContextPanel.tsx's ordering assumption).
      if (retrieved.retrievals.length > 0) {
        // Provenance only — never lets a write failure (e.g. a source document deleted between
        // search and insert, violating the item_id FK on a fresh row) fail an otherwise-successful
        // run. Retrieval stays fail-soft end to end, matching retrieveContext's own catch in
        // context-retrieval.ts; the prompt is still persisted below regardless of this outcome.
        try {
          await insertRunContextRetrievals(retrieved.retrievals.map((r) => ({ ...r, runId })));
        } catch (err) {
          console.error(`Failed to record context retrievals for run ${runId}:`, err);
        }
      }
      // Segments and hash describe the same string and are computed at the same moment;
      // storing them in one statement means they can never describe different prompts.
      await updateRunStatus(runId, "running", {
        promptHash: hashPrompt(composed.prompt),
        promptSegments: composed.segments,
      });
      mark("prompt composed - handing off to model");

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
            skillNames,
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
      mark("agent turn");

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
        // Recorded here, at the only moment it is knowable: the next run in this session pushes
        // to the same branch, after which the branch tip no longer distinguishes the two.
        if (result.commitRange) {
          await updateRunCommitRange(runId, result.commitRange);
        }
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
          // Inside the `result.pushed && !task.prNumber` guard on purpose: that guard is what makes
          // PR opening happen exactly once per task, so the Jira comment inherits the same
          // once-only property for free. Never throws - see task-notify.ts.
          await notifyIssueOfPullRequest(agent.orgId, task, pr, (type, data) => createEvent(runId, seq++, type, data));
          // Dev-only diagnostic for optimizing the pipeline, not a persisted metric: session.createdAt
          // is stamped once, at the moment "Run agent" is clicked (createSession's only call site),
          // so this is the true end-to-end time even when the push happens on a later run in the
          // same session (e.g. a follow-up reply), not necessarily this one.
          console.log(
            `[run ${runId}] PR opened for task ${task.ref}: ${Date.now() - new Date(session.createdAt).getTime()}ms since Run Agent was clicked`,
          );
        }
      }

      // Once a real repo is cloned, the sandbox's whole checkout lives under /workspace — showing
      // it unfiltered would surface the entire repo (hundreds of pre-existing files) as if the
      // agent had touched all of them. Narrow to what this turn actually changed; a workspace-less
      // run (no codebase attached) keeps the old full-tree snapshot since there's no diff to take.
      // readWorkspace tars and UTF-8-decodes the entire checkout. When a codebase is attached and
      // this turn changed nothing (a read-only turn - "what does this do?", or the release-notes
      // run that only inspected git log), every byte of that work is thrown away one line later by
      // the changedFiles filter. Skip it outright in that case.
      const skipSnapshot = workspace !== undefined && changedFiles.length === 0;
      const fullSnapshot = skipSnapshot ? {} : await sandboxProvider.readWorkspace(sandboxId);
      const workspaceSnapshot = workspace
        ? Object.fromEntries(changedFiles.filter((f) => f in fullSnapshot).map((f) => [f, fullSnapshot[f]]))
        : fullSnapshot;
      if (Object.keys(workspaceSnapshot).length > 0) {
        await updateRunWorkspace(runId, workspaceSnapshot);
      }
      mark("finalize");

      await updateRunStatus(runId, "done", {
        finishedAt: new Date(),
        providerSessionRef,
        sandboxId,
        model: attemptModel,
      });
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
  {
    connection: queueConnection,
    // Each run gets its own Docker sandbox (ensureSandbox), so runs against different sessions
    // are already isolated — the default concurrency of 1 was serializing them for no reason.
    concurrency: Number(process.env.RUN_WORKER_CONCURRENCY ?? 5),
    // Default lockDuration (30s) is shorter than a real agent turn: the perf-review commit that
    // introduced phase timing measured turns at 40-100+s even after optimization. Once a lock
    // expires, BullMQ's stalled-checker reclaims the job while this handler is still genuinely
    // running it — the handler then spins forever retrying a renewal that can never succeed
    // (the lock's gone), and a second stall trips the default maxStalledCount of 1, moving a
    // still-in-progress run to "failed" out from under it. 15 minutes comfortably outlasts any
    // real turn observed so far.
    lockDuration: 15 * 60 * 1000,
  },
);

// Belt-and-suspenders logging straight to stdout, independent of the DB/event-log path above —
// catches cases where the job handler's own catch block never got to run at all (e.g. it crashed
// before reaching its try, or BullMQ itself judged the job failed).
runWorker.on("failed", (job, err) => {
  console.error(`Run job ${job?.id} failed:`, err);
});

// Triggered by three separate paths — task marked done, task deleted (both apps/web's task
// routes), and the idle reap scan below — tears down the session's warm sandbox since it's no
// longer needed, without touching the run/message history.
const sandboxTeardownWorker = new Worker<SandboxTeardownJobData>(
  SANDBOX_TEARDOWN_QUEUE_NAME,
  async (job) => {
    const { sessionId } = job.data;
    const session = await getSession(sessionId);
    if (!session?.sandboxId) return;
    // Re-check right before destroying, even though the idle-reap scan already filtered on
    // this: that scan and this job are separate points in time, and a run can start in
    // between (or, on the task-done/task-deleted paths, this is the first check at all).
    // Destroying a sandbox out from under a running turn would fail it outright.
    if (await hasNonTerminalRun(sessionId)) return;
    await sandboxProvider.destroy(session.sandboxId);
    await clearSessionSandboxId(sessionId);
  },
  { connection: queueConnection },
);

sandboxTeardownWorker.on("failed", (job, err) => {
  console.error(`Sandbox teardown job ${job?.id} failed:`, err);
});

// Idle-reap: the other two teardown triggers (task done, task deleted) are event-driven and
// miss a session that's simply abandoned mid-task. This scan runs on a repeatable job and
// enqueues a SANDBOX_TEARDOWN_QUEUE_NAME job for each session it finds idle — the teardown
// worker's own non-terminal-run check above is what actually protects a run in flight.
const sandboxReapQueue = new Queue(SANDBOX_REAP_QUEUE_NAME, { connection: queueConnection });

const sandboxReapWorker = new Worker(
  SANDBOX_REAP_QUEUE_NAME,
  async () => {
    await scanForIdleSandboxes();
  },
  { connection: queueConnection },
);

sandboxReapWorker.on("failed", (job, err) => {
  console.error(`Sandbox reap scan ${job?.id} failed:`, err);
});

// Fixed jobId so re-registering this repeatable job on every worker start — including a
// tsx-watch reload in dev — upserts the same schedule instead of piling up a second one running
// alongside it. BullMQ keys a repeatable job by its name + jobId + repeat pattern together, so
// re-adding with all three unchanged is a no-op.
sandboxReapQueue
  .add("scan-idle-sandboxes", {}, { repeat: { every: SANDBOX_REAP_INTERVAL_MS }, jobId: "sandbox-reap-scan" })
  .catch((err) => {
    console.error("Failed to register sandbox reap scan:", err);
  });

// Triggered when an agent's or team's defaultCodebase is set (apps/web's agent/team routes) —
// best-effort pre-warm so the first real task against that repo doesn't pay the generation cost
// synchronously. Never touches runs/sessions/events; failures are logged, not surfaced anywhere.
const repoMapWarmWorker = new Worker<RepoMapWarmJobData>(
  REPO_MAP_WARM_QUEUE_NAME,
  async (job) => {
    const { orgId, repoFullName } = job.data;
    await warmRepoMap(sandboxProvider, orgId, repoFullName, SANDBOX_IMAGE);
  },
  { connection: queueConnection },
);

repoMapWarmWorker.on("failed", (job, err) => {
  console.error(`Repo map warm job ${job?.id} failed:`, err);
});

// Triggered by the task page's Evaluate button (apps/web's /api/runs/[runId]/evals route) —
// grades a finished run's artefact against the human-authored prompt layers. Own queue so
// grading starts when the user clicks instead of waiting behind ~60s agent runs.
const evalWorker = new Worker<EvalJobData>(
  EVAL_QUEUE_NAME,
  async (job) => {
    await processEvalJob(job.data.evalId);
  },
  { connection: queueConnection },
);

evalWorker.on("failed", (job, err) => {
  console.error(`Eval job ${job?.id} failed:`, err);
});

// Triggered by a document upload (apps/web's /api/teams/[teamId]/context-items route) —
// extracts, chunks and embeds the file so PR 5's retrieval can reach it. Own queue for the
// same reason the eval queue is its own: an upload's feedback loop is a status badge the
// uploader is watching, and it must not wait behind a ~60s agent run. This is the only queue
// in this process whose jobs retry (see enqueueTeamContextIngestJob); the handler itself never
// rejects, so what BullMQ retries here is a crashed or stalled delivery, not a logical failure.
const contextIngestWorker = new Worker<ContextIngestJobData>(
  TEAM_CONTEXT_INGEST_QUEUE_NAME,
  async (job) => {
    await ingestTeamContextItem(job.data.itemId);
  },
  { connection: queueConnection },
);

contextIngestWorker.on("failed", (job, err) => {
  console.error(`Context ingest job ${job?.id} failed:`, err);
});

// Triggered by a document upload on the task-scoped route (apps/web's
// /api/tasks/[taskId]/context-items) — same extract/chunk/embed pipeline as the team ingest
// worker above, on its own queue: TASK_CONTEXT_INGEST_QUEUE_NAME has its own jobId namespace
// (see that queue's definition) so a team item and a task item can never collide on the same
// BullMQ job id even when their numeric ids happen to match.
const taskContextIngestWorker = new Worker<TaskContextIngestJobData>(
  TASK_CONTEXT_INGEST_QUEUE_NAME,
  async (job) => {
    await ingestTaskContextItem(job.data.itemId);
  },
  { connection: queueConnection },
);

taskContextIngestWorker.on("failed", (job, err) => {
  console.error(`Task context ingest job ${job?.id} failed:`, err);
});

console.log(
  `apps/worker listening on queues "${RUN_QUEUE_NAME}", "${SANDBOX_TEARDOWN_QUEUE_NAME}", ` +
    `"${SANDBOX_REAP_QUEUE_NAME}", "${REPO_MAP_WARM_QUEUE_NAME}", "${EVAL_QUEUE_NAME}", ` +
    `"${TEAM_CONTEXT_INGEST_QUEUE_NAME}", "${TASK_CONTEXT_INGEST_QUEUE_NAME}"`,
);
