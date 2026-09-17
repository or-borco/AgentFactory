import type { ChannelAdapter, InboundMessage, MenuOption } from "../channel-provider";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramChannelAdapterOptions {
  botToken: string;
}

interface TelegramChatRef {
  chat: { id: number | string };
}

interface TelegramUpdate {
  message?: TelegramChatRef & { text?: string };
  callback_query?: { id: string; message?: TelegramChatRef; data?: string };
}

function parseStartCommand(text: string): { isStartCommand: boolean; startPayload?: string } {
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text.trim());
  if (!match) return { isStartCommand: false };
  return { isStartCommand: true, startPayload: match[1] };
}

function isTasksCommand(text: string): boolean {
  return /^\/tasks(?:@\w+)?$/.test(text.trim());
}

// Thin wrapper over the Telegram Bot API (https://core.telegram.org/bots/api) — plain HTTPS/JSON,
// no vendor SDK, matching the "direct REST" choice already made for Jira (ARCHITECTURE.md §9).
export class TelegramChannelAdapter implements ChannelAdapter {
  constructor(private readonly options: TelegramChannelAdapterOptions) {}

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.options.botToken}/${method}`;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Telegram API ${method} failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  receive(raw: unknown): InboundMessage {
    const update = raw as TelegramUpdate;

    if (update.callback_query) {
      const chatId = update.callback_query.message?.chat.id;
      if (chatId === undefined) throw new Error("Telegram callback_query missing chat id");
      return {
        externalUserId: String(chatId),
        callbackData: update.callback_query.data,
        isStartCommand: false,
        isTasksCommand: false,
      };
    }

    if (update.message) {
      const text = update.message.text;
      const start = text !== undefined ? parseStartCommand(text) : { isStartCommand: false as const };
      return {
        externalUserId: String(update.message.chat.id),
        text,
        ...start,
        isTasksCommand: text !== undefined ? isTasksCommand(text) : false,
      };
    }

    throw new Error("Unrecognized Telegram update shape");
  }

  async send(externalThreadRef: string, text: string): Promise<void> {
    // The loop below never runs for an empty string (0 < 0 is false), so handle it separately
    // — Telegram rejects an empty text field.
    if (text.length === 0) {
      await this.call("sendMessage", { chat_id: externalThreadRef, text: " " });
      return;
    }
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + TELEGRAM_MESSAGE_LIMIT, text.length);
      // text.slice() cuts on raw UTF-16 code units, so a naive boundary can land between the two
      // code units of a surrogate pair (e.g. an emoji) and split it into two unpaired halves.
      // Back the boundary off by one so the pair stays together in the next chunk instead.
      if (end < text.length) {
        const codeUnit = text.charCodeAt(end - 1);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          end -= 1;
        }
      }
      await this.call("sendMessage", { chat_id: externalThreadRef, text: text.slice(offset, end) });
      offset = end;
    }
  }

  async sendMenu(externalThreadRef: string, prompt: string, options: MenuOption[]): Promise<void> {
    await this.call("sendMessage", {
      chat_id: externalThreadRef,
      text: prompt,
      reply_markup: {
        inline_keyboard: options.map((option) => [{ text: option.label, callback_data: option.value }]),
      },
    });
  }

  async sendTyping(externalThreadRef: string): Promise<void> {
    await this.call("sendChatAction", { chat_id: externalThreadRef, action: "typing" });
  }
}
