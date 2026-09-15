import { describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));

const getTaskMock = vi.fn();
const listPrReviewsForTaskMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getTask: (id: number) => getTaskMock(id),
  listPrReviewsForTask: (taskId: number, orgId: number) => listPrReviewsForTaskMock(taskId, orgId),
}));

const { GET } = await import("../route");

function fakeReview(id: number) {
  return {
    id,
    orgId: 1,
    taskId: 7,
    runId: 100,
    repoFullName: "acme-org/platform",
    prNumber: 42,
    baseSha: "base",
    headSha: "head",
    verdict: "comment" as const,
    postedAs: "comment" as const,
    githubReviewId: "555",
    url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
    commentCount: 2,
    truncated: false,
    createdAt: new Date().toISOString(),
  };
}

describe("GET /api/tasks/[taskId]/pr-reviews", () => {
  it("returns 401 when not authenticated", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the task doesn't exist or belongs to another org", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue(undefined);
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(404);
  });

  it("returns the task's reviews newest first", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue({ id: 7, orgId: 1 });
    listPrReviewsForTaskMock.mockResolvedValue([fakeReview(2), fakeReview(1)]);

    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(listPrReviewsForTaskMock).toHaveBeenCalledWith(7, 1);
  });

  it("returns 404 when the task belongs to a different org", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue({ id: 7, orgId: 2 });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(404);
  });
});
