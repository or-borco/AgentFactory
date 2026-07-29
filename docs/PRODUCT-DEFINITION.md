# AgentFactory — Product Definition

> A shared workspace where agents and humans are both first-class team members, assigned tasks from the same board.

**Status:** Alpha planning — July 2026

---

## 1. Core thesis

Today, every engineer on a team creates their own AI coding agents with their own prompts, context, and configuration. This produces inconsistent, non-standardized output. AgentFactory lets the team own the agent — same standards, same context, same quality — and makes agents first-class team members who can be assigned tasks.

The product is not a chat assistant. It's a task board where agents and humans work side by side. The session is a persistent, shareable work record — not a conversation — enabling business continuity across team members.

---

## 2. The problem

### What's happening today

- Each team member configures their own AI coding setup (Cursor, Claude, Copilot) with different system prompts, different context, different standards
- AI-generated code is inconsistent across the team — different naming conventions, different patterns, different architectural decisions
- No visibility into what AI is producing for the team. Code review catches inconsistencies after the fact
- Non-engineers can't participate because there's no shared, standardized agent to use

### Why it matters now

Teams are adopting AI coding tools faster than their processes can absorb them. The gap between "everyone uses AI" and "everyone uses AI the same way" is growing. The team that doesn't standardize their AI tooling gets fragmented output and unpredictable quality.

---

## 3. Alpha user

**Small-to-mid engineering team (5–20 engineers).** Already using Claude or Cursor daily. Not skeptical of AI — fully bought in. Has a tech lead who cares about code standards and has noticed that AI output varies wildly across the team. Wants every engineer (and eventually non-engineers) working through the same agent with the same team context.

> "We all use Claude, but everyone's got their own setup. I review PRs where one person's AI writes Go-style TypeScript and another's writes Java-style TypeScript. I want one agent that knows our standards."

---

## 4. Product model

### Core loop

The product is built around a single loop:

1. **Human writes a task** — describes what needs to be done, with acceptance criteria
2. **Human assigns it to an agent** — assignment = start, always
3. **Agent evaluates** — reads the task and codebase. If the task is too large, the agent flags it as "needs input" and the human breaks it down manually
4. **Agent works** — codes the task in a sandbox
5. **Human reviews** — in GitHub (PR review) or in the session (feedback)
6. **Repeat until done** — the agent iterates on feedback within the same session

### Key concepts

**Tasks** — The primary object. Tasks live in AgentFactory, not in Jira. Each task has a status, an assignee (agent or human), and a linked session. In alpha, if a task is too large the agent flags it and the human creates smaller tasks manually. Post-alpha, the agent will propose subtasks directly (max two levels, with aggregate progress on the parent).

**Sessions** — The persistent work record. Created automatically when an agent is assigned to a task. Contains the agent's plan, work log, code output, and any human feedback. Any team member can open the session and continue interacting — enabling handoff without context loss.

**Agents** — Configured once by a tech lead, used by the whole team. Carry the team's system prompt, coding standards, model choice, tool policy, skills, and a default codebase (the repo the agent works in). The default codebase means the person assigning a task doesn't need to know which repo to target. Optionally, agents can have a feature/area mapping (e.g., "Authentication" → `src/auth`) that narrows the agent's working context when a task is tagged with an area. Agent configuration is a settings concern, not the daily-use surface.

**Teams** — The context boundary. Shared context (coding standards, conventions, repo knowledge) is injected into every agent run. The team owns the standards; agents enforce them.

---

## 5. Task lifecycle

### States

