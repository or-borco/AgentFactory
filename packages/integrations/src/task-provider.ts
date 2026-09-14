import type { Connection } from "@agentfactory/core";
import { JiraTaskProvider } from "./jira/jira-task-provider";

export interface ExternalAttachment {
  filename: string;
  mime: string;
  sizeBytes: number;
  /** Provider content URL — authenticated, not a public link. Passed back into fetchAttachment. */
  contentUrl: string;
}

export interface ExternalIssue {
  key: string;
  title: string;
  description: string;
  status: string;
  issueType: string;
  labels: string[];
  url: string;
  attachments: ExternalAttachment[];
  /** The provider's own last-modified timestamp — what a future staleness check compares against. */
  updated: string;
}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** 401/403 means the credential is dead; anything else is transient or scope-specific. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface TaskProvider {
  /** Verify the credential and return the authenticated account. Called on connect. */
  verify(): Promise<{ accountId: string; displayName: string }>;
  /** Pull out an issue reference from free text; undefined when there isn't one. */
  parseIssueReference(text: string): string | undefined;
  fetchIssue(key: string): Promise<ExternalIssue | undefined>;
  /** Downloads one attachment's bytes, authenticated the same way as every other call. */
  fetchAttachment(attachment: ExternalAttachment): Promise<Uint8Array>;
  addComment(key: string, body: string): Promise<void>;
}

// The one place an adapter is chosen. Mirrors createBlobStore() (packages/storage/src/index.ts):
// every provider without an adapter throws a clear error.
export function createTaskProvider(connection: Connection, secret: Record<string, string>): TaskProvider {
  switch (connection.provider) {
    case "jira": {
      const { siteUrl, accountEmail } = connection.config;
      if (typeof siteUrl !== "string" || typeof accountEmail !== "string") {
        throw new Error(`Jira connection ${connection.id} is missing siteUrl/accountEmail in its config`);
      }
      const { apiToken } = secret;
      if (typeof apiToken !== "string") {
        throw new Error(`Jira connection ${connection.id} is missing an apiToken secret`);
      }
      return new JiraTaskProvider({ siteUrl, accountEmail, apiToken });
    }
    default:
      throw new Error(`Unknown task provider "${connection.provider}"`);
  }
}
