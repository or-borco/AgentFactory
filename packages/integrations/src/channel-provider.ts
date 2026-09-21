import type { Connection } from "@agentfactory/core";
import { TelegramChannelAdapter } from "./telegram/telegram-channel-adapter";

export interface InboundMessage {
  externalUserId: string;
  text?: string;
  callbackData?: string;
  /** Present on callback_query updates; pass to answerCallbackQuery to dismiss the button spinner. */
  callbackQueryId?: string;
  isStartCommand: boolean;
  startPayload?: string;
  isTasksCommand: boolean;
}

export interface MenuOption {
  label: string;
  value: string;
}

export interface ChannelAdapter {
  /** Parses a raw webhook payload. Throws on a shape this adapter doesn't recognize. */
  receive(raw: unknown): InboundMessage;
  /** Sends plain text, chunking at the provider's own message-length limit internally. */
  send(externalThreadRef: string, text: string): Promise<void>;
  /** Sends a prompt with tappable options (e.g. the agent picker). */
  sendMenu(externalThreadRef: string, prompt: string, options: MenuOption[]): Promise<void>;
  /** Best-effort "still working" signal for the duration of a long-running turn. */
  sendTyping(externalThreadRef: string): Promise<void>;
  /** Dismisses the loading spinner on an inline button tap. Must be called within 10 s of receiving the callback_query. */
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
}

// The one place an adapter is chosen — mirrors createTaskProvider() in ./task-provider.ts.
export function createChannelAdapter(connection: Connection, secret: Record<string, string>): ChannelAdapter {
  switch (connection.provider) {
    case "telegram": {
      const { botToken } = secret;
      if (typeof botToken !== "string") {
        throw new Error(`Telegram connection ${connection.id} is missing a botToken secret`);
      }
      return new TelegramChannelAdapter({ botToken });
    }
    default:
      throw new Error(`Unknown channel provider "${connection.provider}"`);
  }
}
