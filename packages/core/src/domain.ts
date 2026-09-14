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
  defaultCodebase?: string;
  createdAt: ISODateTime;
}

// pending → indexing → indexed | failed. `pending` is where every upload starts and, until the
// ingest worker lands, where it stays.
export type ContextItemStatus = "pending" | "indexing" | "indexed" | "failed";

// One uploaded document. `sha256` + `orgId` address the bytes in content_blobs (blobs are
// partitioned per org, never shared across tenants), and `source` is always "upload" today —
// it exists so Drive/Notion/URL adapters are a value, not a schema change.
export interface TeamContextItem {
  id: ID;
  teamId: ID;
  orgId: ID;
  title: string;
  sizeBytes: number;
  sha256: string;
  mime: string;
  source: string;
  status: ContextItemStatus;
  // Machine-or-human failure text from ingestion; only set when status is "failed".
  error?: string;
  indexedAt?: ISODateTime;
  uploadedBy?: ID;
  createdAt: ISODateTime;
}

// Disambiguates which items table a run_context_retrievals row's itemId points into. The two
// items tables (team_context_items, task_context_items) are independent identity sequences that
// can collide on the same numeric id, so this tag — not the id alone — is what a reader must use
// to know which table (and which delete path) an id belongs to.
export type ContextItemKind = "team" | "task";

// One uploaded document scoped to a task rather than a team. Mirrors TeamContextItem exactly —
// same addressing scheme, same status machine — but keyed by taskId instead of teamId.
export interface TaskContextItem {
  id: ID;
  taskId: ID;
  orgId: ID;
  title: string;
  sizeBytes: number;
  sha256: string;
  mime: string;
  source: string;
  status: ContextItemStatus;
  // Machine-or-human failure text from ingestion; only set when status is "failed".
  error?: string;
  indexedAt?: ISODateTime;
  uploadedBy?: ID;
  createdAt: ISODateTime;
}

export interface OrgMember {
  userId: ID;
  orgId: ID;
  email: string;
  name: string;
  role: Role;
  joinedAt: ISODateTime;
}

export type AgentMode = "manual" | "automatic";
export type RuntimeKind = "claude-code";

export interface ModelSpec {
  family: "anthropic";
  id: string; // e.g. "claude-sonnet-5"
  maxTokens: number;
  thinking?: boolean;
}

export type OverflowPolicy = "fallback" | "fail_fast";

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
  connectionIds: ID[];
  onContextOverflow: OverflowPolicy;
  // Intentionally unwired for alpha (issue #65): no editing UI and nothing reads this yet.
  areaMap?: Record<string, string>;
  defaultCodebase?: string;
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

export type ConnectionAuthKind = "none" | "api_token" | "oauth2";

export interface Connection {
  id: ID;
  orgId: ID;
  provider: ConnectionProvider;
  kind: ConnectionKind;
  label: string;
  health: ConnectionHealth;
  config: Record<string, unknown>;
  auth: ConnectionAuthKind;
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
  currentVersionId?: ID;
  // Groups a set of related, typically system-seeded skills (e.g. "superpowers") so they can be
  // displayed together. Not exposed on org-authored skills yet — left unset there.
  family?: string;
  createdAt: ISODateTime;
}

