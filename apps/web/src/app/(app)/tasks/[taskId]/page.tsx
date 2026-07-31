"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Breadcrumb, Button } from "@agentfactory/shared";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";
import { StatusPill } from "@/components/StatusPill";
import { CheckIcon } from "@/lib/icons";
import { apiFetch } from "@/lib/api-client";
import type { Run } from "@agentfactory/core";

type WorkspaceSnapshot = Record<string, string>;

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const { getTask, agents, sessions, messagesForSession, loadMessages, runTask, sendMessage } = useMockBackend();
  const { t } = useTranslation();

  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"transcript" | "files">("transcript");
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);

  const task = getTask(Number(taskId));
  const assignee = task?.assigneeAgentId
    ? agents.find((a) => a.id === task.assigneeAgentId)
    : undefined;
  const session = task?.sessionId
    ? sessions.find((s) => s.id === task.sessionId)
    : undefined;
  const messages = session ? messagesForSession(session.id) : [];

  // Load existing messages + workspace when a session is already linked
  useEffect(() => {
    if (!session) return;
    loadMessages(session.id);
    // Load workspace from the most recent completed run for this session
    (async () => {
      const runs = await apiFetch<Run[]>(`/api/sessions/${session.id}/runs`).catch(() => []);
      const done = runs.find((r) => r.status === "done" && r.workspaceSnapshot);
      if (done?.workspaceSnapshot) {
        setWorkspace(done.workspaceSnapshot);
        setSelectedFile(Object.keys(done.workspaceSnapshot)[0] ?? null);
        setActiveTab("files");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // Poll run status until terminal
  const pollRun = useCallback(
    (id: number, sessionId: number) => {
      const tick = () => {
        setTimeout(async () => {
          const run = await apiFetch<Run>(`/api/runs/${id}`);
          setRunStatus(run.status);
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

  const handleReply = async () => {
    if (!reply.trim() || !session || replying) return;
    const text = reply.trim();
    setReply("");
    setReplying(true);
    setRunStatus("queued");
    try {
      const { runId } = await sendMessage(session.id, text);
      pollRun(runId, session.id);
    } finally {
      setReplying(false);
    }
  };

  const handleRun = async () => {
    if (!task) return;
    setStarting(true);
    try {
      const result = await runTask(task.id);
      setRunId(result.runId);
      setRunStatus("queued");
      pollRun(result.runId, result.session.id);
    } finally {
      setStarting(false);
    }
  };

  if (!task) {
    return (
      <div style={{ padding: "40px", color: "var(--color-neutral-500)" }}>Task not found.</div>
    );
  }

  const doneCriteria = task.acceptanceCriteria.filter((c) => c.done).length;
  const totalCriteria = task.acceptanceCriteria.length;
  const isRunning = runStatus && !["done", "failed", "cancelled"].includes(runStatus);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Left pane ──────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: "0 0 460px",
          overflowY: "auto",
          padding: "32px 36px 48px",
          borderRight: "1px solid var(--color-divider)",
        }}
      >
        <Breadcrumb label={t("tasks.title")} href="/tasks" />

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20 }}>
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

        {/* Run agent button — only for assigned tasks that haven't started */}
        {task.status === "assigned" && !task.sessionId && (
          <div style={{ marginTop: 32 }}>
            <Button
              variant="primary"
              disabled={starting}
              onClick={handleRun}
            >
              {starting ? "Starting…" : "Run agent"}
            </Button>
          </div>
        )}
      </div>

      {/* ── Right pane: tabs ────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderBottom: "1px solid var(--color-divider)",
            padding: "0 36px",
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
        </div>

        {/* Transcript tab */}
        {activeTab === "transcript" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Messages scroll area */}
            <div style={{ flex: 1, overflowY: "auto", padding: "28px 36px 24px" }}>
              {isRunning && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--color-neutral-400)", fontSize: 13, marginBottom: 20 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-accent)", animation: "pulse 1.2s ease-in-out infinite" }} />
                  Agent is working…
                </div>
              )}
              {runStatus === "failed" && (
                <div style={{ fontSize: 13, color: "#e8a44a", marginBottom: 20 }}>Run failed — check worker logs.</div>
              )}
              {messages.length === 0 && !isRunning ? (
                <div style={{ marginTop: 40, textAlign: "center", color: "var(--color-neutral-500)" }}>
                  <div style={{ fontSize: 36, marginBottom: 12 }}>🤖</div>
                  <p style={{ fontWeight: 600, fontSize: 14, color: "var(--color-neutral-400)" }}>{t("taskDetail.noTranscript")}</p>
                  <p style={{ fontSize: 13, marginTop: 6 }}>{t("taskDetail.noTranscriptSub")}</p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  {messages.map((msg) => (
                    <div key={msg.id}>
                      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: msg.role === "assistant" ? "var(--color-accent)" : "var(--color-neutral-500)", marginBottom: 6 }}>
                        {msg.role === "assistant" ? (assignee?.name ?? "Agent") : "You"}
                      </div>
                      <div style={{ padding: "12px 16px", borderRadius: "var(--radius-md)", fontSize: 13, lineHeight: 1.65, color: "var(--color-neutral-200)", background: msg.role === "assistant" ? "var(--color-surface)" : "rgba(145,132,217,0.08)", border: "1px solid var(--color-divider)" }}>
                        <MessageContent content={msg.content} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Reply input — only when a session exists */}
            {session && (
              <div style={{ flexShrink: 0, borderTop: "1px solid var(--color-divider)", padding: "14px 24px", display: "flex", gap: 10, alignItems: "flex-end" }}>
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleReply(); }
                  }}
                  placeholder="Reply to the agent… (Enter to send, Shift+Enter for new line)"
                  disabled={replying || isRunning}
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
                    opacity: (replying || isRunning) ? 0.5 : 1,
                  }}
                />
                <button
                  onClick={handleReply}
                  disabled={!reply.trim() || replying || isRunning}
                  style={{
                    flexShrink: 0,
                    background: "var(--color-accent)",
                    border: "none",
                    borderRadius: "var(--radius-md)",
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 600,
                    padding: "9px 18px",
                    cursor: "pointer",
                    opacity: (!reply.trim() || replying || isRunning) ? 0.4 : 1,
                    transition: "opacity 0.15s",
                  }}
                >
                  {replying ? "Sending…" : "Send"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Files tab */}
        {activeTab === "files" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {workspace && Object.keys(workspace).length > 0 ? (
              <>
                {/* File picker — horizontal scrollable chip row */}
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
                {/* Code viewer — full width */}
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
      `}</style>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "14px 0",
        marginRight: 28,
        fontSize: 13,
        fontWeight: 600,
        color: active ? "var(--color-text)" : "var(--color-neutral-500)",
        borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
        transition: "color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// Renders message content: splits on ```lang\n...\n``` fences and formats code blocks.
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
