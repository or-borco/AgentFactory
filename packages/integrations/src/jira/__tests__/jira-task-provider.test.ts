import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../task-provider";
import { JiraTaskProvider } from "../jira-task-provider";
import myselfFixture from "./fixtures/myself.json";
import issueFixture from "./fixtures/issue.json";
import error401Fixture from "./fixtures/error-401.json";
import error404Fixture from "./fixtures/error-404.json";
import error429Fixture from "./fixtures/error-429.json";

const SITE_URL = "https://acme.atlassian.net";
const ACCOUNT_EMAIL = "svc@acme.com";
const API_TOKEN = "token-abc123";
const EXPECTED_AUTH_HEADER = `Basic ${Buffer.from(`${ACCOUNT_EMAIL}:${API_TOKEN}`).toString("base64")}`;

function provider(): JiraTaskProvider {
  return new JiraTaskProvider({ siteUrl: SITE_URL, accountEmail: ACCOUNT_EMAIL, apiToken: API_TOKEN });
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("verify", () => {
  it("sends Basic auth and returns the authenticated account", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(myselfFixture));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().verify();

    expect(result).toEqual({ accountId: "5b10a2844c20165700ede21g", displayName: "Jane Doe" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/rest/api/3/myself`);
    expect(init.headers.Authorization).toBe(EXPECTED_AUTH_HEADER);
  });

  it("throws ProviderError with isAuthFailure on a 401", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(error401Fixture, 401));
    vi.stubGlobal("fetch", fetchMock);

    const error = await provider()
      .verify()
      .catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as InstanceType<typeof ProviderError>).status).toBe(401);
    expect((error as InstanceType<typeof ProviderError>).isAuthFailure).toBe(true);
  });
});

describe("fetchIssue", () => {
  it("maps every field per the Jira -> ExternalIssue mapping", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(issueFixture));
    vi.stubGlobal("fetch", fetchMock);

    const issue = await provider().fetchIssue("PROJ-123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/rest/api/3/issue/PROJ-123`);
    expect(init.headers.Authorization).toBe(EXPECTED_AUTH_HEADER);

    expect(issue).toBeDefined();
    expect(issue?.key).toBe("PROJ-123");
    expect(issue?.title).toBe("Login page throws 500 on submit");
    expect(issue?.status).toBe("In Progress");
    expect(issue?.issueType).toBe("Bug");
    expect(issue?.labels).toEqual(["backend", "urgent"]);
    expect(issue?.updated).toBe("2026-09-10T12:34:56.789+0000");
    expect(issue?.url).toBe(`${SITE_URL}/browse/PROJ-123`);

    // ADF -> Markdown: paragraph, bullet list (with an inline code mark), and a bold mark.
    expect(issue?.description).toContain("Steps to reproduce:");
    expect(issue?.description).toContain("`/login`");
    expect(issue?.description).toContain("Submit the form");
    expect(issue?.description).toContain("**500 error**");

    expect(issue?.attachments).toEqual([
      {
        filename: "stack-trace.txt",
        mime: "text/plain",
        sizeBytes: 2048,
        contentUrl: "https://acme.atlassian.net/rest/api/3/attachment/content/10010",
      },
      {
        filename: "screenshot.png",
        mime: "image/png",
        sizeBytes: 348213,
        contentUrl: "https://acme.atlassian.net/rest/api/3/attachment/content/10011",
      },
    ]);
  });

  it("returns undefined on a 404 rather than throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(error404Fixture, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().fetchIssue("PROJ-999")).resolves.toBeUndefined();
  });

  it("throws ProviderError with isAuthFailure on a 401", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(error401Fixture, 401));
    vi.stubGlobal("fetch", fetchMock);

    const error = await provider()
      .fetchIssue("PROJ-123")
      .catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as InstanceType<typeof ProviderError>).status).toBe(401);
    expect((error as InstanceType<typeof ProviderError>).isAuthFailure).toBe(true);
  });

  it("retries once after a 429, honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(error429Fixture, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(issueFixture));
    vi.stubGlobal("fetch", fetchMock);

    const pending = provider().fetchIssue("PROJ-123");
    await vi.runAllTimersAsync();
    const issue = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issue?.key).toBe("PROJ-123");
  });

  it("throws if the retried request also 429s", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(error429Fixture, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(error429Fixture, 429, { "Retry-After": "1" }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = provider().fetchIssue("PROJ-123");
    const assertion = expect(pending).rejects.toBeInstanceOf(ProviderError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps the retry delay rather than waiting out an arbitrarily long Retry-After", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(error429Fixture, 429, { "Retry-After": "3600" }))
      .mockResolvedValueOnce(jsonResponse(issueFixture));
    vi.stubGlobal("fetch", fetchMock);

    const pending = provider().fetchIssue("PROJ-123");
    // Advance by a bounded amount (well under the bogus 3600s Retry-After). If the retry delay
    // were not capped, the second fetch would not have fired yet and this would hang/mismatch.
    await vi.advanceTimersByTimeAsync(10_000);
    const issue = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issue?.key).toBe("PROJ-123");
  });
});

describe("addComment", () => {
  it("posts the minimal ADF doc envelope, not a plain string", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().addComment("PROJ-123", "Opened PR #42 for this issue.");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/rest/api/3/issue/PROJ-123/comment`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(EXPECTED_AUTH_HEADER);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Opened PR #42 for this issue." }],
          },
        ],
      },
    });
  });

  it("throws ProviderError on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(error404Fixture, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().addComment("PROJ-999", "hi")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("fetchAttachment", () => {
  it("sends the same auth header against the attachment's contentUrl and returns raw bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().fetchAttachment({
      filename: "stack-trace.txt",
      mime: "text/plain",
      sizeBytes: 4,
      contentUrl: "https://acme.atlassian.net/rest/api/3/attachment/content/10010",
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://acme.atlassian.net/rest/api/3/attachment/content/10010");
    expect(init.headers.Authorization).toBe(EXPECTED_AUTH_HEADER);
  });

  it("throws ProviderError on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await provider()
      .fetchAttachment({ filename: "x", mime: "text/plain", sizeBytes: 1, contentUrl: `${SITE_URL}/x` })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as InstanceType<typeof ProviderError>).isAuthFailure).toBe(true);
  });
});

describe("parseIssueReference", () => {
  it("delegates to parseJiraIssueReference using this adapter's site URL", () => {
    expect(provider().parseIssueReference("please fix PROJ-123")).toBe("PROJ-123");
    expect(provider().parseIssueReference(`${SITE_URL}/browse/PROJ-123`)).toBe("PROJ-123");
    expect(provider().parseIssueReference("https://other-site.atlassian.net/browse/PROJ-123")).toBeUndefined();
    expect(provider().parseIssueReference("no reference here")).toBeUndefined();
  });
});
