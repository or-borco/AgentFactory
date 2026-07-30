import type { TaskStatus } from "@agentfactory/core";

const STATUS_STYLES: Record<TaskStatus, { bg: string; color: string; label: string }> = {
  open:         { bg: "rgba(147,151,171,0.15)", color: "var(--color-neutral-400)", label: "Open" },
  assigned:     { bg: "rgba(91,163,217,0.15)",  color: "#5ba3d9",                  label: "Assigned" },
  in_progress:  { bg: "rgba(91,163,217,0.15)",  color: "#5ba3d9",                  label: "In progress" },
  needs_input:  { bg: "rgba(232,164,74,0.15)",  color: "#e8a44a",                  label: "Needs input" },
  pr_open:      { bg: "rgba(78,202,139,0.15)",  color: "#4eca8b",                  label: "PR open" },
  review_cycle: { bg: "rgba(145,132,217,0.15)", color: "var(--color-accent)",       label: "Review cycle" },
  done:         { bg: "rgba(78,202,139,0.15)",  color: "#4eca8b",                  label: "Done" },
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
        gap: 5,
        padding: "3px 8px",
        borderRadius: 99,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.01em",
        background: style.bg,
        color: style.color,
        whiteSpace: "nowrap",
      }}
    >
      {/* Status dot */}
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: "currentColor",
          flexShrink: 0,
        }}
      />
      {label ?? style.label}
    </span>
  );
}