| State | Description | Triggered by |
|---|---|---|
| **Open** | Task created with description and acceptance criteria. Not yet assigned. | Human creates |
| **Assigned** | Human assigns task to an agent. Session created automatically. Agent starts immediately — no separate "run" button. | Human assigns |
| **Agent evaluates** | Agent reads the task and codebase. Decides whether the task is small enough to code directly or too large. | Agent decides |
| **Needs input** | Agent determined the task is too large, or got stuck during coding. Notifies team via Slack. Human either breaks the task down or provides guidance. | Agent flags |
| **In progress** | Agent writing code in sandbox. Visible on activity dashboard. | Agent codes |
| **PR open** | Agent pushed to branch, opened draft PR. Waiting for human code review. | Agent opens PR |
| **Review cycle** | Human reviews PR. If changes requested, agent iterates — loops back to "in progress." May repeat multiple times. | Human + agent loop |
| **Done** | PR merged. Task complete. Session preserved as the full work record. | Human merges |

### Additional terminal states

- **Failed** — agent exhausted budget or hit unrecoverable error
- **Cancelled** — human stopped it at any point

### Task decomposition

**Alpha:** the agent does not decompose tasks itself. When the agent evaluates a task and determines it is too large to handle as a single unit, it moves the task to "needs input" and tells the human to break it down manually. The human creates smaller tasks and assigns them individually.

**Post-alpha:** the agent proposes subtasks, human reviews and approves, agent auto-starts on each. Two levels max (task → subtasks, no sub-subtasks). Subtasks are independent — one failure doesn't block the others. Parent task shows aggregate progress.

---

## 6. Context architecture

Agents are only as good as the context they receive. The product uses a three-layer context model — each layer differs in who selects the context, when it's injected, and how much curation it needs.

### Layer 1: Always-on context

Injected into every agent run, regardless of task. This is the team's identity — coding standards, naming conventions, architecture principles, PR review expectations. Written by the tech lead, updated rarely. Capped at ~64 KB because it's paid for in every prompt.

**Alpha:** exists today as `shared_context` on teams.

### Layer 2: Task-linked context

Explicitly attached to a task by the person who creates it. "For this task, read the Figma spec and the customer interview summary." The human decides what's relevant — the system doesn't guess. This is how non-engineers provide domain context: a PM attaches the design spec and feedback doc, and the agent has what it needs.

**Alpha:** new — a document picker on the task creation form. Simple to build, high leverage.

### Layer 3: Retrieved context

The system searches the full context library using the task description and codebase signals, and automatically retrieves the most relevant chunks. The agent doesn't get everything — it gets what's most likely to matter. This is the layer that makes the product magical at scale (200+ documents) and is also where context pollution is the biggest risk.

**Alpha:** not included. Post-alpha unlock. Requires chunking, embedding, and retrieval infrastructure (pgvector is already planned in the architecture).

### Context assembly per run

Every agent run assembles its context in this order:

1. Platform preamble (identity, safety, output conventions)
2. Always-on team context (layer 1)
3. Task-linked documents (layer 2)
4. Retrieved context chunks (layer 3, post-alpha)
5. Agent system prompt + skills

### Ingestion pipeline

**Alpha:** manual upload only. Documents are chunked and indexed as-is — no summarization, no processing.

**Post-alpha:** documents are processed on upload. A meeting transcript becomes a structured summary of key decisions and requirements. A design spec becomes extracted component descriptions and interaction patterns. Document type is auto-detected (no manual tagging). The processed output is visible and editable — users review what the system extracted before it enters the context library.

**Later:** automatic ingestion from integrations (Notion, Figma, Gong/Fireflies). Context stays current without manual uploads.

---

## 7. Navigation and screens

### Sidebar navigation

| Item | Purpose |
|---|---|
| **Tasks** | Home screen. The daily-use surface for the entire team. |
| **Activity** | What are agents doing right now? Ops dashboard for monitoring active sessions and catching stuck work. |
| **Teams** | Team members and shared context. |
| **Settings** | Agent configuration, skills, connections. |

Sessions are not in the sidebar. They're reached by clicking into a task — the session is the task's work log, not a standalone object.

### Alpha screens