export interface SkillVersion {
  id: ID;
  skillId: ID;
  version: number;
  name: string;
  description: string;
  bodySha256: string;
  createdBy?: ID;
  // Absent means this is the unpublished draft — at most one per skill.
  publishedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export interface AgentSkill {
  agentId: ID;
  skillId: ID;
  skillVersionId: ID;
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

// ── Tasks ──────────────────────────────────────────────────────────────────────
export type TaskStatus =
  | "open"
  | "assigned"
  | "in_progress"
  | "needs_input"
  | "pr_open"
  | "review_cycle"
  | "done"
  | "failed"
  | "cancelled";

export interface AcceptanceCriterion {
  text: string;
  done: boolean;
}

/** A task's link to the upstream issue it mirrors. AgentFactory remains the system of record. */
export interface TaskExternalRef {
  provider: ConnectionProvider;
  /** Provider-native identifier, e.g. a Jira issue key "PROJ-123". */
  key: string;
  /** Browse URL, stored so the UI can link out without reconstructing it per provider. */
  url: string;
  /** The provider's own last-modified timestamp as of the last fetch, for a future staleness check. */
  lastKnownUpdated: string;
  /** Set when the most recent write-back attempt (worker/task-notify.ts) failed; cleared on the next success. */
  writeBackFailure?: { message: string; occurredAt: ISODateTime };
}

export interface Task {
  id: ID;
  orgId: ID;
  /** Display reference e.g. "T-042". Generated as "T-" + id after insert. */
  ref: string;
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  status: TaskStatus;
  assigneeAgentId?: ID;
  /** The owned session (0..1) — null until a session is started. */
  sessionId?: ID;
  /** Per-task override of the assignee agent's default model. Unset means "use the agent's model". */
  model?: ModelSpec;
  area?: string | null;
  codebase?: string | null;
  prNumber?: number;
  prUrl?: string;
  externalRef?: TaskExternalRef;
  createdBy: ID;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── Sessions ────────────────────────────────────────────────────────────────────
export type SessionOrigin = "web" | "slack" | "github" | "jira" | "cron";

export interface Session {
  id: ID;
  agentId: ID;
  title: string;
  origin: SessionOrigin;
  externalThreadRef?: string;
  // The warm sandbox container for this session's runs (ARCHITECTURE.md §4: "one sandbox per
  // active session, kept warm"), reused across runs rather than recreated per turn — the SDK's
  // own multi-turn `resume` state lives on the container's filesystem, not server-side.
  sandboxId?: string;
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

// Exactly what one run added to the session's branch: `baseSha` is where the branch stood
// before this run pushed, `headSha` where it stood after. Recorded at push time because
// nothing else can reconstruct it later — a session's branch accumulates every run's work,
// so the branch tip alone cannot say which commits belong to which run.
export interface RunCommitRange {
  baseSha: string;
  headSha: string;
}

export interface Run {
  id: ID;
  sessionId: ID;
  status: RunStatus;
  triggeringMessageId?: ID;
  providerSessionRef?: string;
  // The session's sandboxId at the moment providerSessionRef was recorded — see the schema
  // column's own comment (packages/db/src/schema.ts) for why this, not a per-run before/after
  // snapshot, is the correct way to know whether a later run may still resume this ref.
  sandboxId?: string;
  promptHash?: string;
  costUsd: number;
  tokensUsed: number;
  budgetExceeded?: boolean;
  workspaceSnapshot?: Record<string, string>;
  // Set only when this run actually pushed commits. Absent means either "this run committed
  // nothing" or "this run predates the field" — `workspaceSnapshot` distinguishes the two.
  commitRange?: RunCommitRange;
  model?: ModelSpec;
  createdAt: ISODateTime;
  finishedAt?: ISODateTime;
}

// ── Run prompt record ───────────────────────────────────────────────────────────
// Why a given prompt layer contributed nothing to this run. Machine-readable; the
// web app maps codes to i18n strings and renders unknown codes as a generic
// "not included" — adding a code is never a breaking change.
export type PromptOmissionReason =
  | "no_team"
  | "empty_shared_context"
  | "no_codebase"
  | "repo_map_pending"
  // Retrieved context: neither the team nor the task has a document that finished indexing;
  // nothing cleared the similarity floor (team side) or fit the reserved budget (task side); or
  // retrieval itself threw. Adding codes is non-breaking — RunContextPanel.tsx renders an
  // unknown reason with its generic "not included" label.
  | "no_indexed_documents"
  | "no_relevant_chunks"
  | "retrieval_failed"
  // Retrieved context only: neither a team nor a task resolved for this run, so retrieval never
  // ran at all — distinct from no_team (still used by the team_context/Layer-1 segment, where
  // "no team" alone is a complete and accurate reason).
  | "no_context_sources"
  // Prior-conversation segment only: the run's own sandboxId matched the sandbox recorded
  // alongside the ref it's resuming, so resume was used normally and this segment doesn't apply.
  | "resume_valid"
  // Prior-conversation segment only: resume wasn't valid, but this is the session's first-ever
  // run (or no run has ever recorded a ref), so there's no message history yet to reconstruct.
  | "no_prior_conversation";

// One layer of a run's composed system prompt. Invariant (tested in
// prompt-composition.test.ts): joining segment texts in order reproduces the
// exact string the model received. `id` is a stable layer id
// ("platform_preamble" | "environment" | "team_context" | "repo_map" |
// "agent_system_prompt" today) typed as string so old clients render future
// layers without a core bump.
export interface PromptSegment {
  id: string;
  text: string;
  omittedReason?: PromptOmissionReason;
}

// The stored prompt record for one run — served by GET /api/runs/[runId]/prompt.
// Deliberately NOT part of Run: the task page polls run status on a timer, and
// this payload is up to ~80 KB.
export interface RunPrompt {
  runId: ID;
  segments: PromptSegment[];
  // Optional because the column is independently nullable: nothing in the schema
  // forces prompt_hash and prompt_segments to be written together, so the type
  // admits the state the database can actually hold rather than fabricating "".
  promptHash?: string;
}

// ── Run evals ────────────────────────────────────────────────────────────────
// One row per judge invocation — a run can be evaluated more than once, so this
// is its own entity, never a column on Run (the task page polls Run on a timer;
// see the workspaceSnapshot over-fetch lesson).

export type EvalStatus = "queued" | "running" | "done" | "failed";
// "overridden": the instruction genuinely did not govern this run, because the user's own
// request contradicted it. Distinct from "pass" (which claims compliance) and from "fail"
// (which blames the agent for obeying the person operating it) — and, like "unclear", it
// does not score. See 2026-08-27-eval-request-aware-judging-design.md.
export type EvalVerdict = "pass" | "fail" | "unclear" | "overridden";
// What the judge graded: the branch's diff when the run committed, otherwise the
// run's final assistant message. Stored so no score is ambiguous about its input.
export type EvalArtefactKind = "diff" | "final_message";

export interface EvalRequirement {
  text: string;
  verdict: EvalVerdict;
  // A quoted line from the artefact (or a brief statement of what is absent).
  evidence: string;
}

export interface EvalLayerResult {
  // PromptSegment id — "team_context" | "agent_system_prompt" in practice.
  segmentId: string;
  requirements: EvalRequirement[];
}

// One retrieved excerpt, judged for relevance to the request — NOT for compliance. This is a
// separate question from the per-layer verdicts above and never joins HUMAN_SEGMENT_IDS: an
// excerpt is reference material, and its text is fully user-controllable (anyone who can upload
// a document can write it), so it must never become an instruction the agent is scored against.
export interface EvalRetrievalChunk {
  // Snapshot, matching run_context_retrievals.item_title — the document may since be deleted.
  itemTitle: string;
  chunkIdx: number;
  relevant: boolean;
  // One short sentence saying why, in the judge's words.
  reason: string;
}

export interface EvalRetrievalResult {
  chunks: EvalRetrievalChunk[];
  // relevant / total, 0..1. Zero when nothing retrieved was relevant; the field is absent
  // entirely (not zero) when the run had no retrieved layer to grade.
  precision: number;
}

export interface RunEvalResult {
  artefactKind: EvalArtefactKind;
  layers: EvalLayerResult[];
  // passed / decided requirements, 0..1; "unclear" and "overridden" verdicts are excluded
  // from both sides, and the score is 0 when nothing was decided.
  score: number;
  // True when the artefact exceeded the judge's size cap and was cut before grading. Optional
  // so rows stored before this field existed keep parsing as undefined (falsy); a truncated
  // grading must never render identically to a complete one on the card.
  truncated?: boolean;
  // Absent when the run had no retrieved_context layer — which is every run stored before this
  // field existed, and every run for a team with no indexed documents. Distinct from a present
  // result with precision 0, which means excerpts were injected and none of them were relevant.
  retrieval?: EvalRetrievalResult;
}

export interface RunEval {
  id: ID;
  orgId: ID;
  runId: ID;
  status: EvalStatus;
  result?: RunEvalResult;
  // Which model graded — scores from different judges are not comparable.
  judgeModelId?: string;
  // Machine-readable failure reason code; only set when status is "failed".
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// One retrieved chunk that was injected into one run's prompt. Its own entity, never a field on
// Run: RUN_COLUMNS exists precisely to keep large per-run payloads off the task page's 1.5s
// poll, so this is served by a lazy route on tab open (mirrors RunEval).
export interface RunContextRetrieval {
  id: ID;
  runId: ID;
  // Absent once the source document is deleted — itemTitle below is the snapshot that keeps a
  // historical run's provenance readable after the document is gone.
  itemId?: ID;
  // Which items table itemId pointed into. Defaults to "team" for rows written before task
  // documents existed — accurate, since every such row predates this field.
  itemKind: ContextItemKind;
  itemTitle: string;
  chunkIdx: number;
  // 1-based position in the retrieval result, after the floor and byte budget were applied.
  rank: number;
  // Cosine similarity in [-1, 1]; higher is closer.
  score: number;
  createdAt: ISODateTime;
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
