"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Breadcrumb } from "@agentfactory/shared";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";
import { StatusPill } from "@/components/StatusPill";
import { CheckIcon } from "@/lib/icons";

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const { getTask, agents, sessions, messagesForSession, loadMessages } = useMockBackend();
  const { t } = useTranslation();

  const task = getTask(Number(taskId));
  const assignee = task?.assigneeAgentId
    ? agents.find((a) => a.id === task.assigneeAgentId)
    : undefined;
  const session = task?.sessionId
    ? sessions.find((s) => s.id === task.sessionId)
    : undefined;
  const messages = session ? messagesForSession(session.id) : [];

  useEffect(() => {
    if (session) {
      loadMessages(session.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  if (!task) {
    return (
      <div style={{ padding: "40px", color: "var(--color-neutral-500)" }}>
        Task not found.
      </div>
    );
  }

  const doneCriteria = task.acceptanceCriteria.filter((c) => c.done).length;
  const totalCriteria = task.acceptanceCriteria.length;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Left pane: task details ─────────────────────────────────────── */}
      <div
        style={{
          flex: "0 0 460px",
          overflowY: "auto",
          padding: "32px 36px 48px",
          borderRight: "1px solid var(--color-divider)",
        }}
      >
        {/* Breadcrumb */}
        <Breadcrumb label={t("tasks.title")} href="/tasks" />

        {/* Ref + status row */}
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

        {/* Title */}
        <h1
          style={{
            marginTop: 14,
            fontSize: 22,
            fontWeight: 700,
            lineHeight: 1.3,
            color: "var(--color-text)",
          }}
        >
          {task.title}
        </h1>

        {/* Description */}
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

        {/* Acceptance criteria */}
        {task.acceptanceCriteria.length > 0 && (
          <section style={{ marginTop: 28 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <SectionLabel>{t("taskDetail.criteria")}</SectionLabel>
              <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>
                {doneCriteria}/{totalCriteria}
              </span>
            </div>
            <ul style={{ marginTop: 10, listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {task.acceptanceCriteria.map((c, i) => (
                <li
                  key={i}
                  style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13 }}
                >
                  {/* Check box */}
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

        {/* Meta */}
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
      </div>

      {/* ── Right pane: transcript ──────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "32px 36px 48px" }}>
        <SectionLabel>{t("taskDetail.transcript")}</SectionLabel>

        {messages.length === 0 ? (
          <div
            style={{
              marginTop: 40,
              textAlign: "center",
              color: "var(--color-neutral-500)",
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 12 }}>🤖</div>
            <p style={{ fontWeight: 600, fontSize: 14, color: "var(--color-neutral-400)" }}>
              {t("taskDetail.noTranscript")}
            </p>
            <p style={{ fontSize: 13, marginTop: 6 }}>{t("taskDetail.noTranscriptSub")}</p>
          </div>
        ) : (
          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
            {messages.map((msg) => (
              <div key={msg.id}>
                {/* Role label */}
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    color:
                      msg.role === "assistant"
                        ? "var(--color-accent)"
                        : "var(--color-neutral-500)",
                    marginBottom: 6,
                  }}
                >
                  {msg.role === "assistant" ? (assignee?.name ?? "Agent") : "You"}
                </div>
                {/* Bubble */}
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: "var(--radius-md)",
                    fontSize: 13,
                    lineHeight: 1.65,
                    color: "var(--color-neutral-200)",
                    background:
                      msg.role === "assistant"
                        ? "var(--color-surface)"
                        : "rgba(145,132,217,0.08)",
                    border: "1px solid var(--color-divider)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {msg.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

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
