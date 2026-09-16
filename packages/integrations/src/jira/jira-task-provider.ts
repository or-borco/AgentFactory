import { ProviderError, type ExternalAttachment, type ExternalIssue, type TaskProvider } from "../task-provider";
import { adfToMarkdown } from "./adf";
import { parseJiraIssueReference } from "./parse-ref";

export interface JiraTaskProviderOptions {
  /** e.g. "https://acme.atlassian.net" — no trailing slash. */
  siteUrl: string;
  accountEmail: string;
  apiToken: string;
}

// A 429's Retry-After is honored but never trusted blindly — a misbehaving or malicious response
// could ask us to wait an unbounded amount of time. One retry, capped delay, then give up.
const MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function retryDelayMs(retryAfterHeader: string | null): number {
  const seconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_RETRY_DELAY_MS;
  return Math.min(ms, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Jira error bodies are `{ errorMessages: string[], errors: {...} }`. Falls back to the raw body
// (or the status text) so a shape we don't recognize still produces a readable message instead of
// "undefined".
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { errorMessages?: string[] };
    if (body.errorMessages?.length) return body.errorMessages.join("; ");
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return text || res.statusText || `Jira API request failed with status ${res.status}`;
}

interface JiraIssueResponse {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string };
    issuetype: { name: string };
    labels?: string[];
    updated: string;
    attachment?: Array<{
      filename: string;
      mimeType: string;
      size: number;
      content: string;
    }>;
  };
}

// Calls Jira Cloud REST v3 with HTTP Basic auth. See AgentFactoryContext/superpowers/specs/2026-09-12-jira-
// integration-design.md ("Mechanism > The port") for the field mapping this implements.
export class JiraTaskProvider implements TaskProvider {
  constructor(private readonly options: JiraTaskProviderOptions) {}

  private authHeader(): string {
    const { accountEmail, apiToken } = this.options;
    return `Basic ${Buffer.from(`${accountEmail}:${apiToken}`).toString("base64")}`;
  }

  // Every call goes through here so the 401/403 passthrough, the bounded 429 retry, and the
  // Authorization header stay in exactly one place.
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = { Authorization: this.authHeader(), Accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
    let res = await fetch(url, { ...init, headers });
    if (res.status === 429) {
      await sleep(retryDelayMs(res.headers.get("retry-after")));
      res = await fetch(url, { ...init, headers });
    }
    return res;
  }

  async verify(): Promise<{ accountId: string; displayName: string }> {
    const res = await this.request(`${this.options.siteUrl}/rest/api/3/myself`);
    if (!res.ok) throw new ProviderError(res.status, await errorMessage(res));
    const body = (await res.json()) as { accountId: string; displayName: string };
    return { accountId: body.accountId, displayName: body.displayName };
  }

  parseIssueReference(text: string): string | undefined {
    return parseJiraIssueReference(text, this.options.siteUrl);
  }

  async fetchIssue(key: string): Promise<ExternalIssue | undefined> {
    const res = await this.request(`${this.options.siteUrl}/rest/api/3/issue/${encodeURIComponent(key)}`);
    // An issue that doesn't exist (or the token can't see) is a normal outcome for a pasted
    // reference, not an error — surfaced as undefined rather than a thrown ProviderError.
    if (res.status === 404) return undefined;
    if (!res.ok) throw new ProviderError(res.status, await errorMessage(res));

    const body = (await res.json()) as JiraIssueResponse;
    const attachments: ExternalAttachment[] = (body.fields.attachment ?? []).map((a) => ({
      filename: a.filename,
      mime: a.mimeType,
      sizeBytes: a.size,
      contentUrl: a.content,
    }));

    return {
      key: body.key,
      title: body.fields.summary,
      description: adfToMarkdown(body.fields.description),
      status: body.fields.status.name,
      issueType: body.fields.issuetype.name,
      labels: body.fields.labels ?? [],
      url: `${this.options.siteUrl}/browse/${body.key}`,
      attachments,
      updated: body.fields.updated,
    };
  }

  async fetchAttachment(attachment: ExternalAttachment): Promise<Uint8Array> {
    const res = await this.request(attachment.contentUrl);
    if (!res.ok) throw new ProviderError(res.status, await errorMessage(res));
    return new Uint8Array(await res.arrayBuffer());
  }

  async addComment(key: string, body: string): Promise<void> {
    // Jira Cloud REST v3 rejects a plain-string comment body — it must be an ADF document. This
    // is the minimal envelope: one paragraph containing the comment text as a single text node.
    const adfDoc = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
    };

    const res = await this.request(`${this.options.siteUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: adfDoc }),
    });
    if (!res.ok) throw new ProviderError(res.status, await errorMessage(res));
  }
}
