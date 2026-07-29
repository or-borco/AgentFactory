import type { ChatMessage, Connection, Session, Skill } from "@agentfactory/core";
import { getAgent } from "@agentfactory/db";
import { seedConnections, seedMessages, seedSessions, seedSkills } from "@/lib/mock/seed";

// Server-only in-memory store. Never imported from a client component — only from
// app/api/**/route.ts handlers, which always run server-side. State resets on a dev-server
// restart or whenever this module is reloaded (e.g. editing this file), by design: this is
// the mock standing in for a real database, not a database itself.
//
// Teams and agents no longer live here — they're in real Postgres via @agentfactory/db
// (see repositories/teams.ts and repositories/agents.ts). Sessions, messages, skills, and
// connections stay in-memory until they get their own real backend milestone.
interface ServerState {
  sessions: Session[];
  messages: ChatMessage[];
  skills: Skill[];
  connections: Connection[];
}

const state: ServerState = {
  sessions: [...seedSessions],
  messages: [...seedMessages],
  skills: [...seedSkills],
  connections: [...seedConnections],
};

// Seed sessions/messages use small explicit ids (1, 2, ...) — start well past them so new
// mock rows never collide. This mock store resets on every dev-server restart, so a counter
// (not a real sequence) is sufficient.
let nextMockId = 1000;
function newId() {
  return nextMockId++;
}

function draftReplyFor(agentId: number | undefined, userText: string): string {
  if (agentId === 1) {
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

export const mockStore = {
  listSessions: (agentId?: number) => (agentId ? state.sessions.filter((s) => s.agentId === agentId) : state.sessions),

  createSession(agentId: number, title: string): Session {
    const now = new Date().toISOString();
    const session: Session = { id: newId(), agentId, title, origin: "web", createdAt: now, lastActivityAt: now };
    state.sessions.push(session);
    return session;
  },

  listMessages: (sessionId: number) => state.messages.filter((m) => m.sessionId === sessionId),

  async sendMessage(
    sessionId: number,
    text: string,
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage; session?: Session }> {
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: newId(), sessionId, role: "user", content: text, createdAt: now };
    state.messages.push(userMessage);

    const session = state.sessions.find((s) => s.id === sessionId);
    if (session) session.lastActivityAt = now;
    const agent = session ? await getAgent(session.agentId) : undefined;

    const assistantMessage: ChatMessage = {
      id: newId(),
      sessionId,
      role: "assistant",
      content: draftReplyFor(agent?.id, text),
      createdAt: new Date().toISOString(),
    };
    state.messages.push(assistantMessage);

    return { userMessage, assistantMessage, session };
  },

  listSkills: () => state.skills,
  listConnections: () => state.connections,
};
