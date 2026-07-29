export type ID = number;
export type ISODateTime = string;

export type Role = "owner" | "admin" | "member";

export interface Org {
  id: ID;
  name: string;
  slug: string;
  createdAt: ISODateTime;
}

export interface User {
  id: ID;
  email: string;
  name: string;
  avatarUrl?: string;
}

export interface Membership {
  orgId: ID;
  userId: ID;
  role: Role;
}

export interface Team {
  id: ID;
  orgId: ID;
  name: string;
  description?: string;
  sharedContext: string; // capped at 64KB, see ARCHITECTURE.md §2.3
  githubTeamSlug?: string;
  createdAt: ISODateTime;
}

export interface TeamContextItem {
  id: ID;
  teamId: ID;
  title: string;
  source: "upload" | "gdrive" | "notion" | "url";
  mime: string;
  sizeBytes: number;
  uploadedBy: ID;
  status: "pending" | "indexing" | "indexed" | "failed";
  createdAt: ISODateTime;
}

export type AgentMode = "manual" | "automatic";
export type RuntimeKind = "claude-code";

export interface ModelSpec {
  family: "anthropic";
  id: string; // e.g. "claude-sonnet-5"
  maxTokens: number;
  thinking?: boolean;
}

export type ToolDecision = "allow" | "deny";

export interface ToolPolicy {
  defaultDecision: ToolDecision; // deny-by-default, see ARCHITECTURE.md §6
  rules: Array<{ tool: string; decision: ToolDecision }>;
}

export interface Agent {
  id: ID;
  orgId: ID;
  teamId?: ID;
  name: string;
  description?: string;
  avatarEmoji?: string;
  systemPrompt: string;
  model: ModelSpec;
  mode: AgentMode;
  runtimeKind: RuntimeKind;
  toolPolicy: ToolPolicy;
  skillIds: ID[];
  connectionIds: ID[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ConnectionKind = "scm" | "channel" | "tasks";
export type ConnectionProvider =
  | "github"
  | "bitbucket"
  | "slack"
  | "telegram"
  | "discord"
  | "whatsapp"
  | "jira"
  | "monday"
  | "asana"
  | "google-sheets";

export type ConnectionHealth = "healthy" | "needs-attention" | "expired";

export interface Connection {
  id: ID;
  orgId: ID;
  provider: ConnectionProvider;
  kind: ConnectionKind;
  label: string;
  health: ConnectionHealth;
  config: Record<string, unknown>;
  createdAt: ISODateTime;
}

export type SkillSource = "authored" | "git";

export interface Skill {
  id: ID;
  orgId: ID;
  name: string;
  slug: string;
  description: string;
  source: SkillSource;
  currentVersionId: ID;
  createdAt: ISODateTime;
}

export interface SkillVersion {
  id: ID;
  skillId: ID;
  version: number;
  bundleSha: string;
  createdBy: ID;
  gitCommitSha?: string;
  createdAt: ISODateTime;
}

export type TriggerSource = "github" | "slack" | "jira" | "monday" | "cron";

export interface Trigger {
  id: ID;
  agentId: ID;
  source: TriggerSource;
  eventType: string;
  filter: Record<string, unknown>;
  enabled: boolean;
}

export type SessionOrigin = "web" | "slack" | "github" | "jira" | "cron";

export interface Session {
  id: ID;
  agentId: ID;
  title: string;
  origin: SessionOrigin;
  externalThreadRef?: string;
  createdAt: ISODateTime;
  lastActivityAt: ISODateTime;
}

export type RunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

export interface Run {
  id: ID;
  sessionId: ID;
  status: RunStatus;
  triggeringMessageId?: ID;
  promptHash?: string;
  costUsd: number;
  tokensUsed: number;
  budgetExceeded?: boolean;
  createdAt: ISODateTime;
  finishedAt?: ISODateTime;
}

export interface Artifact {
  id: ID;
  runId: ID;
  type: "pr" | "diff" | "file" | "report";
  label: string;
  url?: string;
}

export interface PolicyDecision {
  id: ID;
  runId: ID;
  tool: string;
  decision: ToolDecision;
  ruleMatched: string;
  createdAt: ISODateTime;
}

export interface ChatMessage {
  id: ID;
  sessionId: ID;
  role: "user" | "assistant";
  content: string;
  runId?: ID;
  createdAt: ISODateTime;
}
