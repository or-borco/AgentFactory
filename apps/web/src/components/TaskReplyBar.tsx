"use client";

import { StopIcon } from "@/lib/icons";
import { useTranslation } from "@/lib/i18n/context";

interface TaskReplyBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** True when there's no session yet, or a reply/run is already in flight — disables the textarea and Send. */
  disabled: boolean;
  /** True while the just-submitted reply is being posted — swaps the Send label to "Sending…". */
  sending: boolean;
  /** True while a run is active — surfaces the Stop button next to Send. */
  isRunning: boolean;
  /** True while a stop request is in flight — disables Stop and swaps its label to "Stopping…". */
  stopping: boolean;
}

// Sits between the transcript and the composer's Send button so a user mid-reply can interrupt
// an in-flight run without reaching for the header's icon-only Stop button (ToolbarIconButton in
// the task detail page, gated on task.status rather than this bar's own isRunning).
export function TaskReplyBar({ value, onChange, onSubmit, onStop, disabled, sending, isRunning, stopping }: TaskReplyBarProps) {
  const { t } = useTranslation();
  const canSend = !disabled && value.trim().length > 0;

  return (
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Reply to the agent… (↵ send · ⇧↵ new line)"
        disabled={disabled}
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
          opacity: disabled ? 0.5 : 1,
        }}
      />
      {isRunning && (
        <button
          onClick={onStop}
          disabled={stopping}
          aria-label={t("taskDetail.stopAgent")}
          title={t("taskDetail.stopAgent")}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "var(--color-surface)",
            border: "1px solid var(--color-divider)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-neutral-300)",
            fontSize: 13,
            fontWeight: 600,
            padding: "9px 14px",
            cursor: stopping ? "not-allowed" : "pointer",
            opacity: stopping ? 0.5 : 1,
            transition: "opacity 0.15s",
          }}
        >
          <StopIcon size={14} />
          {stopping ? t("taskDetail.stoppingAgent") : t("taskDetail.stopAgent")}
        </button>
      )}
      <button
        onClick={onSubmit}
        disabled={!canSend}
        style={{
          flexShrink: 0,
          background: "var(--color-accent)",
          border: "none",
          borderRadius: "var(--radius-md)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          padding: "9px 18px",
          cursor: canSend ? "pointer" : "not-allowed",
          opacity: canSend ? 1 : 0.35,
          transition: "opacity 0.15s",
        }}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
