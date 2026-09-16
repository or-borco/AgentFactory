"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Agent, ChatMessage, Connection, OrgMember, OverflowPolicy, Run, Session, Task, Team, TaskExternalRef } from "@agentfactory/core";
import type { ExternalAttachment, ExternalIssue } from "@agentfactory/integrations";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey, TranslationVars } from "@/lib/i18n/paths";
import { findErrorCodeForRun } from "@/lib/run-errors";

// runTask's result when POST /api/tasks/[taskId]/run responds 409 { code: "task_stale" } (see
// apps/web/src/app/api/tasks/[taskId]/run/route.ts) — a discriminated return rather than a thrown
// error, mirroring checkTaskSync's own `{ stale: false } | { stale: true; latest }` shape server-side.
// (An earlier version of this threw a TaskStaleError instead; that tripped
// react-hooks/purity on every caller — try/catch around the impure setRunStartedAt(Date.now())
// call made the linter unable to prove those callers were still event handlers.)
export type RunTaskResult =
  | { stale: false; task: Task; session: Session; runId: number }
  | { stale: true; latest: ExternalIssue };

type DisplayMessage = ChatMessage & { streaming?: boolean; error?: boolean };

interface MockState {
  teams: Team[];
  agents: Agent[];
  sessions: Session[];
  messages: DisplayMessage[];
  connections: Connection[];
  tasks: Task[];
  orgMembers: OrgMember[];
}

const EMPTY_STATE: MockState = { teams: [], agents: [], sessions: [], messages: [], connections: [], tasks: [], orgMembers: [] };

interface NewAgentInput {
  name: string;
  description: string;
  systemPrompt: string;
  mode: "manual" | "automatic";
  teamId?: number;
  /** Model catalog id (see @agentfactory/core MODEL_CATALOG). Defaults to DEFAULT_MODEL_ID. */
  model?: string;
  onContextOverflow?: OverflowPolicy;
  defaultCodebase?: string;
}

interface NewTaskInput {
  title: string;
  description: string;
  acceptanceCriteria: Task["acceptanceCriteria"];
  assigneeAgentId?: number;
  area?: string;
  codebase?: string;
  /** Overrides the assignee agent's default model for this task. */
  model?: Task["model"];
  /** Set when the task was created from the From-issue field (see tasks/new/page.tsx). */
  externalRef?: TaskExternalRef;
  /** The linked issue's attachments, fetched client-side in Step 3 of the From-issue flow — the
   *  server re-downloads their bytes itself (it holds the credential, the browser never does)
   *  but needs this list to know what to fetch. Ignored unless `externalRef` is also set. */
  attachments?: ExternalAttachment[];
}

interface MockBackendValue extends MockState {
  toast: { key: TranslationKey; vars?: TranslationVars } | null;
  notify: (key: TranslationKey, vars?: TranslationVars) => void;
  getAgent: (id: number) => Agent | undefined;
  getTeam: (id: number) => Team | undefined;
  getSession: (id: number) => Session | undefined;
  getTask: (id: number) => Task | undefined;
  sessionsForAgent: (agentId: number) => Session[];
  agentsForTeam: (teamId: number) => Agent[];
  messagesForSession: (sessionId: number) => DisplayMessage[];
  loadMessages: (sessionId: number) => Promise<void>;
  createTeam: (name: string, description: string, defaultCodebase?: string) => Promise<Team>;
  updateTeam: (teamId: number, patch: { name: string; description: string }) => Promise<void>;
  updateTeamSharedContext: (teamId: number, sharedContext: string) => Promise<void>;
  assignAgentToTeam: (agentId: number, teamId: number) => Promise<void>;
  createAgent: (input: NewAgentInput) => Promise<Agent>;
  updateAgent: (
    agentId: number,
    patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode" | "areaMap" | "defaultCodebase">> & {
      model?: string;
      onContextOverflow?: OverflowPolicy;
    },
  ) => Promise<void>;
  deleteAgent: (agentId: number) => Promise<void>;
  createSession: (agentId: number, title: string) => Promise<Session>;
  sendMessage: (sessionId: number, text: string) => Promise<{ runId: number }>;
  createTask: (input: NewTaskInput) => Promise<Task>;
  updateTask: (taskId: number, patch: Partial<Task>) => Promise<void>;
  refreshTask: (taskId: number) => Promise<void>;
  deleteTask: (taskId: number) => Promise<void>;
  /** `body.acknowledgeStale` is forwarded to the run route as-is (see Task 7 Step 4 of the Jira
   *  plan) — omit it for a normal run; pass `{ acknowledgeStale: true }` only from the stale-run
   *  dialog's "Run anyway" action, after the user has already seen the diff. Resolves to
   *  `{ stale: true, latest }` (never throws for this case) when the route responds 409
   *  `{ code: "task_stale" }` — see the `RunTaskResult` comment above. */
  runTask: (taskId: number, body?: { acknowledgeStale?: boolean }) => Promise<RunTaskResult>;
  deleteConnection: (connectionId: number) => Promise<void>;
  /** Merges a just-created connection into the client cache (e.g. after `POST /api/connections/jira`
   *  succeeds) without a full re-fetch, mirroring how `deleteConnection` updates the same list. */
  addConnection: (connection: Connection) => void;
}

