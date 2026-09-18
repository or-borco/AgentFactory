import { NextResponse } from "next/server";
import {
  authorizeExternalUser,
  clearRedemptionAttempts,
  createMessage,
  createRun,
  createTask,
  findChannelConnectionByWebhookSecret,
  getAgent,
  getAuthorizationStatus,
  getAuthorizedUser,
  getConnectionCredentialRef,
  getInviteCodeRedeemer,
  getOrgOwnerUserId,
  getSession,
  getTask,
  isInCooldown,
  listConnections,
  listTasks,
  looksLikeInviteCode,
  readConnectionSecret,
  recordFailedRedemption,
  redeemInviteCode,
  setActiveTask,
  startTaskSession,
  touchSessionActivity,
  updateTask,
} from "@agentfactory/db";
import { createChannelAdapter, type ChannelAdapter } from "@agentfactory/integrations";
import { enqueueRepoMapWarmJob, enqueueRunJob } from "@agentfactory/queue";
import { getScmProvider, type RepoOption } from "@agentfactory/scm";
import type { Agent, Connection, Session, Task, TaskStatus } from "@agentfactory/core";
import { createLogger } from "@agentfactory/logger";
import { formatTaskBrief } from "@/server/task-brief";

const log = createLogger("webhooks:telegram");

const WELCOME_MESSAGE = (orgLabel: string) =>
  `This connects you to ${orgLabel}'s agents on AgentFactory. Send the invite code your admin gave you to get started.`;
const INVALID_CODE_MESSAGE = "That code isn't valid — ask your admin for a new one.";
const COOLDOWN_MESSAGE = "Too many invalid codes — try again in a bit.";
const REVOKED_MESSAGE = "Your access was revoked — ask your admin for a new invite.";
const ASK_FOR_CODE_MESSAGE = "Send your invite code to get started.";
const MAIN_MENU_PROMPT = "What would you like to do?";
const NEW_TASK_PROMPT = "Tell me what you need done.";
const CODEBASE_PICKER_PROMPT = "Which repo should this run against?";
const NO_REPO_LABEL = "No repository";
const NO_REPO_CALLBACK_VALUE = "codebase:none";
const CODEBASE_CALLBACK_PREFIX = "codebase:";
// Sentinel for "asked, and the user explicitly chose none" — distinct from the DB's own `null`,
// which already means "never asked" (see task.codebase's nullable column). Falsy either way, so it
// still reads as "no repo" everywhere downstream (startTask's default fallback, the worker's clone
// check), but it stops the picker from re-prompting on every subsequent message.
const CODEBASE_DECLINED = "";
const NEW_TASK_LABEL = "Start a new task";
const DRAFT_TASK_TITLE = "New task";
const TITLE_MAX_LENGTH = 80;
const MAIN_MENU_TASK_LIMIT = 10;
const RUNNING_ELSEWHERE_MESSAGE = (title: string) =>
  `"${title}" is already running elsewhere — I can't relay messages to it from here. Send /tasks to pick something else.`;

const STATUS_LABELS: Partial<Record<TaskStatus, string>> = {
  open: "open",
  assigned: "assigned",
  in_progress: "in progress",
  needs_input: "needs input",
  pr_open: "PR open",
  review_cycle: "in review",
};

