"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@agentfactory/shared";
import { useAppData } from "@/lib/app-data/context";
import { useTranslation } from "@/lib/i18n/context";
import { StatusPill } from "@/components/StatusPill";

export default function ActivityPage() {
  const { tasks, agents } = useAppData();
  const { t } = useTranslation();

  // ── Derived stats ───────────────────────────────────────────────────────────
  const openCount = tasks.filter((tk) => tk.status === "open").length;
  const assignedCount = tasks.filter((tk) => tk.status === "assigned").length;
  const inProgressCount = tasks.filter((tk) => tk.status === "in_progress").length;
  const needsInputCount = tasks.filter((tk) => tk.status === "needs_input").length;
  const reviewCycleCount = tasks.filter((tk) => tk.status === "review_cycle").length;
  const prOpenCount = tasks.filter((tk) => tk.status === "pr_open").length;
  const failedCount = tasks.filter((tk) => tk.status === "failed").length;
  const cancelledCount = tasks.filter((tk) => tk.status === "cancelled").length;

  // "Done this week" = done tasks updated within the last 7 days
  const [oneWeekAgo] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);
  const doneThisWeek = tasks.filter(
    (tk) => tk.status === "done" && new Date(tk.updatedAt).getTime() > oneWeekAgo,
  ).length;

  // Feed: all tasks sorted newest-first by updatedAt
  const feed = [...tasks].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const getAgentName = (agentId?: number) =>
    agentId ? (agents.find((a) => a.id === agentId)?.name ?? t("tasks.unassigned")) : t("tasks.unassigned");

  return (
    <div style={{ padding: "40px 40px 0", maxWidth: 900 }}>
      <PageHeader title={t("activity.title")} subtitle={t("activity.subtitle")} />

      {/* ── Stat tiles ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 16,
          marginTop: 28,
        }}
      >
        <StatTile label={t("activity.open")} value={openCount} color="var(--color-neutral-400)" />
        <StatTile label={t("activity.assigned")} value={assignedCount} color="#5ba3d9" />
        <StatTile label={t("activity.inProgress")} value={inProgressCount} color="#5ba3d9" />
        <StatTile label={t("activity.needsInput")} value={needsInputCount} color="#e8a44a" />
        <StatTile label={t("activity.reviewCycle")} value={reviewCycleCount} color="var(--color-accent)" />
        <StatTile label={t("activity.prsOpen")} value={prOpenCount} color="#4eca8b" />
        <StatTile label={t("activity.doneThisWeek")} value={doneThisWeek} color="var(--color-accent)" />
        <StatTile label={t("activity.failed")} value={failedCount} color="#e05a5a" />
        <StatTile label={t("activity.cancelled")} value={cancelledCount} color="var(--color-neutral-500)" />
      </div>

      {/* ── Feed ────────────────────────────────────────────────────────────── */}
      <section style={{ marginTop: 40 }}>
        <h2
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--color-neutral-500)",
            marginBottom: 12,
          }}
        >
          {t("activity.recentTasks")}
        </h2>

        {feed.length === 0 ? (
          <div
            style={{
              paddingTop: 48,
              textAlign: "center",
              color: "var(--color-neutral-500)",
            }}
          >
            <p style={{ fontWeight: 600, fontSize: 14, color: "var(--color-neutral-400)" }}>
              {t("activity.noActivity")}
            </p>
            <p style={{ fontSize: 13, marginTop: 6 }}>{t("activity.noActivitySub")}</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {feed.map((task) => (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                style={{ textDecoration: "none" }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    padding: "13px 0",
                    borderBottom: "1px solid var(--color-divider)",
                  }}
                >
                  {/* Ref */}
                  <span
                    style={{
                      flexShrink: 0,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12,
                      color: "var(--color-neutral-500)",
                      width: 52,
                    }}
                  >
                    {task.ref}
                  </span>

                  {/* Title */}
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--color-text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {task.title}
                  </span>

                  {/* Assignee */}
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 12,
                      color: task.assigneeAgentId
                        ? "var(--color-neutral-400)"
                        : "var(--color-neutral-600)",
                      width: 150,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {getAgentName(task.assigneeAgentId)}
                  </span>

                  {/* Status */}
                  <StatusPill
                    status={task.status}
                    label={t(`tasks.status.${task.status}` as `tasks.status.${typeof task.status}`)}
                  />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── StatTile ──────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-md)",
        padding: "20px 20px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-neutral-500)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 32,
          fontWeight: 700,
          lineHeight: 1,
          color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}