// Best-effort lookup of the classified ErrorCode for a failed run, via the same events endpoint
// the task detail page uses (see run-errors.ts). Never throws — a fetch failure here shouldn't
// stop the user from seeing at least the generic failure message.
async function fetchRunErrorCode(sessionId: number, runId: number): Promise<string | undefined> {
  try {
    const events = await apiFetch<Array<{ runId: number; type: string; data: Record<string, unknown> }>>(
      `/api/sessions/${sessionId}/events`,
    );
    return findErrorCodeForRun(events, runId);
  } catch {
    return undefined;
  }
}

const MockBackendContext = createContext<MockBackendValue | null>(null);

export function MockBackendProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<MockState>(EMPTY_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [toast, setToast] = useState<{ key: TranslationKey; vars?: TranslationVars } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<Team[]>("/api/teams"),
      apiFetch<Agent[]>("/api/agents"),
      apiFetch<Session[]>("/api/sessions"),
      apiFetch<Connection[]>("/api/connections"),
      apiFetch<Task[]>("/api/tasks"),
      apiFetch<OrgMember[]>("/api/teams/members"),
    ])
      .then(([teams, agents, sessions, connections, tasks, orgMembers]) => {
        if (cancelled) return;
        setState({ teams, agents, sessions, messages: [], connections, tasks, orgMembers });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showToast = useCallback((key: TranslationKey, vars?: TranslationVars) => {
    setToast({ key, vars });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const getAgent = useCallback((id: number) => state.agents.find((a) => a.id === id), [state.agents]);
  const getTeam = useCallback((id: number) => state.teams.find((t) => t.id === id), [state.teams]);
  const getSession = useCallback((id: number) => state.sessions.find((s) => s.id === id), [state.sessions]);
  const getTask = useCallback((id: number) => state.tasks.find((tk) => tk.id === id), [state.tasks]);
  const sessionsForAgent = useCallback(
    (agentId: number) =>
      state.sessions
        .filter((s) => s.agentId === agentId)
        .sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt)),
    [state.sessions],
  );
  const agentsForTeam = useCallback(
    (teamId: number) => state.agents.filter((a) => a.teamId === teamId),
    [state.agents],
  );
  const messagesForSession = useCallback(
    (sessionId: number) => state.messages.filter((m) => m.sessionId === sessionId),
    [state.messages],
  );

  const loadMessages = useCallback(async (sessionId: number) => {
    const messages = await apiFetch<ChatMessage[]>(`/api/sessions/${sessionId}/messages`);
    setState((s) => ({ ...s, messages: [...s.messages.filter((m) => m.sessionId !== sessionId), ...messages] }));
  }, []);

  const createTeam = useCallback(
    async (name: string, description: string, defaultCodebase?: string) => {
      const team = await apiFetch<Team>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name, description, defaultCodebase }),
      });
      setState((s) => ({ ...s, teams: [...s.teams, team] }));
      showToast("toast.teamCreated");
      return team;
    },
    [showToast],
  );

  const updateTeam = useCallback(
    async (teamId: number, patch: { name: string; description: string }) => {
      const team = await apiFetch<Team>(`/api/teams/${teamId}`, { method: "PATCH", body: JSON.stringify(patch) });
      setState((s) => ({ ...s, teams: s.teams.map((t) => (t.id === teamId ? team : t)) }));
      showToast("toast.teamUpdated");
    },
    [showToast],
  );

  const updateTeamSharedContext = useCallback(
    async (teamId: number, sharedContext: string) => {
      const team = await apiFetch<Team>(`/api/teams/${teamId}`, { method: "PATCH", body: JSON.stringify({ sharedContext }) });
      setState((s) => ({ ...s, teams: s.teams.map((t) => (t.id === teamId ? team : t)) }));
      showToast("toast.sharedContextSaved");
    },
    [showToast],
  );

  const assignAgentToTeam = useCallback(async (agentId: number, teamId: number) => {
    const agent = await apiFetch<Agent>(`/api/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ teamId }) });
    setState((s) => ({ ...s, agents: s.agents.map((a) => (a.id === agentId ? agent : a)) }));
  }, []);

  const createAgent = useCallback(
    async (input: NewAgentInput) => {
      const agent = await apiFetch<Agent>("/api/agents", { method: "POST", body: JSON.stringify(input) });
      setState((s) => ({ ...s, agents: [...s.agents, agent] }));
      showToast("toast.agentCreated");
      return agent;
    },
    [showToast],
  );

  const updateAgent = useCallback(
    async (
      agentId: number,
      patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode" | "areaMap" | "defaultCodebase">> & {
        model?: string;
        onContextOverflow?: OverflowPolicy;
      },
    ) => {
      const agent = await apiFetch<Agent>(`/api/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(patch) });
      setState((s) => ({ ...s, agents: s.agents.map((a) => (a.id === agentId ? agent : a)) }));
      showToast("toast.agentUpdated");
    },
    [showToast],
  );

  const deleteAgent = useCallback(async (agentId: number) => {
    await apiFetch<void>(`/api/agents/${agentId}`, { method: "DELETE" });
    setState((s) => ({ ...s, agents: s.agents.filter((a) => a.id !== agentId) }));
    showToast("toast.agentDeleted");
  }, [showToast]);

  const createSession = useCallback(async (agentId: number, title: string) => {
    const session = await apiFetch<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ agentId, title }) });
    setState((s) => ({ ...s, sessions: [...s.sessions, session] }));
    return session;
  }, []);

  const createTask = useCallback(
    async (input: NewTaskInput) => {
      const task = await apiFetch<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) });
      setState((s) => ({ ...s, tasks: [task, ...s.tasks] }));
      showToast("toast.taskCreated");
      return task;
    },
    [showToast],
  );

  const updateTask = useCallback(async (taskId: number, patch: Partial<Task>) => {
    const task = await apiFetch<Task>(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) });
    setState((s) => ({ ...s, tasks: s.tasks.map((tk) => (tk.id === taskId ? task : tk)) }));
  }, []);

  // Re-fetches a single task from the server without a PATCH. Needed because the worker
  // updates task rows directly (e.g. prNumber/prUrl/status when it opens a PR) — those writes
  // never go through this client, so the cached task here would otherwise only pick up such
  // changes on the next full page load.
  const refreshTask = useCallback(async (taskId: number) => {
    const task = await apiFetch<Task>(`/api/tasks/${taskId}`);
    setState((s) => ({ ...s, tasks: s.tasks.map((tk) => (tk.id === taskId ? task : tk)) }));
  }, []);

  const deleteTask = useCallback(
    async (taskId: number) => {
      await apiFetch<void>(`/api/tasks/${taskId}`, { method: "DELETE" });
      setState((s) => ({ ...s, tasks: s.tasks.filter((tk) => tk.id !== taskId) }));
      showToast("toast.taskDeleted");
    },
    [showToast],
  );

  const deleteConnection = useCallback(
    async (connectionId: number) => {
      await apiFetch<void>(`/api/connections/${connectionId}`, { method: "DELETE" });
      setState((s) => ({ ...s, connections: s.connections.filter((c) => c.id !== connectionId) }));
      showToast("toast.connectionDeleted");
    },
    [showToast],
  );

  // Called by the Jira connect modal after its own POST succeeds — the request/response handling
  // stays in the modal (it needs the error message inline), this just lands the result in state.
  const addConnection = useCallback((connection: Connection) => {
    setState((s) => ({ ...s, connections: [...s.connections, connection] }));
  }, []);

  const runTask = useCallback(
    async (taskId: number, body?: { acknowledgeStale?: boolean }): Promise<RunTaskResult> => {
      // Bypasses apiFetch here (unlike every other call in this file) because a 409
      // `{ code: "task_stale", latest }` body needs to survive intact — apiFetch only ever
      // preserves a response body's `error` string, which this route doesn't send.
      const res = await fetch(`/api/tasks/${taskId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (data.code === "task_stale") {
          return { stale: true, latest: data.latest as ExternalIssue };
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`POST /api/tasks/${taskId}/run failed: ${res.status} ${text}`);
      }
      const result = (await res.json()) as { task: Task; session: Session; runId: number };
      setState((s) => ({
        ...s,
        tasks: s.tasks.map((tk) => (tk.id === taskId ? result.task : tk)),
        sessions: [...s.sessions, result.session],
      }));
      return { stale: false, ...result };
    },
    [],
  );

  const sendMessage = useCallback(
    async (sessionId: number, text: string) => {
      const { userMessage, session, runId } = await apiFetch<{
        userMessage: ChatMessage;
        session?: Session;
        runId: number;
      }>(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ text }) });

      setState((s) => ({
        ...s,
        sessions: session ? s.sessions.map((sess) => (sess.id === sessionId ? session : sess)) : s.sessions,
        messages: [...s.messages, userMessage],
      }));

      const revealAssistantMessage = (assistantMessage: ChatMessage) => {
        setState((s) => ({
          ...s,
          messages: [...s.messages, { ...assistantMessage, content: "", streaming: true }],
        }));

        const words = assistantMessage.content.split(" ");
        let i = 0;
        const interval = setInterval(() => {
          i += 1;
          const partial = words.slice(0, i).join(" ");
          const done = i >= words.length;
          setState((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantMessage.id ? { ...m, content: partial, streaming: !done } : m,
            ),
          }));
          if (done) clearInterval(interval);
        }, 45);
      };

      // Poll the run's own status rather than guessing from message contents — that's the
      // only way to tell "still working" apart from "failed", which never produces a message.
      const poll = () => {
        setTimeout(async () => {
          const run = await apiFetch<Run>(`/api/runs/${runId}`);
          if (run.status === "done") {
            const messages = await apiFetch<ChatMessage[]>(`/api/sessions/${sessionId}/messages`);
            const assistantMessage = messages.find((m) => m.role === "assistant" && m.id > userMessage.id);
            if (assistantMessage) revealAssistantMessage(assistantMessage);
          } else if (run.status === "failed" || run.status === "cancelled") {
            // Classified failures (e.g. an exhausted Claude API account) get a specific, safe
            // message; anything unclassified keeps the generic fallback. Best-effort — a failed
            // events fetch shouldn't block showing the user *something* went wrong.
            const errorCode = await fetchRunErrorCode(sessionId, runId);
            const content =
              errorCode === "insufficient_credit" ? t("session.replyFailedInsufficientCredit") : t("session.replyFailed");
            setState((s) => ({
              ...s,
              messages: [
                ...s.messages,
                {
                  id: -runId,
                  sessionId,
                  role: "assistant",
                  content,
                  createdAt: new Date().toISOString(),
                  error: true,
                },
              ],
            }));
          } else {
            poll();
          }
        }, 1200);
      };
      poll();
      return { runId };
    },
    [t],
  );

  if (isLoading || loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        {loadError ? t("common.loadError") : t("common.loading")}
      </div>
    );
  }

  const value: MockBackendValue = {
    ...state,
    toast,
    notify: showToast,
    getAgent,
    getTeam,
    getSession,
    getTask,
    sessionsForAgent,
    agentsForTeam,
    messagesForSession,
    loadMessages,
    createTeam,
    updateTeam,
    updateTeamSharedContext,
    assignAgentToTeam,
    createAgent,
    updateAgent,
    deleteAgent,
    createSession,
    sendMessage,
    createTask,
    updateTask,
    refreshTask,
    deleteTask,
    runTask,
    deleteConnection,
    addConnection,
  };

  return <MockBackendContext.Provider value={value}>{children}</MockBackendContext.Provider>;
}

export function useMockBackend() {
  const ctx = useContext(MockBackendContext);
  if (!ctx) throw new Error("useMockBackend must be used within MockBackendProvider");
  return ctx;
}
