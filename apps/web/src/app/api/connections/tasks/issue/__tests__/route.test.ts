import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const resolveTaskProviderMock = vi.fn();
const parseIssueReferenceMock = vi.fn();
const fetchIssueMock = vi.fn();

vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));
vi.mock("@/server/task-provider", () => ({
  resolveTaskProvider: (...args: unknown[]) => resolveTaskProviderMock(...args),
}));

import { GET } from "../route";

function getRequest(ref?: string) {
  const url = new URL("http://localhost/api/connections/tasks/issue");
  if (ref !== undefined) url.searchParams.set("ref", ref);
  return new Request(url);
}

const externalIssue = {
  key: "PROJ-123",
  title: "Fix the thing",
  description: "It is broken.",
  status: "In Progress",
  issueType: "Bug",
  labels: ["urgent"],
  url: "https://acme.atlassian.net/browse/PROJ-123",
  attachments: [
    { filename: "screenshot.png", mime: "image/png", sizeBytes: 1024, contentUrl: "https://acme.atlassian.net/attachment/1" },
  ],
  updated: "2026-09-14T00:00:00.000Z",
};

const provider = { parseIssueReference: parseIssueReferenceMock, fetchIssue: fetchIssueMock };

beforeEach(() => {
  requireAuthContextMock.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  resolveTaskProviderMock.mockReset().mockResolvedValue({ connection: { id: 9 }, provider });
  parseIssueReferenceMock.mockReset();
  fetchIssueMock.mockReset();
});

describe("GET /api/connections/tasks/issue", () => {
  it("401s when unauthenticated, without resolving a provider", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);

    const res = await GET(getRequest("PROJ-123"));

    expect(res.status).toBe(401);
    expect(resolveTaskProviderMock).not.toHaveBeenCalled();
  });

  it('404s with code "no_connection" when the org has no tasks connection', async () => {
    resolveTaskProviderMock.mockResolvedValue(undefined);

    const res = await GET(getRequest("PROJ-123"));

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("no_connection");
    expect(parseIssueReferenceMock).not.toHaveBeenCalled();
    expect(fetchIssueMock).not.toHaveBeenCalled();
  });

  it("400s when ref does not parse to an issue reference", async () => {
    parseIssueReferenceMock.mockReturnValue(undefined);

    const res = await GET(getRequest("not an issue"));

    expect(res.status).toBe(400);
    expect(fetchIssueMock).not.toHaveBeenCalled();
  });

  // parseIssueReference itself rejects a browse URL for a different Atlassian site than the org's
  // connection (Task 3, Step 2) — the route just has to honor its undefined result and never fetch.
  it("400s on a browse URL for a different Atlassian site, and never calls fetchIssue", async () => {
    parseIssueReferenceMock.mockReturnValue(undefined);

    const res = await GET(getRequest("https://other-site.atlassian.net/browse/PROJ-123"));

    expect(res.status).toBe(400);
    expect(parseIssueReferenceMock).toHaveBeenCalledExactlyOnceWith("https://other-site.atlassian.net/browse/PROJ-123");
    expect(fetchIssueMock).not.toHaveBeenCalled();
  });

  it("404s when the issue does not exist", async () => {
    parseIssueReferenceMock.mockReturnValue("PROJ-123");
    fetchIssueMock.mockResolvedValue(undefined);

    const res = await GET(getRequest("PROJ-123"));

    expect(res.status).toBe(404);
    expect(fetchIssueMock).toHaveBeenCalledExactlyOnceWith("PROJ-123");
  });

  it("returns the ExternalIssue body, including attachments and updated, on success", async () => {
    parseIssueReferenceMock.mockReturnValue("PROJ-123");
    fetchIssueMock.mockResolvedValue(externalIssue);

    const res = await GET(getRequest("PROJ-123"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(externalIssue);
  });
});
