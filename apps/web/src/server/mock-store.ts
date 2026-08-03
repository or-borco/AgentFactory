import type { Skill } from "@agentfactory/core";
import { seedSkills } from "@/lib/mock/seed";

// Server-only in-memory store. Never imported from a client component — only from
// app/api/**/route.ts handlers, which always run server-side. State resets on a dev-server
// restart or whenever this module is reloaded (e.g. editing this file), by design: this is
// the mock standing in for a real database, not a database itself.
//
// Teams, agents, sessions, messages, and connections no longer live here — they're in real
// Postgres via @agentfactory/db (see repositories/teams.ts, repositories/agents.ts,
// repositories/sessions.ts, repositories/messages.ts, repositories/connections.ts). Skills
// stay in-memory until they get their own real backend milestone.
interface ServerState {
  skills: Skill[];
}

const state: ServerState = {
  skills: [...seedSkills],
};

export const mockStore = {
  listSkills: () => state.skills,
};
