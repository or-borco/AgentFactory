import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Session } from "@agentfactory/core";

const mockSend = vi.fn();
vi.mock("@agentfactory/db", () => ({
  listConnections: vi.fn(async () => [{ id: 1, orgId: 9, kind: "channel", provider: "telegram", config: {}, credentialRef: 5 }]),
  getConnectionCredentialRef: vi.fn(async () => 5),
  readConnectionSecret: vi.fn(async () => ({ botToken: "t" })),
  setConnectionHealth: vi.fn(),
}));
vi.mock("@agentfactory/integrations", () => ({
  createChannelAdapter: () => ({ send: mockSend, sendTyping: vi.fn() }),
}));

import { notifySessionOfReply } from "../channel-notify";

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
});