export async function POST(request: Request, { params }: { params: Promise<{ webhookSecret: string }> }) {
  const { webhookSecret } = await params;

  const resolved = await findChannelConnectionByWebhookSecret(webhookSecret);
  if (!resolved) return new NextResponse(null, { status: 404 });
  const { connection, orgId, secretToken } = resolved;

  // Defense in depth against the path secret alone leaking (e.g. via a proxy/access log): Telegram
  // echoes back whatever secret_token was registered with setWebhook, and the connect route
  // deliberately generates that as a *separate* random value from the path segment, so knowing the
  // URL is not enough to satisfy this check. A connection with no stored token can't be
  // authenticated at all — treat it as unknown rather than falling back to the path secret, which
  // would collapse the two layers back into one.
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secretToken || secretHeader !== secretToken) return new NextResponse(null, { status: 404 });

  const credentialRef = await getConnectionCredentialRef(orgId, connection.id);
  if (credentialRef == null) return new NextResponse(null, { status: 200 });
  const secret = await readConnectionSecret(orgId, credentialRef);
  if (!secret) return new NextResponse(null, { status: 200 });

  const adapter = createChannelAdapter(connection, secret);
  const raw = await request.json();
  let inbound;
  try {
    inbound = adapter.receive(raw);
  } catch {
    return new NextResponse(null, { status: 200 }); // unrecognized update shape — ack and ignore
  }

  const connectionAgentId = resolved.agentId;
  if (connectionAgentId == null) {
    // Channel connection has no agent configured — misconfigured bot, nothing to do.
    log.warn("Channel connection has no agentId configured", { connectionId: connection.id });
    return new NextResponse(null, { status: 200 });
  }

  try {
    await handleInbound(adapter, orgId, connection, connectionAgentId, inbound);
  } catch (err) {
    // Never let an internal error surface as a non-200 to Telegram — a 5xx here triggers
    // Telegram's own retry-storm behavior, exactly what this design exists to avoid. A transient
    // Postgres/Redis blip just means this update is dropped; Telegram doesn't get a signal to
    // resend it, but that's preferable to a retry storm hammering an already-struggling backend.
    log.error("Failed to handle inbound Telegram update", { connectionId: connection.id, err });
  }
  return new NextResponse(null, { status: 200 });
}

