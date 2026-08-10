import type { TaskStatus } from "@agentfactory/core";

const STATUS_STYLES: Record<TaskStatus, { bg: string; color: string; border: string; label: string }> = {
  open:         { bg: "rgba(147,151,171,0.1)",  color: "var(--color-neutral-400)", border: "rgba(147,151,171,0.2)",   label: "Open" },
  assigned:     { bg: "rgba(91,163,217,0.1)",   color: "#5ba3d9",                  border: "rgba(91,163,217,0.28)",   label: "Assigned" },
  in_progress:  { bg: "rgba(91,163,217,0.1)",   color: "#5ba3d9",                  border: "rgba(91,163,217,0.28)",   label: "In progress" },
  needs_input:  { bg: "rgba(232,164,74,0.1)",   color: "#e8a44a",                  border: "rgba(232,164,74,0.28)",   label: "Needs input" },
  pr_open:      { bg: "rgba(78,202,139,0.1)",   color: "#4eca8b",                  border: "rgba(78,202,139,0.28)",   label: "PR open" },
  review_cycle: { bg: "rgba(145,132,217,0.1)",  color: "var(--color-accent)",       border: "rgba(145,132,217,0.28)", label: "Review cycle" },
  done:         { bg: "rgba(78,202,139,0.1)",   color: "#4eca8b",                  border: "rgba(78,202,139,0.28)",   label: "Done" },
  failed:       { bg: "rgba(224,90,90,0.1)",    color: "#e05a5a",                  border: "rgba(224,90,90,0.28)",    label: "Failed" },
  cancelled:    { bg: "rgba(147,151,171,0.1)",  color: "var(--color-neutral-500)", border: "rgba(147,151,171,0.2)",   label: "Cancelled" },
};

interface StatusPillProps {
  status: TaskStatus;
  /** Override the display label (e.g. translated string) */
  label?: string;
}

export function StatusPill({ status, label }: StatusPillProps) {
  const style = STATUS_STYLES[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 8px",
        borderRadius: "var(--radius-sm)",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.03em",
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {label ?? style.label}
    </span>
  );
}
