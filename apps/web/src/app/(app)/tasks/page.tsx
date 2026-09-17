"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, EmptyState, PageHeader, TooltipBubble } from "@agentfactory/shared";
import { useAppData } from "@/lib/app-data/context";
import { useTranslation } from "@/lib/i18n/context";
import { StatusPill } from "@/components/StatusPill";
import { TaskRowActions } from "@/components/TaskRowActions";
import { TasksIcon, AlertIcon } from "@/lib/icons";

export default function TasksPage() {
  const { tasks, agents, runTask, updateTask, deleteTask, notify } = useAppData();
  const { t } = useTranslation();
  const router = useRouter();

  const getAgentName = (agentId?: number) =>
    agentId ? (agents.find((a) => a.id === agentId)?.name ?? t("tasks.unassigned")) : t("tasks.unassigned");

  return (
    <div style={{ padding: "40px 40px 0" }}>
      <PageHeader
        title={t("tasks.title")}
        subtitle={t("tasks.subtitle")}
        action={
          tasks.length > 0 ? (
            <Link href="/tasks/new">
              <Button variant="primary">{t("tasks.newTask")}</Button>
            </Link>
          ) : undefined
        }
      />

      {tasks.length === 0 ? (
        <EmptyState
          icon={<TasksIcon size={22} />}
          title={t("tasks.noTasksYet")}
          subtitle={t("tasks.noTasksSubtitle")}
          action={
            <Link href="/tasks/new">
              <Button variant="primary">{t("tasks.newTask")}</Button>
            </Link>
          }
        />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-divider)" }}>
                {(["id", "task", "status", "assignee", "area", "actions"] as const).map((col) => (
                  <th
                    key={col}
                    style={{
                      textAlign: "left",
                      padding: "8px 12px",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: "var(--color-neutral-500)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t(`tasks.col.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  style={{ borderBottom: "1px solid var(--color-divider)" }}
                  className="group"
                >
                  {/* ID */}
                  <td style={{ padding: "11px 12px", whiteSpace: "nowrap" }}>
                    <Link
                      href={`/tasks/${task.id}`}
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 12,
                        color: "var(--color-neutral-500)",
                        textDecoration: "none",
                      }}
                    >
                      {task.ref}
                    </Link>
                  </td>

                  {/* Task title */}
                  <td style={{ padding: "11px 12px", maxWidth: 340 }}>
                    <Link
                      href={`/tasks/${task.id}`}
                      style={{
                        color: "var(--color-text)",
                        textDecoration: "none",
                        fontWeight: 500,
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.title}
                    </Link>
                  </td>

                  {/* Status */}
                  <td style={{ padding: "11px 12px", whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <StatusPill
                        status={task.status}
                        label={t(`tasks.status.${task.status}` as `tasks.status.${typeof task.status}`)}
                      />
                      {task.externalRef && task.externalRef.writeBackFailure && (
                        <span
                          className="group/tooltip relative inline-flex"
                          style={{ color: "var(--color-status-amber)" }}
                        >
                          <AlertIcon size={13} />
                          <TooltipBubble
                            label={t("writeBackFailure.listTooltip", {
                              provider: t(`connections.provider.${task.externalRef.provider}`),
                              message: task.externalRef.writeBackFailure.message,
                            })}
                          />
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Assignee */}
                  <td
                    style={{
                      padding: "11px 12px",
                      color: task.assigneeAgentId ? "var(--color-text)" : "var(--color-neutral-600)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {getAgentName(task.assigneeAgentId)}
                  </td>

                  {/* Area */}
                  <td
                    style={{
                      padding: "11px 12px",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12,
                      color: "var(--color-neutral-500)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {task.area ?? t("tasks.noArea")}
                  </td>

                  {/* Actions */}
                  <td style={{ padding: "6px 12px", whiteSpace: "nowrap" }}>
                    <TaskRowActions
                      task={task}
                      onRun={async () => {
                        await runTask(task.id);
                        router.push(`/tasks/${task.id}`);
                      }}
                      onMarkDone={async () => {
                        await updateTask(task.id, { status: "done" });
                        notify("toast.taskMarkedDone");
                      }}
                      onDelete={async () => {
                        await deleteTask(task.id);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
