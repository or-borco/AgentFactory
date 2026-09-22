"use client";

import { useTranslation } from "@/lib/i18n/context";
import { StopIcon } from "@/lib/icons";
import styles from "./TaskReplyBar.module.css";

interface TaskReplyBarProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  hasSession: boolean;
  isRunning: boolean;
  sending: boolean;
  stopping: boolean;
}

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
    <div className={styles.bar}>
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
        className={styles.textarea}
      />
      {isRunning && (
        <button onClick={onStop} disabled={stopping} className={styles.stopButton}>
          <StopIcon size={14} />
          {stopping ? t("taskDetail.stoppingAgent") : t("taskDetail.stopReply")}
        </button>
      )}
      <button
        onClick={onSend}
        disabled={!hasSession || !value.trim() || replyDisabled}
        className={styles.sendButton}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
