import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramChannelAdapter } from "../telegram-channel-adapter";

describe("TelegramChannelAdapter", () => {
  const adapter = new TelegramChannelAdapter({ botToken: "test-token" });

  describe("receive", () => {
    it("parses a plain text message", () => {
      const raw = { message: { chat: { id: 42 }, text: "hello" } };
      expect(adapter.receive(raw)).toEqual({
        externalUserId: "42",
        text: "hello",
        callbackData: undefined,
        isStartCommand: false,
        startPayload: undefined,
      });
    });

    it("parses a bare /start", () => {
      const raw = { message: { chat: { id: 42 }, text: "/start" } };
      const parsed = adapter.receive(raw);
      expect(parsed.isStartCommand).toBe(true);
      expect(parsed.startPayload).toBeUndefined();
    });

    it("parses /start with a deep-link payload", () => {
      const raw = { message: { chat: { id: 42 }, text: "/start ABC12345" } };
      const parsed = adapter.receive(raw);
      expect(parsed.isStartCommand).toBe(true);
      expect(parsed.startPayload).toBe("ABC12345");
    });

    it("parses a callback_query (menu button tap)", () => {
      const raw = { callback_query: { id: "cbq-1", message: { chat: { id: 42 } }, data: "agent:7" } };
      expect(adapter.receive(raw)).toEqual({
        externalUserId: "42",
        text: undefined,
        callbackData: "agent:7",
        isStartCommand: false,
        startPayload: undefined,
      });
    });

    it("throws on an unrecognized update shape", () => {
      expect(() => adapter.receive({ some_other_update: {} })).toThrow();
    });
  });

  describe("send", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    });
    afterEach(() => vi.unstubAllGlobals());

    it("sends a single sendMessage call for a short message", async () => {
      await adapter.send("42", "hello");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/sendMessage");
      expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "42", text: "hello" });
    });

    it("chunks a message longer than 4096 characters into multiple sendMessage calls", async () => {
      const longText = "a".repeat(9000);
      await adapter.send("42", longText);
      expect(fetch).toHaveBeenCalledTimes(3); // 4096 + 4096 + 808
      const bodies = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
      expect(bodies[0].text).toHaveLength(4096);
      expect(bodies[1].text).toHaveLength(4096);
      expect(bodies[2].text).toHaveLength(808);
      expect(bodies.map((b: { text: string }) => b.text).join("")).toBe(longText);
    });
  });
});
