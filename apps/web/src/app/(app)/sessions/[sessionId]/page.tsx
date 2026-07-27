"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, BotIcon, SendIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { getSession, getAgent, messagesForSession, sendMessage } = useMockBackend();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const session = getSession(sessionId);
  const agent = session ? getAgent(session.agentId) : undefined;
  const messages = messagesForSession(sessionId);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  if (!session || !agent) {
    return <div className="px-10 py-10 text-sm text-slate-500">Loading…</div>;
  }

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    sendMessage(session.id, text);
    setInput("");
  };

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 px-10 py-4">
        <button onClick={() => router.push(`/agents/${agent.id}`)} className="text-slate-400 hover:text-slate-600">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-slate-900">{session.title}</span>
        <span className="text-sm text-slate-400">·</span>
        <span className="text-sm text-slate-500">{agent.name}</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-10 py-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-4xl">{agent.avatarEmoji}</span>
            <p className="text-base font-semibold text-slate-900">Start a conversation with {agent.name}</p>
            <p className="text-sm text-slate-500">{agent.description}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-5">
            {messages.map((m) => (
              <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                {m.role === "assistant" && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
                    <BotIcon className="h-4 w-4" />
                  </div>
                )}
                <div
                  className={`max-w-lg rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === "user" ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-800"
                  }`}
                >
                  {m.content || (m.streaming ? "…" : "")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 px-10 py-4">
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
            placeholder="Send a message... (Enter to send, Shift+Enter for new line)"
            className="max-h-40 flex-1 resize-none rounded-lg border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          <button
            onClick={submit}
            disabled={!input.trim()}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:bg-indigo-200"
          >
            <SendIcon className="h-4 w-4" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
