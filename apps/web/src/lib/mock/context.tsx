"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Agent, Connection, Session, Skill, Team, ToolPolicy } from "@agentfactory/core";
import type { TranslationKey } from "@/lib/i18n/paths";
import {
  ORG_ID,
  seedAgents,
  seedConnections,
  seedMessages,
  seedSessions,
  seedSkills,
  seedTeams,
} from "./seed";
import type { ChatMessage } from "./types";

interface MockState {
  teams: Team[];
  agents: Agent[];
  sessions: Session[];
  messages: ChatMessage[];
  skills: Skill[];
  connections: Connection[];
}

const STORAGE_KEY = "agentfactory:mock-state:v1";

function initialState(): MockState {
  return {
    teams: seedTeams,
    agents: seedAgents,
    sessions: seedSessions,
    messages: seedMessages,
    skills: seedSkills,
    connections: seedConnections,
  };
}

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

interface NewAgentInput {
  name: string;
  description: string;
  systemPrompt: string;
  mode: "manual" | "automatic";
  teamId?: string;
}

interface MockBackendValue extends MockState {
  toast: TranslationKey | null;
  notify: (key: TranslationKey) => void;
  getAgent: (id: string) => Agent | undefined;
  getTeam: (id: string) => Team | undefined;
  getSession: (id: string) => Session | undefined;
  sessionsForAgent: (agentId: string) => Session[];
  agentsForTeam: (teamId: string) => Agent[];
  messagesForSession: (sessionId: string) => ChatMessage[];
  createTeam: (name: string, description: string) => Team;
  updateTeam: (teamId: string, patch: { name: string; description: string }) => void;
  updateTeamSharedContext: (teamId: string, sharedContext: string) => void;
  assignAgentToTeam: (agentId: string, teamId: string) => void;
  createAgent: (input: NewAgentInput) => Agent;
  updateAgent: (
    agentId: string,
    patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode">>,
  ) => void;
  createSession: (agentId: string, title?: string) => Session;
  sendMessage: (sessionId: string, text: string) => void;
}

const MockBackendContext = createContext<MockBackendValue | null>(null);

const SHARED_CONTEXT_MAX_BYTES = 64 * 1024;

const DEFAULT_TOOL_POLICY: ToolPolicy = { defaultDecision: "deny", rules: [] };

function draftReplyFor(agent: Agent | undefined, userText: string): string {
  if (agent?.id === "agent_code_reviewer") {
    return (
      "Looking at this now. Based on the diff: the changed files pass lint, but I'd flag the new error path in " +
      "the handler — it swallows the original exception instead of wrapping it, which will make this hard to " +
      "debug in production. I'll leave an inline comment on that line and a couple of minor naming suggestions. " +
      "Nothing here blocks merging once that's addressed."
    );
  }
  return (
    `Got it — "${userText.slice(0, 80)}${userText.length > 80 ? "…" : ""}" ` +
    "This is a simulated reply from the mocked backend; wire this session up to a real AgentRuntime to get " +
    "actual model output here."
  );
}

