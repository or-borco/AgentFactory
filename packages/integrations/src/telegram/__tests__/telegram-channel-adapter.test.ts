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
        isTasksCommand: false,
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
        callbackQueryId: "cbq-1",
        isStartCommand: false,
        startPayload: undefined,
        isTasksCommand: false,
      });
    });

    it("throws on an unrecognized update shape", () => {
      expect(() => adapter.receive({ some_other_update: {} })).toThrow();
    });

    describe("isTasksCommand", () => {
      it("recognizes /tasks", () => {
        const inbound = adapter.receive({ message: { chat: { id: 1 }, text: "/tasks" } });
        expect(inbound.isTasksCommand).toBe(true);
      });

      it("recognizes /tasks@botname", () => {
        const inbound = adapter.receive({ message: { chat: { id: 1 }, text: "/tasks@my_bot" } });
        expect(inbound.isTasksCommand).toBe(true);
      });

      it("does not treat /tasksomething as the command", () => {
        const inbound = adapter.receive({ message: { chat: { id: 1 }, text: "/tasksomething" } });
        expect(inbound.isTasksCommand).toBe(false);
      });

      it("is false for ordinary text", () => {
        const inbound = adapter.receive({ message: { chat: { id: 1 }, text: "hello" } });
        expect(inbound.isTasksCommand).toBe(false);
      });

      it("is false for a callback_query (a tap can never itself be a text command)", () => {
        const inbound = adapter.receive({ callback_query: { id: "1", message: { chat: { id: 1 } }, data: "newtask" } });
        expect(inbound.isTasksCommand).toBe(false);
      });
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

    it("sends a single space for an empty message", async () => {
      await adapter.send("42", "");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "42", text: " " });
    });

    it("sends exactly one call for a message exactly at the 4096 limit", async () => {
      const text = "a".repeat(4096);
      await adapter.send("42", text);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(init.body as string).text).toHaveLength(4096);
    });

    it("sends two calls for a message one character over the 4096 limit", async () => {
      const text = "a".repeat(4097);
      await adapter.send("42", text);
      expect(fetch).toHaveBeenCalledTimes(2);
      const bodies = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
      expect(bodies[0].text).toHaveLength(4096);
      expect(bodies[1].text).toHaveLength(1);
    });

    it("never splits a surrogate pair straddling a chunk boundary", async () => {
      // The emoji's high surrogate lands exactly at index 4095, so a naive slice(0, 4096) would
      // cut between its two code units.
      const longText = "a".repeat(4095) + "\u{1F600}" + "b".repeat(10);
      await adapter.send("42", longText);
      expect(fetch).toHaveBeenCalledTimes(2);
      const bodies = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
      for (const body of bodies) {
        for (let i = 0; i < body.text.length; i++) {
          const code = body.text.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            // A high surrogate must be immediately followed by its low surrogate within the same chunk.
            expect(i + 1).toBeLessThan(body.text.length);
            const next = body.text.charCodeAt(i + 1);
            expect(next).toBeGreaterThanOrEqual(0xdc00);
            expect(next).toBeLessThanOrEqual(0xdfff);
          }
          if (code >= 0xdc00 && code <= 0xdfff) {
            // A low surrogate must not appear without a preceding high surrogate in the same chunk.
            expect(i).toBeGreaterThan(0);
            const prev = body.text.charCodeAt(i - 1);
            expect(prev).toBeGreaterThanOrEqual(0xd800);
            expect(prev).toBeLessThanOrEqual(0xdbff);
          }
        }
      }
      expect(bodies.map((b: { text: string }) => b.text).join("")).toBe(longText);
    });
  });
});
