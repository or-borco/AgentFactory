"use client";

import { useTranslation } from "@/lib/i18n/context";
import { StopIcon } from "@/lib/icons";

interface TaskReplyBarProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Whether a session exists for this task yet — the whole bar is disabled without one. */
  hasSession: boolean;
  /** Whether the current run is still in flight — gates the textarea/Send and reveals Stop. */
  isRunning: boolean;
  sending: boolean;
  stopping: boolean;
}

// The transcript tab's reply bar: textarea, a Stop button (shown only while a run is in
// flight, since that's the only time there's anything to interrupt), and Send. Extracted from
// TaskDetailPage so the Stop-while-running control can be unit tested without standing up the
// rest of that page's run-polling state.
export function TaskReplyBar({
  value,
  onChange,
  onSend,
  onStop,
  hasSession,
  isRunning,
  sending,
  stopping,
}: TaskReplyBarProps) {
  const { t } = useTranslation();
  const replyDisabled = sending || isRunning;

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
            onSend();
          }
        }}
        placeholder="Reply to the agent… (↵ send · ⇧↵ new line)"
        disabled={!hasSession || replyDisabled}
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
          opacity: !hasSession || replyDisabled ? 0.5 : 1,
        }}
      />
      {isRunning && (
        <button
          onClick={onStop}
          disabled={stopping}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "1px solid var(--color-divider)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-neutral-300)",
            fontSize: 13,
            fontWeight: 600,
            padding: "9px 14px",
            cursor: stopping ? "not-allowed" : "pointer",
            opacity: stopping ? 0.6 : 1,
            transition: "opacity 0.15s",
          }}
        >
          <StopIcon size={14} />
          {stopping ? t("taskDetail.stoppingAgent") : t("taskDetail.stopReply")}
        </button>
      )}
      <button
        onClick={onSend}
        disabled={!hasSession || !value.trim() || replyDisabled}
        style={{
          flexShrink: 0,
          background: "var(--color-accent)",
          border: "none",
          borderRadius: "var(--radius-md)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          padding: "9px 18px",
          cursor: !hasSession || !value.trim() || replyDisabled ? "not-allowed" : "pointer",
          opacity: !hasSession || !value.trim() || replyDisabled ? 0.35 : 1,
          transition: "opacity 0.15s",
        }}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
