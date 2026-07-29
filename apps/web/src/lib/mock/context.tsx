"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Agent, ChatMessage, Connection, Session, Skill, Team } from "@agentfactory/core";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

type DisplayMessage = ChatMessage & { streaming?: boolean };

interface MockState {
  teams: Team[];
  agents: Agent[];
  sessions: Session[];
  messages: DisplayMessage[];
  skills: Skill[];
  connections: Connection[];
}

const EMPTY_STATE: MockState = { teams: [], agents: [], sessions: [], messages: [], skills: [], connections: [] };

interface NewAgentInput {
  name: string;
  description: string;
  systemPrompt: string;
  mode: "manual" | "automatic";
  teamId?: number;
}

interface MockBackendValue extends MockState {
  toast: TranslationKey | null;
  notify: (key: TranslationKey) => void;
  getAgent: (id: number) => Agent | undefined;
  getTeam: (id: number) => Team | undefined;
  getSession: (id: number) => Session | undefined;
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
    patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode">>,
  ) => Promise<void>;
  createSession: (agentId: number, title: string) => Promise<Session>;
  sendMessage: (sessionId: number, text: string) => Promise<void>;
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
    ])
      .then(([teams, agents, sessions, skills, connections]) => {
        if (cancelled) return;
        setState({ teams, agents, sessions, messages: [], skills, connections });
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
    async (agentId: number, patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode">>) => {
      const agent = await apiFetch<Agent>(`/api/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(patch) });
      setState((s) => ({ ...s, agents: s.agents.map((a) => (a.id === agentId ? agent : a)) }));
      showToast("toast.agentUpdated");
    },
    [showToast],
  );

  const createSession = useCallback(async (agentId: number, title: string) => {
    const session = await apiFetch<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ agentId, title }) });
    setState((s) => ({ ...s, sessions: [...s.sessions, session] }));
    return session;
  }, []);

  const sendMessage = useCallback(async (sessionId: number, text: string) => {
    const { userMessage, assistantMessage, session } = await apiFetch<{
      userMessage: ChatMessage;
      assistantMessage: ChatMessage;
      session?: Session;
    }>(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ text }) });

    setState((s) => ({
      ...s,
      sessions: session ? s.sessions.map((sess) => (sess.id === sessionId ? session : sess)) : s.sessions,
      messages: [...s.messages, userMessage, { ...assistantMessage, content: "", streaming: true }],
    }));

    const words = assistantMessage.content.split(" ");
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      const partial = words.slice(0, i).join(" ");
      const done = i >= words.length;
      setState((s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === assistantMessage.id ? { ...m, content: partial, streaming: !done } : m)),
      }));
      if (done) clearInterval(interval);
    }, 45);
  }, []);

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
    createSession,
    sendMessage,
  };

  return <MockBackendContext.Provider value={value}>{children}</MockBackendContext.Provider>;
}

export function useMockBackend() {
  const ctx = useContext(MockBackendContext);
  if (!ctx) throw new Error("useMockBackend must be used within MockBackendProvider");
  return ctx;
}
