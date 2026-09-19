import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Session } from "@agentfactory/core";

const mockSend = vi.fn();
const mockSendTyping = vi.fn(async () => {});
vi.mock("@agentfactory/db", () => ({
  listConnections: vi.fn(async () => [{ id: 1, orgId: 9, kind: "channel", provider: "telegram", config: {}, credentialRef: 5, agentId: 1 }]),
  getConnectionCredentialRef: vi.fn(async () => 5),
  readConnectionSecret: vi.fn(async () => ({ botToken: "t" })),
  setConnectionHealth: vi.fn(),
  getTaskBySessionId: vi.fn(),
}));
vi.mock("@agentfactory/integrations", () => ({
  createChannelAdapter: () => ({ send: mockSend, sendTyping: mockSendTyping }),
}));

import { getTaskBySessionId } from "@agentfactory/db";
import { notifySessionOfReply, startTypingIndicator } from "../channel-notify";

function webSession(): Session {
  return { id: 1, agentId: 1, title: "t", origin: "web", createdAt: "", lastActivityAt: "" };
}
function telegramSession(): Session {
  return { ...webSession(), origin: "telegram", externalThreadRef: "42" };
}

describe("notifySessionOfReply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a no-op for a web-origin session", async () => {
    const emitEvent = vi.fn();
    await notifySessionOfReply(9, webSession(), "hello", emitEvent);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends via the channel adapter for a telegram-origin session", async () => {
    const emitEvent = vi.fn();
    await notifySessionOfReply(9, telegramSession(), "hello", emitEvent);
    expect(mockSend).toHaveBeenCalledWith("42", "hello");
  });

  it("catches a send failure, emits an error event, and does not throw", async () => {
    mockSend.mockRejectedValueOnce(new Error("Telegram is down"));
    const emitEvent = vi.fn();
    await expect(notifySessionOfReply(9, telegramSession(), "hello", emitEvent)).resolves.toBeUndefined();
    expect(emitEvent).toHaveBeenCalledWith("error", expect.objectContaining({ message: expect.stringContaining("Telegram is down") }));
  });

  it("prefixes the reply with the task ref when the session belongs to a task", async () => {
    vi.mocked(getTaskBySessionId).mockResolvedValue({ ref: "T-042" } as never);
    const emitEvent = vi.fn();

    await notifySessionOfReply(9, telegramSession(), "Done!", emitEvent);

    expect(mockSend).toHaveBeenCalledWith("42", "[T-042] Done!");
  });

  it("sends unprefixed when the session has no owning task", async () => {
    vi.mocked(getTaskBySessionId).mockResolvedValue(undefined);
    const emitEvent = vi.fn();

    await notifySessionOfReply(9, telegramSession(), "Done!", emitEvent);

    expect(mockSend).toHaveBeenCalledWith("42", "Done!");
  });
});

describe("startTypingIndicator", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("is a no-op for a web-origin session", () => {
    const stop = startTypingIndicator(9, webSession());
    expect(typeof stop).toBe("function");
    expect(mockSendTyping).not.toHaveBeenCalled();
  });

  it("sends via the adapter for a telegram-origin session, and re-sends on the interval", async () => {
    vi.useFakeTimers();
    const stop = startTypingIndicator(9, telegramSession());

    await vi.advanceTimersByTimeAsync(0);
    expect(mockSendTyping).toHaveBeenCalledTimes(1);
    expect(mockSendTyping).toHaveBeenCalledWith("42");

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendTyping).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stop function halts further sends", async () => {
    vi.useFakeTimers();
    const stop = startTypingIndicator(9, telegramSession());

    await vi.advanceTimersByTimeAsync(0);
    expect(mockSendTyping).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendTyping).toHaveBeenCalledTimes(1);
  });
});
