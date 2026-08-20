"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskStatus } from "@agentfactory/core";
import { useTranslation } from "@/lib/i18n/context";
import { STATUS_STYLES } from "@/components/StatusPill";

const STATUS_ORDER: TaskStatus[] = [
  "open",
  "assigned",
  "in_progress",
  "needs_input",
  "pr_open",
  "review_cycle",
  "done",
  "failed",
  "cancelled",
];

interface StatusMenuProps {
  status: TaskStatus;
  open: boolean;
  onToggle: () => void;
  onSelect: (status: TaskStatus) => void;
}

// Clickable status pill that opens a dropdown of every status, used on the task detail
// page to change a task's status inline.
export function StatusMenu({ status, open, onToggle, onSelect }: StatusMenuProps) {
  const { t } = useTranslation();
  const style = STATUS_STYLES[status];
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  // The menu is portalled to <body> and positioned from the trigger's actual screen
  // coordinates, rather than nested with `position: absolute` inside the table — the tasks
  // table wraps in `overflow-x: auto` for narrow viewports, and per the CSS overflow spec that
  // forces overflow-y to "auto" too, which would clip an absolutely-positioned dropdown on any
  // table short enough that the menu extends past the wrapper's own content height.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.left });
  }, [open]);

  // Closes on a click outside the trigger/menu. Uses a document listener rather than a
  // full-viewport overlay element — an overlay would sit above every other row's trigger button
  // too, swallowing the click meant for one and requiring a second click to actually open it.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onToggle();
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open, onToggle]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          background: "transparent",
          border: `1px solid ${style.color}`,
          color: style.color,
          borderRadius: "var(--radius-sm)",
          padding: "5px 10px",
          fontSize: 12,
          fontWeight: 500,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {t(`tasks.status.${status}` as `tasks.status.${TaskStatus}`)}
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              background: "var(--color-surface)",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              padding: 6,
              minWidth: 150,
              zIndex: 50,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            {STATUS_ORDER.map((s) => (
              <div
                key={s}
                role="menuitem"
                onClick={() => onSelect(s)}
                style={{
                  padding: "7px 10px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 13,
                  color: STATUS_STYLES[s].color,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
              >
                {t(`tasks.status.${s}` as `tasks.status.${TaskStatus}`)}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