| Screen | Status | Description |
|---|---|---|
| **Task board** | New | List view. Tasks show ID, status, assignee, area, duration, PR link. |
| **Create task** | New | Structured form: title, description, acceptance criteria, context attachments. Assign to agent (agent carries a default codebase). |
| **Task detail / session** | Rework | Summary header (task spec, status, agent, PR) + scannable work log. Designed for handoff. |
| **Activity dashboard** | New | All active sessions across all agents. Status, duration, needs-attention flags. |
| **Agent configuration** | Exists | System prompt, model, default codebase, feature/area mapping (optional), tool policy, skills. Under settings. Includes starter agents. |
| **Team + shared context** | Exists | Team members and shared context (standards, conventions). |

---

## 8. Locked decisions

1. **Tasks are the primary object, not agents or sessions.** The task board is the home screen. Agent configuration is settings. Sessions are reached through tasks.

2. **Assignment = start.** No separate "run" button. When a human assigns an agent to a task, the agent begins immediately.

3. **Alpha: agent alerts on oversized tasks, human decomposes manually.** Post-alpha: agent proposes subtasks, human approves. Two levels max. Subtasks are independent — one failure doesn't block the others.

4. **Session = persistent, shareable work record.** Any team member can open a session and continue interacting. Designed for scannability and handoff.

5. **Agent notifies when stuck.** "Needs input" is a real task state, not silent failure. Notification via Slack or similar.

6. **No task import for alpha.** Users write tasks directly in AgentFactory. Forces the right mental model and faster learning. Import comes later for growth.

7. **Starter agents ship out of the box.** Code implementer and code reviewer are pre-configured. Team adds shared context, connects GitHub, starts creating tasks within 10 minutes.

8. **PRs require human review.** Agents open draft PRs. Humans review and merge. Automated review/approval is a later consideration.

9. **Three-layer context model.** Always-on (team standards), task-linked (human-attached docs), and retrieved (semantic search). Alpha ships layers 1 and 2. Layer 3 is post-alpha.

10. **Alpha context: raw indexing, no processing.** Documents are uploaded, chunked, and indexed as-is. AI-powered processing comes post-alpha.

11. **Processed context is visible and editable.** When post-alpha processing is added, users see how the system interpreted their upload and can edit before it enters the context library.

12. **Auto-detect document type, no manual tagging.** The system identifies whether a document is a meeting transcript, design spec, customer interview, etc.

---

## 9. Open questions

1. **Does "done" trigger automatically from PR merge?** If GitHub webhook updates task status when the PR merges, the board stays accurate automatically. If manual, the two systems can drift. Webhook is recommended.

2. **Does the agent pick up PR review feedback automatically?** When a reviewer requests changes, does the agent iterate automatically, or does the human need to explicitly reassign?

3. **How does the non-engineer experience differ?** A PM writing tasks and an engineer writing tasks need different guidance and possibly different views. Same UI or persona-specific?

4. ~~**Task board UX: kanban, list, or both?**~~ **Resolved: list view for alpha.**

5. **Dependency detection between subtasks.** Post-alpha concern (decomposition is post-alpha). Subtasks run independently by design, but some will have real dependencies. Users manually sequence. Add intelligence later.

6. **Which integrations for automatic context ingestion?** Post-alpha: Notion (specs), Figma (designs), and Gong/Fireflies (meeting transcripts) are the highest-signal sources. Priority depends on alpha user feedback.

7. **How to prevent context pollution at scale?** When the context library grows to 200+ documents, bad retrieval degrades agent output. Quality of chunking, embedding, and relevance scoring becomes critical.

8. **What is the context library?** Two possible models: (a) pointers to external locations (Google Drive, Monday docs, Notion pages) that are synced/indexed, or (b) documents uploaded directly into AgentFactory. Could be a hybrid. Determines the ingestion pipeline design and how context stays current.

9. **"Needs input" notification channel.** Most likely Slack, but needs explicit design. How does the agent's alert reach the right person? Channel message, DM, or both?

10. **Onboarding / first-run flow.** Starter agents ship out of the box (locked decision #7), but the setup flow — connecting GitHub, adding shared context, creating the first task — needs detailed design.
