import type { ID, ISODateTime } from "@agentfactory/core";

export interface ChatMessage {
  id: ID;
  sessionId: ID;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  createdAt: ISODateTime;
}
