"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Truncate } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { ArrowLeftIcon, BotIcon, SendIcon } from "@/lib/icons";
import { useAppData } from "@/lib/app-data/context";

export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { getSession, getAgent, messagesForSession, loadMessages, sendMessage } = useAppData();
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionIdNum = Number(sessionId);
  const session = getSession(sessionIdNum);
  const agent = session ? getAgent(session.agentId) : undefined;
  const messages = messagesForSession(sessionIdNum);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    void loadMessages(sessionIdNum);
  }, [sessionIdNum, loadMessages]);

  if (!session || !agent) {
    return <div className="px-10 py-10 text-sm text-[var(--color-neutral-500)]">{t("common.loading")}</div>;
  }

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    void sendMessage(session.id, text);
    setInput("");
  };

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-divider)] px-10 py-4">
        <button
          onClick={() => router.push(`/agents/${agent.id}`)}
          className="shrink-0 text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-200)]"
        >
          <ArrowLeftIcon size={16} />
        </button>
        <Truncate text={session.title} className="text-sm font-semibold text-[var(--color-text)]" wrapperClassName="min-w-0 flex-1" />
        <span className="shrink-0 text-sm text-[var(--color-neutral-600)]">·</span>
        <Truncate text={agent.name} className="text-sm text-[var(--color-neutral-500)]" wrapperClassName="max-w-[10rem] shrink-0" />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-10 py-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-4xl">{agent.avatarEmoji}</span>
            <p className="text-base font-semibold text-[var(--color-text)]">
              {t("session.startConversationWith", { name: agent.name })}
            </p>
            <p className="text-sm text-[var(--color-neutral-500)]">{agent.description}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-5">
            {messages.map((m) => (
              <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                {m.role === "assistant" && (
                  <div
                    className="flex shrink-0 items-center justify-center"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "var(--radius-md)",
                      background: m.error ? "rgba(224,96,96,0.15)" : "var(--color-accent-800)",
                      border: `1px solid ${m.error ? "rgba(224,96,96,0.3)" : "var(--color-accent-600)"}`,
                      color: m.error ? "#e06060" : "var(--color-accent)",
                    }}
                  >
                    <BotIcon size={14} />
                  </div>
                )}
                <div
                  className="max-w-lg px-4 py-2.5 text-sm leading-relaxed"
                  style={{
                    borderRadius: "var(--radius-md)",
                    ...(m.role === "user"
                      ? {
                          background: "var(--color-accent-800)",
                          border: "1px solid var(--color-accent-600)",
                          color: "var(--color-accent-200)",
                        }
                      : m.error
                        ? {
                            background: "rgba(224,96,96,0.1)",
                            border: "1px solid rgba(224,96,96,0.2)",
                            color: "#e06060",
                          }
                        : {
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-divider)",
                            color: "var(--color-text)",
                          }),
                  }}
                >
                  {m.content || (m.streaming ? "…" : "")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--color-divider)] px-10 py-4">
        <div className="mx-auto flex max-w-2xl items-end gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={t("session.messagePlaceholder")}
            className="max-h-40 flex-1 resize-none bg-[var(--color-surface)] border border-[var(--color-divider)] px-3.5 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ borderRadius: "var(--radius-md)" }}
          />
          <button
            onClick={submit}
            disabled={!input.trim()}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-45"
            style={{
              borderRadius: "var(--radius-md)",
              background: "var(--color-accent-800)",
              border: "1px solid var(--color-accent-600)",
              color: "var(--color-accent-200)",
            }}
          >
            <SendIcon size={14} />
            {t("session.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