export function MockBackendProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MockState>(initialState);
  const [toast, setToast] = useState<TranslationKey | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      // One-time import from an external store on mount, not a reaction to React state — the
      // seed-equal server render already committed, so this can't cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setState(JSON.parse(raw) as MockState);
    } catch {
      // corrupt or inaccessible storage — keep seed state
    }
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage full or unavailable — state stays in-memory for this tab
    }
  }, [state]);

  const showToast = useCallback((key: TranslationKey) => {
    setToast(key);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const getAgent = useCallback((id: string) => state.agents.find((a) => a.id === id), [state.agents]);
  const getTeam = useCallback((id: string) => state.teams.find((t) => t.id === id), [state.teams]);
  const getSession = useCallback((id: string) => state.sessions.find((s) => s.id === id), [state.sessions]);
  const sessionsForAgent = useCallback(
    (agentId: string) =>
      state.sessions
        .filter((s) => s.agentId === agentId)
        .sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt)),
    [state.sessions],
  );
  const agentsForTeam = useCallback(
    (teamId: string) => state.agents.filter((a) => a.teamId === teamId),
    [state.agents],
  );
  const messagesForSession = useCallback(
    (sessionId: string) => state.messages.filter((m) => m.sessionId === sessionId),
    [state.messages],
  );

  const createTeam = useCallback(
    (name: string, description: string) => {
      const team: Team = {
        id: newId("team"),
        orgId: ORG_ID,
        name,
        description: description || undefined,
        sharedContext: "",
        createdAt: new Date().toISOString(),
      };
      setState((s) => ({ ...s, teams: [...s.teams, team] }));
      showToast("toast.teamCreated");
      return team;
    },
    [showToast],
  );

  const updateTeam = useCallback(
    (teamId: string, patch: { name: string; description: string }) => {
      setState((s) => ({
        ...s,
        teams: s.teams.map((t) =>
          t.id === teamId ? { ...t, name: patch.name, description: patch.description || undefined } : t,
        ),
      }));
      showToast("toast.teamUpdated");
    },
    [showToast],
  );

  const updateTeamSharedContext = useCallback(
    (teamId: string, sharedContext: string) => {
      const capped =
        new TextEncoder().encode(sharedContext).length > SHARED_CONTEXT_MAX_BYTES
          ? sharedContext.slice(0, SHARED_CONTEXT_MAX_BYTES)
          : sharedContext;
      setState((s) => ({
        ...s,
        teams: s.teams.map((t) => (t.id === teamId ? { ...t, sharedContext: capped } : t)),
      }));
      showToast("toast.sharedContextSaved");
    },
    [showToast],
  );

  const assignAgentToTeam = useCallback((agentId: string, teamId: string) => {
    setState((s) => ({
      ...s,
      agents: s.agents.map((a) => (a.id === agentId ? { ...a, teamId } : a)),
    }));
  }, []);

  const createAgent = useCallback(
    (input: NewAgentInput) => {
      const now = new Date().toISOString();
      const agent: Agent = {
        id: newId("agent"),
        orgId: ORG_ID,
        teamId: input.teamId,
        name: input.name,
        description: input.description || undefined,
        avatarEmoji: "🤖",
        systemPrompt: input.systemPrompt,
        model: { family: "anthropic", id: "claude-sonnet-5", maxTokens: 8192 },
        mode: input.mode,
        runtimeKind: "claude-code",
        toolPolicy: DEFAULT_TOOL_POLICY,
        skillIds: [],
        connectionIds: [],
        createdAt: now,
        updatedAt: now,
      };
      setState((s) => ({ ...s, agents: [...s.agents, agent] }));
      showToast("toast.agentCreated");
      return agent;
    },
    [showToast],
  );

  const updateAgent = useCallback(
    (agentId: string, patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode">>) => {
      setState((s) => ({
        ...s,
        agents: s.agents.map((a) =>
          a.id === agentId ? { ...a, ...patch, updatedAt: new Date().toISOString() } : a,
        ),
      }));
      showToast("toast.agentUpdated");
    },
    [showToast],
  );

  const createSession = useCallback((agentId: string, title = "New conversation") => {
    const now = new Date().toISOString();
    const session: Session = {
      id: newId("session"),
      agentId,
      title,
      origin: "web",
      createdAt: now,
      lastActivityAt: now,
    };
    setState((s) => ({ ...s, sessions: [...s.sessions, session] }));
    return session;
  }, []);

  const sendMessage = useCallback(
    (sessionId: string, text: string) => {
      const now = new Date().toISOString();
      const userMsg: ChatMessage = {
        id: newId("msg"),
        sessionId,
        role: "user",
        content: text,
        createdAt: now,
      };
      setState((s) => ({
        ...s,
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, lastActivityAt: now } : sess,
        ),
        messages: [...s.messages, userMsg],
      }));

      const session = state.sessions.find((s) => s.id === sessionId);
      const agent = session ? state.agents.find((a) => a.id === session.agentId) : undefined;
      const fullReply = draftReplyFor(agent, text);
      const words = fullReply.split(" ");
      const assistantId = newId("msg");

      setState((s) => ({
        ...s,
        messages: [
          ...s.messages,
          { id: assistantId, sessionId, role: "assistant", content: "", streaming: true, createdAt: new Date().toISOString() },
        ],
      }));

      let i = 0;
      const interval = setInterval(() => {
        i += 1;
        const partial = words.slice(0, i).join(" ");
        const done = i >= words.length;
        setState((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantId ? { ...m, content: partial, streaming: !done } : m,
          ),
        }));
        if (done) clearInterval(interval);
      }, 45);
    },
    [state.sessions, state.agents],
  );

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

export const SHARED_CONTEXT_MAX_BYTES_EXPORT = SHARED_CONTEXT_MAX_BYTES;
