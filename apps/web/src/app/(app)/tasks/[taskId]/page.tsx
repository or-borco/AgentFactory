"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@agentfactory/shared";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";
import { StatusPill } from "@/components/StatusPill";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CheckIcon, TrashIcon } from "@/lib/icons";
import { apiFetch } from "@/lib/api-client";
import type { Run } from "@agentfactory/core";

type WorkspaceSnapshot = Record<string, string>;

interface RawEvent {
  id: number;
  runId: number;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

// Pairs a tool_call event with its tool_result (if already received).
interface ToolCallEntry {
  callEvent: RawEvent;
  resultEvent: RawEvent | null;
}

// A single humanized thinking step: a friendly label plus the raw detail (shown on hover).
interface ThinkStep {
  label: string;
  detail: string;
}

// Turn a raw shell command into a short, friendly progress phrase.
function summarizeCommand(command: string): string {
  const c = command.trim().toLowerCase();
  if (!c) return "Running a command";
  if (/\bgit\s+(pull|fetch|clone)\b/.test(c)) return "Getting latest updates";
  if (/\bgit\s+(add|commit)\b/.test(c)) return "Saving changes";
  if (/\bgit\s+push\b/.test(c)) return "Pushing changes";
  if (/\bgit\s+(status|diff|log|branch)\b/.test(c)) return "Checking source control";
  if (/\b(npm|pnpm|yarn)\s+(install|ci|add)\b/.test(c) || /\binstall\b/.test(c)) return "Installing dependencies";
  if (/\btsc\b|type-?check/.test(c)) return "Checking types";
  if (/\b(npm|pnpm|yarn)\s+run\s+build\b|(?:^|\s)build(?:$|\s)/.test(c)) return "Building the project";
  if (/\bnode\s+(-e|--eval)\b|\bpython3?\s+-c\b/.test(c)) return "Running a quick check";
  if (/\b(test|jest|vitest|pytest)\b/.test(c)) return "Running tests";
  if (/\b(lint|eslint|prettier)\b/.test(c)) return "Checking code style";
  if (/\b(find|ls|pwd|cat|head|tail|grep|rg|tree|which|stat)\b/.test(c)) return "Exploring the codebase";
  if (/\b(mkdir|cp|mv|rm|touch|chmod)\b/.test(c)) return "Organizing files";
  if (/\becho\b/.test(c)) return "Checking output";
  return "Running a command";
}

// Convert a thinking_delta event into a friendly phrase. Prefers the agent's own
// tool `description` when it wrote one; otherwise infers intent from the tool + command.
// Falls back to parsing the legacy `[Tool] text` string for events stored before the
// structured fields existed.
function humanizeStep(data: Record<string, unknown>): string {
  let tool = typeof data.tool === "string" ? data.tool : "";
  let description = typeof data.description === "string" ? data.description : "";
  let command = typeof data.command === "string" ? data.command : "";
  let filePath = typeof data.filePath === "string" ? data.filePath : "";

  // Legacy events only carry `text` like "[Bash] <description-or-command>".
  if (!tool && typeof data.text === "string") {
    const m = data.text.match(/^\[(\w+)\]\s*([\s\S]*)$/);
    if (m) {
      tool = m[1];
      const rest = m[2].trim();
      const pathMatch = rest.match(/^\w+:\s*(.+)$/);
      if (pathMatch && ["Read", "Write", "Edit", "MultiEdit"].includes(tool)) filePath = pathMatch[1];
      else if (tool === "Bash") command = rest;
      else description = rest;
    }
  }

  const file = filePath ? filePath.split("/").pop() ?? filePath : "";
  switch (tool) {
    case "Read": return file ? `Reading ${file}` : "Reading a file";
    case "Write": return file ? `Writing ${file}` : "Writing a file";
    case "Edit":
    case "MultiEdit": return file ? `Editing ${file}` : "Editing a file";
    case "NotebookEdit": return file ? `Editing ${file}` : "Editing a notebook";
    case "Glob":
    case "Grep": return "Searching the codebase";
    case "WebSearch": return "Searching the web";
    case "WebFetch": return "Reading a web page";
    case "TodoWrite": return "Planning the work";
    case "Task": return "Delegating to a subagent";
    case "Bash": return description || summarizeCommand(command);
    default: return description || (tool ? `Using ${tool}` : "Working");
  }
}

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const router = useRouter();
  const { getTask, agents, sessions, messagesForSession, loadMessages, runTask, sendMessage, updateTask, deleteTask, notify } =
    useMockBackend();
  const { t } = useTranslation();

