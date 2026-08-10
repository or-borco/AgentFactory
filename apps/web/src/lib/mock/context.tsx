"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Agent, ChatMessage, Connection, OrgMember, Run, Session, Skill, Task, Team, TeamContextItem } from "@agentfactory/core";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

type DisplayMessage = ChatMessage & { streaming?: boolean; error?: boolean };

interface MockState {
  teams: Team[];
  agents: Agent[];
  sessions: Session[];
  messages: DisplayMessage[];
  skills: Skill[];
  connections: Connection[];
  tasks: Task[];
  orgMembers: OrgMember[];
  teamContextItems: TeamContextItem[];
}

const EMPTY_STATE: MockState = { teams: [], agents: [], sessions: [], messages: [], skills: [], connections: [], tasks: [], orgMembers: [], teamContextItems: [] };

interface NewAgentInput {
  name: string;
  description: string;
  systemPrompt: string;
  mode: "manual" | "automatic";
  teamId?: number;
  /** Model catalog id (see @agentfactory/core MODEL_CATALOG). Defaults to DEFAULT_MODEL_ID. */
  model?: string;
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
}

interface MockBackendValue extends MockState {
  toast: TranslationKey | null;
  notify: (key: TranslationKey) => void;
  getAgent: (id: number) => Agent | undefined;
  getTeam: (id: number) => Team | undefined;
  getSession: (id: number) => Session | undefined;
  getTask: (id: number) => Task | undefined;
  contextItemsForTeam: (teamId: number) => TeamContextItem[];
  sessionsForAgent: (agentId: number) => Session[];
  agentsForTeam: (teamId: number) => Agent[];
  messagesForSession: (sessionId: number) => DisplayMessage[];
  loadMessages: (sessionId: number) => Promise<void>;
  createTeam: (name: string, description: string) => Promise<Team>;
  updateTeam: (teamId: number, patch: { name: string; description: string }) => Promise<void>;
  updateTeamSharedContext: (teamId: number, sharedContext: string) => Promise<void>;
  assignAgentToTeam: (agentId: number, teamId: number) => Promise<void>;
  createAgent: (input: NewAgentInput) => Promise<Agent>;
  updateAgent: (
    agentId: number,
    patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode" | "areaMap" | "defaultCodebase">> & {
      model?: string;
    },
  ) => Promise<void>;
  deleteAgent: (agentId: number) => Promise<void>;
  createSession: (agentId: number, title: string) => Promise<Session>;
  sendMessage: (sessionId: number, text: string) => Promise<{ runId: number }>;
  createTask: (input: NewTaskInput) => Promise<Task>;
  updateTask: (taskId: number, patch: Partial<Task>) => Promise<void>;
  deleteTask: (taskId: number) => Promise<void>;
  runTask: (taskId: number) => Promise<{ task: Task; session: Session; runId: number }>;
  createContextItem: (teamId: number, title: string) => Promise<TeamContextItem>;
  deleteContextItem: (teamId: number, itemId: number) => Promise<void>;
  deleteConnection: (connectionId: number) => Promise<void>;
}

const MockBackendContext = createContext<MockBackendValue | null>(null);

export function MockBackendProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<MockState>(EMPTY_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [toast, setToast] = useState<TranslationKey | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<Team[]>("/api/teams"),
      apiFetch<Agent[]>("/api/agents"),
      apiFetch<Session[]>("/api/sessions"),
      apiFetch<Skill[]>("/api/skills"),
      apiFetch<Connection[]>("/api/connections"),
      apiFetch<Task[]>("/api/tasks"),
      apiFetch<OrgMember[]>("/api/teams/members"),
    ])
      .then(async ([teams, agents, sessions, skills, connections, tasks, orgMembers]) => {
        if (cancelled) return;
        const contextArrays = await Promise.all(
          teams.map((t) => apiFetch<TeamContextItem[]>(`/api/teams/${t.id}/context-items`)),
        );
        if (cancelled) return;
        setState({ teams, agents, sessions, messages: [], skills, connections, tasks, orgMembers, teamContextItems: contextArrays.flat() });
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

  const showToast = useCallback((key: TranslationKey) => {
    setToast(key);
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
  const contextItemsForTeam = useCallback(
    (teamId: number) => state.teamContextItems.filter((i) => i.teamId === teamId),
    [state.teamContextItems],
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
    async (name: string, description: string) => {
      const team = await apiFetch<Team>("/api/teams", { method: "POST", body: JSON.stringify({ name, description }) });
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

  const createContextItem = useCallback(async (teamId: number, title: string) => {
    const item = await apiFetch<TeamContextItem>(`/api/teams/${teamId}/context-items`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    setState((s) => ({ ...s, teamContextItems: [...s.teamContextItems, item] }));
    return item;
  }, []);

  const deleteContextItem = useCallback(async (teamId: number, itemId: number) => {
    await apiFetch<void>(`/api/teams/${teamId}/context-items/${itemId}`, { method: "DELETE" });
    setState((s) => ({ ...s, teamContextItems: s.teamContextItems.filter((i) => i.id !== itemId) }));
  }, []);

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

  const runTask = useCallback(
    async (taskId: number) => {
      const result = await apiFetch<{ task: Task; session: Session; runId: number }>(
        `/api/tasks/${taskId}/run`,
        { method: "POST" },
      );
      setState((s) => ({
        ...s,
        tasks: s.tasks.map((tk) => (tk.id === taskId ? result.task : tk)),
        sessions: [...s.sessions, result.session],
      }));
      return result;
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
            setState((s) => ({
              ...s,
              messages: [
                ...s.messages,
                {
                  id: -runId,
                  sessionId,
                  role: "assistant",
                  content: t("session.replyFailed"),
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
    contextItemsForTeam,
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
    deleteTask,
    runTask,
    createContextItem,
    deleteContextItem,
    deleteConnection,
  };

  return <MockBackendContext.Provider value={value}>{children}</MockBackendContext.Provider>;
}

export function useMockBackend() {
  const ctx = useContext(MockBackendContext);
  if (!ctx) throw new Error("useMockBackend must be used within MockBackendProvider");
  return ctx;
}
