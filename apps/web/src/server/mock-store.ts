import type { Agent, ChatMessage, Connection, Session, Skill, Team, ToolPolicy } from "@agentfactory/core";
import { ORG_ID, seedAgents, seedConnections, seedMessages, seedSessions, seedSkills, seedTeams } from "@/lib/mock/seed";

// Server-only in-memory store. Never imported from a client component — only from
// app/api/**/route.ts handlers, which always run server-side. State resets on a dev-server
// restart or whenever this module is reloaded (e.g. editing this file), by design: this is
// the mock standing in for a real database, not a database itself.
interface ServerState {
  teams: Team[];
  agents: Agent[];
  sessions: Session[];
  messages: ChatMessage[];
  skills: Skill[];
  connections: Connection[];
}

const state: ServerState = {
  teams: [...seedTeams],
  agents: [...seedAgents],
  sessions: [...seedSessions],
  messages: [...seedMessages],
  skills: [...seedSkills],
  connections: [...seedConnections],
};

const SHARED_CONTEXT_MAX_BYTES = 64 * 1024;

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

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

const DEFAULT_TOOL_POLICY: ToolPolicy = { defaultDecision: "deny", rules: [] };

export const mockStore = {
  listTeams: () => state.teams,

  createTeam(name: string, description: string): Team {
    const team: Team = {
      id: newId("team"),
      orgId: ORG_ID,
      name,
      description: description || undefined,
      sharedContext: "",
      createdAt: new Date().toISOString(),
    };
    state.teams.push(team);
    return team;
  },

  updateTeam(teamId: string, patch: { name?: string; description?: string; sharedContext?: string }): Team | undefined {
    const team = state.teams.find((t) => t.id === teamId);
    if (!team) return undefined;
    if (patch.name !== undefined) team.name = patch.name;
    if (patch.description !== undefined) team.description = patch.description || undefined;
    if (patch.sharedContext !== undefined) {
      team.sharedContext =
        new TextEncoder().encode(patch.sharedContext).length > SHARED_CONTEXT_MAX_BYTES
          ? patch.sharedContext.slice(0, SHARED_CONTEXT_MAX_BYTES)
          : patch.sharedContext;
    }
    return team;
  },

  listAgents: () => state.agents,

  createAgent(input: { name: string; description: string; systemPrompt: string; mode: Agent["mode"]; teamId?: string }): Agent {
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
    state.agents.push(agent);
    return agent;
  },

  updateAgent(
    agentId: string,
    patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode" | "teamId">>,
  ): Agent | undefined {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) return undefined;
    Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
    return agent;
  },

  listSessions: (agentId?: string) => (agentId ? state.sessions.filter((s) => s.agentId === agentId) : state.sessions),

  createSession(agentId: string, title: string): Session {
    const now = new Date().toISOString();
    const session: Session = { id: newId("session"), agentId, title, origin: "web", createdAt: now, lastActivityAt: now };
    state.sessions.push(session);
    return session;
  },

  listMessages: (sessionId: string) => state.messages.filter((m) => m.sessionId === sessionId),

  sendMessage(sessionId: string, text: string): { userMessage: ChatMessage; assistantMessage: ChatMessage; session?: Session } {
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: newId("msg"), sessionId, role: "user", content: text, createdAt: now };
    state.messages.push(userMessage);

    const session = state.sessions.find((s) => s.id === sessionId);
    if (session) session.lastActivityAt = now;
    const agent = session ? state.agents.find((a) => a.id === session.agentId) : undefined;

    const assistantMessage: ChatMessage = {
      id: newId("msg"),
      sessionId,
      role: "assistant",
      content: draftReplyFor(agent, text),
      createdAt: new Date().toISOString(),
    };
    state.messages.push(assistantMessage);

    return { userMessage, assistantMessage, session };
  },

  listSkills: () => state.skills,
  listConnections: () => state.connections,
};