async function handleInbound(
  adapter: ChannelAdapter,
  orgId: number,
  connection: Connection,
  connectionAgentId: number,
  inbound: ReturnType<ChannelAdapter["receive"]>,
) {
  const { externalUserId } = inbound;
  const status = await getAuthorizationStatus(connection.id, externalUserId);

  if (status !== "authorized") {
    if (inbound.isStartCommand && !inbound.startPayload) {
      await adapter.send(externalUserId, WELCOME_MESSAGE(connection.label));
      return;
    }

    // Only text actually shaped like a code counts as a redemption attempt. Treating every
    // message as one meant a newcomer typing "hi" spent one of their five attempts and could be
    // locked out without ever being told what to send. Upper-cased because the alphabet is
    // uppercase-only and `code` is a case-sensitive text column — a hand-typed lowercase code is a
    // real attempt at a real code, not a different code, so it shouldn't fail for casing alone.
    const candidateCode = (inbound.startPayload ?? inbound.text?.trim())?.toUpperCase();
    if (!candidateCode || !looksLikeInviteCode(candidateCode)) {
      await adapter.send(externalUserId, status === "revoked" ? REVOKED_MESSAGE : ASK_FOR_CODE_MESSAGE);
      return;
    }
    if (!(await attemptRedemption(adapter, connection, externalUserId, candidateCode))) return;

    // Authorized now. A re-authorized chat may already have an activeTaskId from before it was
    // revoked — authorizeExternalUser's upsert only ever touches revokedAt, so that pointer
    // survives untouched. Resume there instead of always starting fresh.
    const authorizedUser = await getAuthorizedUser(connection.id, externalUserId);
    const priorTask = authorizedUser?.activeTaskId ? await getTask(authorizedUser.activeTaskId) : undefined;
    const validPriorTask = priorTask && priorTask.orgId === orgId ? priorTask : undefined;
    if (authorizedUser?.activeTaskId && !validPriorTask) {
      // Stale/tampered pointer (e.g. cross-org) — clear it now rather than relying on the next
      // message to self-heal through Step 2's equivalent check.
      await setActiveTask(connection.id, externalUserId, null);
    }
    await sendCurrentStepPrompt(adapter, orgId, externalUserId, connectionAgentId, validPriorTask);
    return;
  }

  // Step 1 — commands and menu taps, checked before anything else, so they always work regardless
  // of what this chat's activeTaskId currently points at.
  if ((inbound.isStartCommand && !inbound.startPayload) || inbound.isTasksCommand) {
    await showMainMenu(adapter, orgId, externalUserId, connectionAgentId);
    return;
  }

  if (inbound.callbackData === "newtask") {
    const createdBy = await inviterUserIdFor(connection.id, externalUserId, orgId);
    const task = await createTask(orgId, createdBy, { title: DRAFT_TASK_TITLE, description: "", acceptanceCriteria: [], assigneeAgentId: connectionAgentId });
    await setActiveTask(connection.id, externalUserId, task.id);
    await adapter.send(externalUserId, NEW_TASK_PROMPT);
    return;
  }

  if (inbound.callbackData?.startsWith("task:")) {
    const taskId = parseIntOrNull(inbound.callbackData.slice("task:".length));
    const task = taskId !== null ? await getTask(taskId) : undefined;
    if (!task || task.orgId !== orgId) {
      // Tampered, stale, or cross-org callback — never trust the id blindly (mirrors the
      // existing agent: handler's own NaN/orgId guards).
      await showMainMenu(adapter, orgId, externalUserId, connectionAgentId);
      return;
    }
    await setActiveTask(connection.id, externalUserId, task.id);
    // Routes through sendCurrentStepPrompt, never the Step 3 forwarding logic below: a tap
    // carries no inbound.text, and Step 3's running-task branch returns early with nothing sent
    // whenever inbound.text is absent — falling through there on a tap would silently no-op on
    // exactly the headline case this feature exists to fix (tapping a running task from the menu).
    await sendCurrentStepPrompt(adapter, orgId, externalUserId, connectionAgentId, task);
    return;
  }

  // Step 2 — none of the above matched; resolve the chat's remembered task.
  const authorizedUser = await getAuthorizedUser(connection.id, externalUserId);
  const activeTaskId = authorizedUser?.activeTaskId;
  if (!activeTaskId) {
    await showMainMenu(adapter, orgId, externalUserId, connectionAgentId); // unrecognized input, nothing focused
    return;
  }

  let activeTask = await getTask(activeTaskId);
  if (!activeTask || activeTask.orgId !== orgId) {
    // Shouldn't happen — activeTaskId is only ever set from a task already checked against this
    // orgId — but never trust a stored pointer over a fresh check.
    await setActiveTask(connection.id, externalUserId, null);
    await showMainMenu(adapter, orgId, externalUserId, connectionAgentId);
    return;
  }

  // Step 3 — act on activeTask (reached only by falling through Step 2 — a fresh task: tap never
  // reaches here; it's handled entirely in Step 1 via sendCurrentStepPrompt).
  if (activeTask.sessionId) {
    // Running — forward, mirroring the web message route exactly, including its failed-task reset.
    if (!inbound.text) return; // a stray callback on a running task — nothing to do
    const session = await getSession(activeTask.sessionId);
    if (!session || !sessionBelongsToChat(session, externalUserId)) {
      // The session belongs to a different chat, or to the web UI — forwarding into it would
      // burn a run whose reply nobody in this chat would ever see (notifySessionOfReply only
      // delivers to the session's own origin/thread).
      await adapter.send(externalUserId, RUNNING_ELSEWHERE_MESSAGE(activeTask.title));
      return;
    }
    if (activeTask.status === "failed") {
      await updateTask(activeTask.id, { status: "in_progress" });
    }
    const userMessage = await createMessage(activeTask.sessionId, "user", inbound.text);
    await touchSessionActivity(activeTask.sessionId);
    const run = await createRun(activeTask.sessionId, userMessage.id);
    try {
      await adapter.sendTyping(externalUserId);
    } catch (err) {
      log.warn("Failed to send Telegram typing indicator", { connectionId: connection.id, err });
    }
    await enqueueRunJob(run.id);
    return;
  }

  if (activeTask.title === DRAFT_TASK_TITLE && activeTask.description === "") {
    // Draft sentinel: only our own placeholder, not any web-created task with a blank
    // description, counts as "awaiting a description".
    if (!inbound.text) {
      await adapter.send(externalUserId, NEW_TASK_PROMPT);
      return;
    }
    // A message starting with a newline makes firstLine(...) empty — fall back to the placeholder
    // title rather than persisting a blank one.
    const title = firstLine(inbound.text).slice(0, TITLE_MAX_LENGTH) || DRAFT_TASK_TITLE;
    activeTask = await updateTask(activeTask.id, { title, description: inbound.text });
    const agent = (await getAgent(activeTask.assigneeAgentId!))!;
    await promptCodebaseOrStart(adapter, orgId, externalUserId, activeTask, agent);
    return;
  }

  // Agent already set (auto-assigned at task creation); still undecided on a codebase (never reached the picker, or its menu is
  // still pending) — resolve that before starting, mirroring the web form's codebase field.
  if (activeTask.codebase == null) {
    const agent = (await getAgent(activeTask.assigneeAgentId!))!;
    if (inbound.callbackData === NO_REPO_CALLBACK_VALUE) {
      activeTask = await updateTask(activeTask.id, { codebase: CODEBASE_DECLINED });
      await startTask(adapter, orgId, externalUserId, activeTask, agent, inbound.text);
    } else if (inbound.callbackData?.startsWith(CODEBASE_CALLBACK_PREFIX)) {
      const repo = await resolveRepoFromCallback(orgId, inbound.callbackData);
      if (!repo) {
        await sendCodebasePickerMenu(adapter, orgId, externalUserId, agent);
        return;
      }
      activeTask = await updateTask(activeTask.id, { codebase: repo.fullName });
      const taskId = activeTask.id;
      enqueueRepoMapWarmJob(orgId, repo.fullName).catch((err) => {
        log.warn("Failed to enqueue repo map warm job", { taskId, err });
      });
      await startTask(adapter, orgId, externalUserId, activeTask, agent, inbound.text);
    } else {
      await sendCodebasePickerMenu(adapter, orgId, externalUserId, agent); // re-prompt on stray text
    }
    return;
  }

  // Description, agent, and codebase all set, no session yet — e.g. a task fully configured via
  // the web UI, then picked from the Telegram resume list, or reached here by typing instead of
  // tapping. Just start it, using what it already has. inbound.text (if any) is folded into the
  // brief rather than silently discarded.
  // assigneeAgentId is set (auto-assigned at task creation), and ON DELETE SET NULL means the
  // referenced agent row still exists whenever the column is non-null — the assertion reflects that.
  const agent = (await getAgent(activeTask.assigneeAgentId!))!;
  await startTask(adapter, orgId, externalUserId, activeTask, agent, inbound.text);
}