  const [starting, setStarting] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"transcript" | "files">("transcript");
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [rawEvents, setRawEvents] = useState<RawEvent[]>([]);
  const [showToolCalls] = useState(false);
  const [showThinking] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const task = getTask(Number(taskId));
  const assignee = task?.assigneeAgentId
    ? agents.find((a) => a.id === task.assigneeAgentId)
    : undefined;
  const session = task?.sessionId
    ? sessions.find((s) => s.id === task.sessionId)
    : undefined;
  const messages = useMemo(
    () => (session ? messagesForSession(session.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.id, messagesForSession],
  );

  const handleTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    userScrolledRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 60;
  }, []);

  // Auto-scroll to bottom on new content only while a run is actively streaming —
  // that's when following the latest output is what the user wants. For a completed
  // run opened for review we leave the scroll at the top so the transcript reads in
  // order (prompt → thinking → answer); otherwise the jump-to-bottom hides the
  // thinking block that sits above a long answer.
  useEffect(() => {
    const active = runStatus != null && !["done", "failed", "cancelled"].includes(runStatus);
    if (active && !userScrolledRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, runStatus, rawEvents]);

  // Load existing messages, workspace, and events when a session is linked.
  useEffect(() => {
    if (!session) return;
    loadMessages(session.id);
    (async () => {
      const [runs, events] = await Promise.all([
        apiFetch<Run[]>(`/api/sessions/${session.id}/runs`).catch(() => [] as Run[]),
        apiFetch<RawEvent[]>(`/api/sessions/${session.id}/events`).catch(() => [] as RawEvent[]),
      ]);
      const done = runs.find((r) => r.status === "done" && r.workspaceSnapshot);
      if (done?.workspaceSnapshot) {
        setWorkspace(done.workspaceSnapshot);
        setSelectedFile(Object.keys(done.workspaceSnapshot)[0] ?? null);
        setActiveTab("files");
      }
      setRawEvents(events);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const pollRun = useCallback(
    (id: number, sessionId: number) => {
      const tick = () => {
        setTimeout(async () => {
          const [run, events] = await Promise.all([
            apiFetch<Run>(`/api/runs/${id}`),
            apiFetch<RawEvent[]>(`/api/sessions/${sessionId}/events`).catch(() => [] as RawEvent[]),
          ]);
          setRunStatus(run.status);
          setRawEvents(events);
          if (run.status === "done") {
            await loadMessages(sessionId);
            if (run.workspaceSnapshot && Object.keys(run.workspaceSnapshot).length > 0) {
              setWorkspace(run.workspaceSnapshot);
              setSelectedFile(Object.keys(run.workspaceSnapshot)[0] ?? null);
              setActiveTab("files");
            }
          } else if (run.status !== "failed" && run.status !== "cancelled") {
            tick();
          }
        }, 1500);
      };
      tick();
    },
    [loadMessages],
  );

  const pollRunStatus = useCallback((id: number, sessionId: number) => {
    const tick = () => {
      setTimeout(async () => {
        const [run, events] = await Promise.all([
          apiFetch<Run>(`/api/runs/${id}`),
          apiFetch<RawEvent[]>(`/api/sessions/${sessionId}/events`).catch(() => [] as RawEvent[]),
        ]);
        setRunStatus(run.status);
        setRawEvents(events);
        if (run.status !== "done" && run.status !== "failed" && run.status !== "cancelled") {
          tick();
        }
      }, 1500);
    };
    tick();
  }, []);

  const handleReply = async () => {
    if (!reply.trim() || !session || replying || !!isRunning) return;
    const text = reply.trim();
    setReply("");
    setReplying(true);
    setRunStatus("queued");
    setRunStartedAt(Date.now());
    try {
      const { runId } = await sendMessage(session.id, text);
      pollRunStatus(runId, session.id);
    } finally {
      setReplying(false);
    }
  };

  const handleRun = async () => {
    if (!task) return;
    setStarting(true);
    try {
      const result = await runTask(task.id);
      setRunStatus("queued");
      setRunStartedAt(Date.now());
      pollRun(result.runId, result.session.id);
    } finally {
      setStarting(false);
    }
  };

  // Group thinking_delta events into a list of friendly steps per run, keyed by runId.
  // Events arrive ordered by runId then seq, so order is preserved. Each tool call is
  // humanized ("Installing dependencies", "Writing strings.ts") and consecutive
  // duplicates are collapsed so a burst of `find`/`ls`/`cat` reads as one
  // "Exploring the codebase" line rather than a wall of shell. Thinking is rendered
  // inline with the run's assistant message (see below) so it sits next to the
  // response — not pinned above the whole transcript where auto-scroll would hide it.
  const thinkingByRun = useMemo(() => {
    const byRun = new Map<number, ThinkStep[]>();
    for (const event of rawEvents) {
      if (event.type !== "thinking_delta") continue;
      const label = humanizeStep(event.data);
      const detail =
        typeof event.data.text === "string" ? (event.data.text as string).trim().replace(/^\[\w+\]\s*/, "") : label;
      const steps = byRun.get(event.runId) ?? [];
      if (steps.length === 0 || steps[steps.length - 1].label !== label) {
        steps.push({ label, detail });
      }
      byRun.set(event.runId, steps);
    }
    return byRun;
  }, [rawEvents]);

  // Marking a task done tears down its sandbox server-side (see PATCH /api/tasks/[taskId]) —
  // the running container is no longer needed once the work is closed out.
  const handleMarkDone = async () => {
    if (!task) return;
    setMarkingDone(true);
    try {
      await updateTask(task.id, { status: "done" });
      notify("toast.taskMarkedDone");
    } finally {
      setMarkingDone(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    setDeleting(true);
    try {
      await deleteTask(task.id);
      router.push("/tasks");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const isRunning = runStatus && !["done", "failed", "cancelled"].includes(runStatus);

  // Tick once a second while a run is in flight so the elapsed-time readout stays live —
  // without this, a run stuck in one phase for a while reads as frozen rather than working.
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  if (!task) {
    return (
      <div style={{ padding: "40px", color: "var(--color-neutral-500)" }}>Task not found.</div>
    );
  }

  const doneCriteria = task.acceptanceCriteria.filter((c) => c.done).length;
  const totalCriteria = task.acceptanceCriteria.length;
  const replyDisabled = replying || !!isRunning;

  // Build tool call entries for rendering (each call paired with its result).
  const toolCallEntries: ToolCallEntry[] = rawEvents
    .filter((e) => e.type === "tool_call")
    .map((callEvent) => ({
      callEvent,
      resultEvent: rawEvents.find((e) => e.type === "tool_result" && (e.data as { tool: string }).tool === (callEvent.data as { tool: string }).tool && e.seq > callEvent.seq) ?? null,
    }));

  const panelWidth = panelOpen ? 360 : 16;
  const elapsedSec = runStartedAt ? Math.max(0, Math.floor((nowTick - runStartedAt) / 1000)) : 0;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Left pane (collapsible) ──────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          flexShrink: 0,
          overflow: "hidden",
          width: panelWidth,
          transition: "width 0.25s cubic-bezier(.4,0,.2,1)",
        }}
      >
        {/* Inner content — always 360px, fades out when collapsed */}
        <div
          style={{
            width: 360,
            flexShrink: 0,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid var(--color-divider)",
            opacity: panelOpen ? 1 : 0,
            visibility: panelOpen ? "visible" : "hidden",
            pointerEvents: panelOpen ? "auto" : "none",
            // visibility switches immediately on open (so content appears as it fades in),
            // but waits for the opacity fade to finish before hiding on close.
            transition: panelOpen
              ? "opacity 0.2s ease, visibility 0s 0s"
              : "opacity 0.2s ease, visibility 0s 0.2s",
          }}
        >
          {/* Pane header — 48px, always visible */}
          <div
            style={{
              height: 48,
              flexShrink: 0,
              borderBottom: "1px solid var(--color-divider)",
              padding: "0 20px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Link
              href="/tasks"
              style={{
                fontSize: 12,
                color: "var(--color-neutral-500)",
                textDecoration: "none",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              ← {t("tasks.title")}
            </Link>
          </div>

          {/* Scrollable spec body */}
          <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px 48px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 12,
                  color: "var(--color-neutral-500)",
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-divider)",
                  borderRadius: "var(--radius-sm)",
                  padding: "2px 7px",
                }}
              >
                {task.ref}
              </span>
              <StatusPill
                status={task.status}
                label={t(`tasks.status.${task.status}` as `tasks.status.${typeof task.status}`)}
              />
            </div>

            <h1 style={{ marginTop: 14, fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>
              {task.title}
            </h1>

            <section style={{ marginTop: 24 }}>
              <SectionLabel>{t("taskDetail.description")}</SectionLabel>
              <p
                style={{
                  marginTop: 8,
                  fontSize: 14,
                  lineHeight: 1.65,
                  color: "var(--color-neutral-300)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {task.description || "—"}
              </p>
            </section>

            {task.acceptanceCriteria.length > 0 && (
              <section style={{ marginTop: 28 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <SectionLabel>{t("taskDetail.criteria")}</SectionLabel>
                  <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>
                    {doneCriteria}/{totalCriteria}
                  </span>
                </div>
                <ul
                  style={{
                    marginTop: 10,
                    listStyle: "none",
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {task.acceptanceCriteria.map((c, i) => (
                    <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13 }}>
                      <span
                        style={{
                          flexShrink: 0,
                          marginTop: 1,
                          width: 17,
                          height: 17,
                          borderRadius: 4,
                          border: c.done
                            ? "1.5px solid #4eca8b"
                            : "1.5px solid var(--color-neutral-700)",
                          background: c.done ? "rgba(78,202,139,0.12)" : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {c.done && <CheckIcon size={10} color="#4eca8b" weight="bold" />}
                      </span>
                      <span
                        style={{
                          color: c.done ? "var(--color-neutral-500)" : "var(--color-neutral-300)",
                          textDecoration: c.done ? "line-through" : "none",
                        }}
                      >
                        {c.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section style={{ marginTop: 32 }}>
              <SectionLabel>{t("taskDetail.metaLabel")}</SectionLabel>
              <dl
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "8px 16px",
                  fontSize: 13,
                }}
              >
                <MetaRow label={t("taskDetail.assignee")}>
                  {assignee ? assignee.name : <Dim>{t("taskDetail.unassigned")}</Dim>}
                </MetaRow>
                {task.area && (
                  <MetaRow label={t("taskDetail.area")}>
                    <Mono>{task.area}</Mono>
                  </MetaRow>
                )}
                {task.codebase && (
                  <MetaRow label={t("taskDetail.codebase")}>
                    <Mono>{task.codebase}</Mono>
                  </MetaRow>
                )}
                {task.prUrl && (
                  <MetaRow label={t("taskDetail.pr")}>
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--color-accent)", textDecoration: "none" }}
                    >
                      #{task.prNumber} ↗
                    </a>
                  </MetaRow>
                )}
              </dl>
            </section>

            {task.status === "assigned" && !task.sessionId && (
              <div style={{ marginTop: 32 }}>
                <Button variant="primary" disabled={starting} onClick={handleRun}>
                  {starting ? "Starting…" : "Run agent"}
                </Button>
              </div>
            )}

            {/* Status / lifecycle actions */}
            <div style={{ marginTop: 32, display: "flex", gap: 10 }}>
              {task.status !== "done" && (
                <Button variant="secondary" disabled={markingDone} onClick={handleMarkDone}>
                  <CheckIcon size={14} />
                  {markingDone ? t("taskDetail.markingDone") : t("taskDetail.markDone")}
                </Button>
              )}
              <Button variant="secondary" disabled={deleting} onClick={() => setConfirmingDelete(true)}>
                <TrashIcon size={14} />
                {t("taskDetail.deleteTask")}
              </Button>
            </div>
          </div>
        </div>

        {/* Collapse handle — sits on the divider line */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          title={panelOpen ? "Collapse panel" : "Expand panel"}
          style={{
            position: "absolute",
            top: "50%",
            right: -1,
            transform: "translateY(-50%)",
            width: 16,
            height: 52,
            background: "var(--color-surface)",
            border: "1px solid var(--color-divider)",
            borderRadius: "8px 0 0 8px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
            padding: 0,
            color: "var(--color-neutral-600)",
            transition: "color 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-neutral-300)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-neutral-500)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-neutral-600)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-divider)";
          }}
        >
          <svg
            width={9}
            height={9}
            viewBox="0 0 9 9"
            fill="none"
            style={{
              transform: panelOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.25s cubic-bezier(.4,0,.2,1)",
            }}
          >
            <path d="M6 1.5L3 4.5L6 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* ── Right pane ──────────────────────────────────────────────────── */}

      {confirmingDelete && (
        <ConfirmDialog
          title={t("taskDetail.confirmDeleteTitle", { title: task.title })}
          message={t("taskDetail.confirmDeleteMessage")}
          confirmLabel={deleting ? t("taskDetail.deleting") : t("taskDetail.confirmDeleteButton")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={handleDelete}
        />
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid var(--color-divider)",
            padding: "0 24px",
            flexShrink: 0,
          }}
        >
          <TabBtn active={activeTab === "transcript"} onClick={() => setActiveTab("transcript")}>
            Transcript
          </TabBtn>
          {workspace && Object.keys(workspace).length > 0 && (
            <TabBtn active={activeTab === "files"} onClick={() => setActiveTab("files")}>
              {`Files (${Object.keys(workspace).length})`}
            </TabBtn>
          )}
          {/* Agent working indicator in tab bar */}
          {isRunning && (
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--color-neutral-500)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--color-accent)",
                  animation: "pulse 1.2s ease-in-out infinite",
                  flexShrink: 0,
                }}
              />
              Agent working
            </div>
          )}
        </div>

        {/* Transcript tab */}
        {activeTab === "transcript" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Messages scroll area */}
            <div ref={scrollRef} onScroll={handleTranscriptScroll} style={{ flex: 1, overflowY: "auto", padding: "22px 28px 20px" }}>
              {runStatus === "failed" && (
                <div style={{ fontSize: 13, color: "#e8a44a", marginBottom: 14 }}>Run failed — check worker logs.</div>
              )}

              {/* Tool call rows (hidden by default) */}
              {showToolCalls && toolCallEntries.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
                  {toolCallEntries.map(({ callEvent, resultEvent }) => {
                    const done = resultEvent !== null;
                    const toolName = (callEvent.data as { tool: string }).tool;
                    const input = (callEvent.data as { input: Record<string, unknown> }).input;
                    const argValue = Object.values(input)[0];
                    const argStr = typeof argValue === "string" ? argValue : JSON.stringify(argValue);
                    return (
                      <div
                        key={callEvent.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "5px 10px",
                          background: "rgba(0,0,0,0.2)",
                          border: "1px solid var(--color-divider)",
                          borderRadius: "var(--radius-sm)",
                          cursor: "default",
                        }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.03)")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.2)")}
                      >
                        {/* Status icon */}
                        {done ? (
                          <svg width={10} height={10} viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
                            <path d="M1.5 5l2.5 2.5 4.5-5" stroke="#4eca8b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <span
                            style={{
                              flexShrink: 0,
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              border: "1.5px solid var(--color-accent)",
                              borderTopColor: "transparent",
                              animation: "spin 0.8s linear infinite",
                            }}
                          />
                        )}
                        {/* Tool name */}
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-neutral-500)", letterSpacing: "0.03em", flexShrink: 0 }}>
                          {toolName}
                        </span>
                        {/* Argument */}
                        <span
                          style={{
                            fontSize: 11,
                            fontFamily: "ui-monospace, monospace",
                            color: "var(--color-neutral-700)",
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {argStr}
                        </span>
                        {/* Running badge */}
                        {!done && (
                          <span style={{ fontSize: 11, color: "#e8a44a", animation: "pulse 1.2s ease-in-out infinite", flexShrink: 0 }}>
                            running…
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {messages.length === 0 && !isRunning ? (
                <div style={{ marginTop: 40, textAlign: "center", color: "var(--color-neutral-500)" }}>
                  <div style={{ fontSize: 36, marginBottom: 12 }}>🤖</div>
                  <p style={{ fontWeight: 600, fontSize: 14, color: "var(--color-neutral-400)" }}>{t("taskDetail.noTranscript")}</p>
                  <p style={{ fontSize: 13, marginTop: 6 }}>{t("taskDetail.noTranscriptSub")}</p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {messages.map((msg) => (
                    <div key={msg.id} style={{ animation: "fadein 0.18s ease" }}>
                      {/* Thinking for this turn, shown right above the agent's reply. */}
                      {showThinking && msg.role === "assistant" && msg.runId != null && thinkingByRun.has(msg.runId) && (
                        <ThinkingBlock steps={thinkingByRun.get(msg.runId)!} />
                      )}
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: msg.role === "assistant" ? "var(--color-accent)" : "var(--color-neutral-500)",
                          marginBottom: 5,
                        }}
                      >
                        {msg.role === "assistant" ? (assignee?.name ?? "Agent") : "YOU"}
                      </div>
                      <div
                        style={{
                          padding: "10px 14px",
                          borderRadius: "var(--radius-md)",
                          fontSize: 13,
                          lineHeight: 1.65,
                          color: msg.role === "assistant" ? "var(--color-neutral-200)" : "var(--color-accent-300, #b8aee8)",
                          background: msg.role === "assistant" ? "var(--color-surface)" : "rgba(145,132,217,0.07)",
                          border: "1px solid var(--color-divider)",
                        }}
                      >
                        <MessageContent content={msg.content} />
                      </div>
                    </div>
                  ))}

                  {/* Live thinking for the in-progress turn — its assistant message
                      doesn't exist yet, so it renders here at the bottom where the
                      auto-scroll keeps it in view as it streams. */}
                  {showThinking && (() => {
                    const answeredRunIds = new Set(
                      messages.filter((m) => m.role === "assistant" && m.runId != null).map((m) => m.runId),
                    );
                    return [...thinkingByRun.entries()]
                      .filter(([runId]) => !answeredRunIds.has(runId))
                      .map(([runId, steps]) => <ThinkingBlock key={`live-${runId}`} steps={steps} />);
                  })()}

                  {/* Agent working indicator — last item in the list */}
                  {isRunning && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--color-neutral-400)", fontSize: 13 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-accent)", animation: "pulse 1.2s ease-in-out infinite" }} />
                      {runStatusLabel(runStatus)}
                      {elapsedSec >= 10 && (
                        <span style={{ color: "var(--color-neutral-600)" }}>· {elapsedSec}s</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Reply bar — always in DOM, disabled when no session */}
            <div
              style={{
                flexShrink: 0,
                borderTop: "1px solid var(--color-divider)",
                padding: "12px 20px",
                display: "flex",
                gap: 10,
                alignItems: "flex-end",
                background: "var(--color-bg)",
              }}
            >
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleReply(); }
                }}
                placeholder="Reply to the agent… (↵ send · ⇧↵ new line)"
                disabled={!session || replyDisabled}
                rows={1}
                style={{
                  flex: 1,
                  resize: "none",
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-divider)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--color-text)",
                  fontSize: 13,
                  lineHeight: 1.5,
                  padding: "9px 14px",
                  outline: "none",
                  fontFamily: "inherit",
                  opacity: (!session || replyDisabled) ? 0.5 : 1,
                }}
              />
              <button
                onClick={handleReply}
                disabled={!session || !reply.trim() || replyDisabled}
                style={{
                  flexShrink: 0,
                  background: "var(--color-accent)",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  padding: "9px 18px",
                  cursor: !session || !reply.trim() || replyDisabled ? "not-allowed" : "pointer",
                  opacity: (!session || !reply.trim() || replyDisabled) ? 0.35 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                {replying ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}

        {/* Files tab */}
        {activeTab === "files" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {workspace && Object.keys(workspace).length > 0 ? (
              <>
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    padding: "10px 20px",
                    borderBottom: "1px solid var(--color-divider)",
                    overflowX: "auto",
                    flexShrink: 0,
                  }}
                >
                  {Object.keys(workspace).sort().map((path) => (
                    <button
                      key={path}
                      onClick={() => setSelectedFile(path)}
                      style={{
                        flexShrink: 0,
                        background: selectedFile === path ? "rgba(145,132,217,0.15)" : "var(--color-surface)",
                        border: `1px solid ${selectedFile === path ? "var(--color-accent)" : "var(--color-divider)"}`,
                        borderRadius: "var(--radius-sm)",
                        cursor: "pointer",
                        padding: "3px 10px",
                        fontSize: 11,
                        fontFamily: "ui-monospace, monospace",
                        color: selectedFile === path ? "var(--color-accent)" : "var(--color-neutral-400)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {path}
                    </button>
                  ))}
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
                  {selectedFile && workspace[selectedFile] !== undefined ? (
                    <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.7, fontFamily: "ui-monospace, monospace", color: "var(--color-neutral-200)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {workspace[selectedFile]}
                    </pre>
                  ) : (
                    <div style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>Select a file above.</div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-neutral-500)", fontSize: 13 }}>
                {isRunning ? "Files will appear when the run completes." : "No files in workspace."}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes fadein {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>
    </div>
  );
}

function ThinkingBlock({ steps }: { steps: ThinkStep[] }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div
      style={{
        marginLeft: 2,
        marginBottom: 14,
        borderLeft: "2px solid var(--color-neutral-800)",
        borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
        background: "rgba(0,0,0,0.15)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setCollapsed((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "6px 12px 6px 14px",
          textAlign: "left",
        }}
      >
        <svg
          width={8}
          height={8}
          viewBox="0 0 8 8"
          fill="none"
          style={{
            flexShrink: 0,
            transform: collapsed ? "rotate(-90deg)" : "none",
            transition: "transform 0.15s",
          }}
        >
          <path d="M1 2.5L4 5.5L7 2.5" stroke="var(--color-neutral-700)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--color-neutral-700)",
            fontStyle: "normal",
          }}
        >
          THINKING
        </span>
      </button>
      {!collapsed && (
        <div style={{ padding: "0 12px 10px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          {steps.map((step, i) => (
            <div key={i} title={step.detail} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span
                style={{
                  flexShrink: 0,
                  width: 5,
                  height: 5,
                  marginTop: 1,
                  borderRadius: "50%",
                  background: "var(--color-neutral-700)",
                }}
              />
              <span style={{ fontSize: 12.5, color: "var(--color-neutral-500)", lineHeight: 1.5 }}>
                {step.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Maps the run's actual state-machine phase (see runs.status / ARCHITECTURE.md) to
// user-facing text, so the loading state reflects what's really happening instead of
// one static "Agent is working…" string for the whole run.
function runStatusLabel(status: string | null): string {
  switch (status) {
    case "queued":
      return "Queued — waiting for a sandbox…";
    case "provisioning":
      return "Setting up the sandbox…";
    case "running":
      return "Agent is working…";
    case "finalizing":
      return "Wrapping up — pushing changes…";
    default:
      return "Agent is working…";
  }
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "13px 0",
        marginRight: 28,
        fontSize: 13,
        fontWeight: 500,
        color: active ? "var(--color-text)" : "var(--color-neutral-500)",
        borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
        transition: "color 0.15s",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = "var(--color-neutral-300)"; }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.color = "var(--color-neutral-500)"; }}
    >
      {children}
    </button>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        const fence = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
        if (fence) {
          return (
            <pre
              key={i}
              style={{
                margin: "10px 0",
                padding: "10px 14px",
                borderRadius: "var(--radius-sm)",
                background: "rgba(0,0,0,0.25)",
                fontSize: 12,
                lineHeight: 1.6,
                fontFamily: "ui-monospace, monospace",
                color: "var(--color-neutral-200)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflowX: "auto",
              }}
            >
              {fence[2]}
            </pre>
          );
        }
        return <span key={i} style={{ whiteSpace: "pre-wrap" }}>{part}</span>;
      })}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--color-neutral-500)",
      }}
    >
      {children}
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: "var(--color-neutral-500)", whiteSpace: "nowrap" }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--color-text)" }}>{children}</dd>
    </>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--color-neutral-600)" }}>{children}</span>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{children}</span>
  );
}