/**
 * Runs one invite-code redemption for a chat that isn't currently authorized, replying with the
 * cooldown/invalid message on failure. Returns whether the chat came out of it authorized. Shared
 * by the has-a-session and no-session paths: whether a session exists changes what happens *after*
 * admission, never how admission itself works.
 */
async function attemptRedemption(
  adapter: ChannelAdapter,
  connection: Connection,
  externalUserId: string,
  candidateCode: string,
): Promise<boolean> {
  if (await isInCooldown(connection.id, externalUserId)) {
    await adapter.send(externalUserId, COOLDOWN_MESSAGE);
    return false;
  }
  const redeemed = await redeemInviteCode(candidateCode, externalUserId);
  // redeemInviteCode matches purely on the globally-unique code column — it has no notion of
  // which bot the message came in on. A code minted for a different org's connection (leaked,
  // or pasted into the wrong bot) still redeems successfully here, so it must be rejected
  // exactly like an invalid code rather than authorizing against the WRONG connection. The
  // code is already burned by the atomic UPDATE at this point — that's an accepted tradeoff
  // (re-issuing it would reintroduce the race redeemInviteCode's atomicity exists to avoid).
  if (!redeemed || redeemed.connectionId !== connection.id) {
    await recordFailedRedemption(connection.id, externalUserId);
    await adapter.send(externalUserId, INVALID_CODE_MESSAGE);
    return false;
  }
  await clearRedemptionAttempts(connection.id, externalUserId);
  await authorizeExternalUser(connection.id, externalUserId);
  return true;
}

function parseIntOrNull(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

// A task's session is only relayable from the chat it actually belongs to: a web-originated
// session has no Telegram thread to notify, and two Telegram chats resuming the same org-wide
// task must not both get forwarded into whichever one the session happened to be created from —
// see notifySessionOfReply (apps/worker/src/channel-notify.ts), which only delivers to the
// session's own origin/externalThreadRef.
function sessionBelongsToChat(session: Session, externalUserId: string): boolean {
  return session.origin === "telegram" && session.externalThreadRef === externalUserId;
}

async function showMainMenu(adapter: ChannelAdapter, orgId: number, externalUserId: string, agentId: number): Promise<void> {
  const openTasks = (await listTasks(orgId))
    .filter((t) => t.status !== "done" && t.status !== "failed" && t.status !== "cancelled" && t.assigneeAgentId === agentId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) // updatedAt descending
    .slice(0, MAIN_MENU_TASK_LIMIT);

  await adapter.sendMenu(externalUserId, MAIN_MENU_PROMPT, [
    { label: NEW_TASK_LABEL, value: "newtask" },
    ...openTasks.map((t) => ({
      label: `${t.ref} · ${t.title} · ${STATUS_LABELS[t.status] ?? t.status}`,
      value: `task:${t.id}`,
    })),
  ]);
}

// Mirrors the web "New task" form's Codebase field (apps/web/src/app/(app)/tasks/new/page.tsx),
// which sources its options from every one of the org's scm connections via each provider's own
// listRepos — same merge-and-dedupe shape as apps/web/src/app/api/connections/repos/route.ts.
async function listConnectedRepos(orgId: number): Promise<RepoOption[]> {
  const scmConnections = (await listConnections(orgId)).filter((c) => c.kind === "scm");
  const repoLists = await Promise.all(
    scmConnections.map(async (connection): Promise<RepoOption[]> => {
      const provider = getScmProvider(connection.provider);
      if (!provider) return [];
      try {
        const repos = await provider.listRepos(connection);
        return repos.map((r) => ({ ...r, provider: connection.provider }));
      } catch {
        // A revoked/broken installation shouldn't take down the whole picker — skip it.
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  return repoLists.flat().filter((repo) => {
    const key = `${repo.provider}:${repo.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Callback values are `codebase:<provider>:<repo id>` rather than the raw "owner/repo" full name,
// to stay well under Telegram's 64-byte callback_data cap for long repo names.
async function resolveRepoFromCallback(orgId: number, callbackData: string): Promise<RepoOption | undefined> {
  const [provider, id] = callbackData.slice(CODEBASE_CALLBACK_PREFIX.length).split(":");
  if (!provider || !id) return undefined;
  const repos = await listConnectedRepos(orgId);
  return repos.find((r) => r.provider === provider && r.id === id);
}

// Returns true if a menu was sent (caller should stop and wait for the tap); false if there was
// nothing to choose (no repos connected to the org yet) and the caller should proceed as-is,
// falling back to startTask's own agent.defaultCodebase handling.
async function sendCodebasePickerMenu(
  adapter: ChannelAdapter,
  orgId: number,
  externalUserId: string,
  agent: Agent,
): Promise<boolean> {
  const repos = await listConnectedRepos(orgId);
  if (repos.length === 0) return false;
  await adapter.sendMenu(externalUserId, CODEBASE_PICKER_PROMPT, [
    ...repos.map((repo) => ({
      label: repo.fullName === agent.defaultCodebase ? `${repo.fullName} (default)` : repo.fullName,
      value: `${CODEBASE_CALLBACK_PREFIX}${repo.provider}:${repo.id}`,
    })),
    { label: NO_REPO_LABEL, value: NO_REPO_CALLBACK_VALUE },
  ]);
  return true;
}

// Called right after an agent is picked (or resolved) for a task with no codebase decision yet.
// Prompts for one if the org has repos connected; otherwise starts immediately, same as before
// this step existed.
async function promptCodebaseOrStart(
  adapter: ChannelAdapter,
  orgId: number,
  externalUserId: string,
  task: Task,
  agent: Agent,
): Promise<void> {
  if (task.codebase == null && (await sendCodebasePickerMenu(adapter, orgId, externalUserId, agent))) return;
  await startTask(adapter, orgId, externalUserId, task, agent);
}

// Implements the task-attribution design decision: a Telegram-created task is attributed to
// whichever admin generated the invite code this chat redeemed, falling back to the org's owner
// if (unreachably, in practice) no redeemer row can be found. Every org gets an "owner" membership
// at registration and authorization only ever follows a real redemption, so at least one of the
// two lookups below always resolves — the throw exists to surface a violation of that invariant
// loudly rather than silently persist a wrong createdBy value.
async function inviterUserIdFor(connectionId: number, externalUserId: string, orgId: number): Promise<number> {
  const redeemer = await getInviteCodeRedeemer(connectionId, externalUserId);
  if (redeemer) return redeemer.createdBy;
  const owner = await getOrgOwnerUserId(orgId);
  if (owner) return owner;
  throw new Error(`No task-creator attribution available for org ${orgId}`);
}

async function startTask(
  adapter: ChannelAdapter,
  orgId: number,
  externalUserId: string,
  task: Task,
  agent: Agent,
  extraText?: string,
): Promise<void> {
  // Fallback for tasks that reach startTask without ever going through promptCodebaseOrStart (e.g.
  // fully configured via the web UI with no codebase chosen there either). `== null` — not `!` —
  // so an explicit CODEBASE_DECLINED ("", "the user picked 'No repository'") is left alone rather
  // than silently overridden by the agent's default.
  if (task.codebase == null && agent.defaultCodebase) {
    const codebase = agent.defaultCodebase;
    task = await updateTask(task.id, { codebase });
    enqueueRepoMapWarmJob(orgId, codebase).catch((err) => {
      log.warn("Failed to enqueue repo map warm job", { taskId: task.id, err });
    });
  }
  const brief = extraText ? `${formatTaskBrief(task)}\n\n${extraText}` : formatTaskBrief(task);
  const result = await startTaskSession(task.id, orgId, agent.id, task.title, brief, {
    origin: "telegram",
    externalThreadRef: externalUserId,
  });
  if (!result.started) {
    const winner = result.task.assigneeAgentId ? await getAgent(result.task.assigneeAgentId) : undefined;
    await adapter.send(externalUserId, `Already started — talking to ${winner?.name ?? agent.name}.`);
    return;
  }
  const run = await createRun(result.session.id, result.userMessageId);
  await enqueueRunJob(run.id);
  await adapter.send(externalUserId, `Starting "${task.title}" with ${agent.name}...`);
}

// Called after a successful invite-code redemption, and from Step 1's task: tap — never from
// Step 3's forwarding logic, which would treat a just-redeemed code (or a tap's absent text) as a
// real chat message. Both entry points share this one definition of "what to say about this
// task's current state".
async function sendCurrentStepPrompt(
  adapter: ChannelAdapter,
  orgId: number,
  externalUserId: string,
  connectionAgentId: number,
  activeTask: Task | undefined,
): Promise<void> {
  if (!activeTask) {
    await showMainMenu(adapter, orgId, externalUserId, connectionAgentId);
    return;
  }
  if (activeTask.sessionId) {
    const session = await getSession(activeTask.sessionId);
    if (!session || !sessionBelongsToChat(session, externalUserId)) {
      await adapter.send(externalUserId, RUNNING_ELSEWHERE_MESSAGE(activeTask.title));
      return;
    }
    const agent = activeTask.assigneeAgentId ? await getAgent(activeTask.assigneeAgentId) : undefined;
    await adapter.send(
      externalUserId,
      `Welcome back — "${activeTask.title}" is running with ${agent?.name ?? "your agent"}. Send a message to continue, or /tasks to switch.`,
    );
    return;
  }
  if (activeTask.title === DRAFT_TASK_TITLE && activeTask.description === "") {
    await adapter.send(externalUserId, NEW_TASK_PROMPT);
    return;
  }
  // Description set, no session: fully configured but not yet running (e.g. tapped from the resume
  // list, or re-authorized mid-configuration). Tasks created via the web UI may have no agent
  // assigned yet — fall back to the main menu so the user can pick one. For Telegram-created tasks
  // the agent is auto-assigned at creation, so this guard only fires on web-originated tasks.
  // No extraText here — neither a tap nor a redemption carries real chat text to fold in.
  if (!activeTask.assigneeAgentId) {
    await showMainMenu(adapter, orgId, externalUserId, connectionAgentId);
    return;
  }
  const agent = (await getAgent(activeTask.assigneeAgentId))!;
  await promptCodebaseOrStart(adapter, orgId, externalUserId, activeTask, agent);
}
