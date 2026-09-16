// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrReview } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { PrReviewPanel } from "../PrReviewPanel";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function fakeReview(overrides: Partial<PrReview> = {}): PrReview {
  return {
    id: 1,
    orgId: 1,
    taskId: 7,
    runId: 100,
    repoFullName: "acme-org/platform",
    prNumber: 42,
    baseSha: "base",
    headSha: "head",
    status: "posted",
    verdict: "comment",
    summary: "Looks good overall.",
    comments: [],
    postedAs: "comment",
    githubReviewId: "555",
    url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
    commentCount: 3,
    truncated: false,
    createdAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(taskId = 7, runStatus: string | null = null) {
  return render(
    <I18nProvider>
      <PrReviewPanel taskId={taskId} runStatus={runStatus} />
    </I18nProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("PrReviewPanel", () => {
  it("renders nothing when there are no reviews", async () => {
    apiFetchMock.mockResolvedValue([]);
    const { container } = renderPanel();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows the latest review's verdict, comment count, and GitHub link", async () => {
    apiFetchMock.mockResolvedValue([fakeReview()]);
    renderPanel();
    expect(await screen.findByText(/Comment/)).toBeInTheDocument();
    expect(screen.getByText(/3 inline comments/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on GitHub/i })).toHaveAttribute(
      "href",
      "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
    );
  });

  it("shows the fallback note when postedAs differs from verdict", async () => {
    apiFetchMock.mockResolvedValue([fakeReview({ verdict: "request_changes", postedAs: "comment" })]);
    renderPanel();
    expect(await screen.findByText(/posted as a comment/i)).toBeInTheDocument();
  });

  it("shows the large-diff caveat when truncated", async () => {
    apiFetchMock.mockResolvedValue([fakeReview({ truncated: true })]);
    renderPanel();
    expect(await screen.findByText(/very large/i)).toBeInTheDocument();
  });

  it("surfaces a load failure instead of silently rendering as if there's no review", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    const { container } = renderPanel();

    await waitFor(() => expect(screen.getByText(/Couldn't load the review/i)).toBeInTheDocument());
    // Distinct from the "no reviews" case, which renders nothing at all.
    expect(container.textContent).not.toBe("");
  });

  it("shows Approve/Discard actions for a pending review and no GitHub link yet", async () => {
    apiFetchMock.mockResolvedValueOnce([fakeReview({ status: "pending", url: undefined, postedAs: undefined, githubReviewId: undefined })]);
    renderPanel();

    expect(await screen.findByText(/Pending approval/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve & post to GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Discard/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /View on GitHub/i })).not.toBeInTheDocument();
  });

  it("approving a pending review posts it and switches to the posted view", async () => {
    const pending = fakeReview({ status: "pending", url: undefined, postedAs: undefined, githubReviewId: undefined });
    apiFetchMock.mockResolvedValueOnce([pending]);
    renderPanel();
    const approveButton = await screen.findByRole("button", { name: /Approve & post to GitHub/i });

    apiFetchMock.mockResolvedValueOnce(fakeReview({ status: "posted" }));
    fireEvent.click(approveButton);

    expect(await screen.findByRole("link", { name: /View on GitHub/i })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/pr-reviews/1/approve", { method: "POST" });
  });

  it("refetches when runStatus changes, so a review drafted after mount still appears", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    const { rerender } = render(
      <I18nProvider>
        <PrReviewPanel taskId={7} runStatus="running" />
      </I18nProvider>,
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    apiFetchMock.mockResolvedValueOnce([fakeReview({ status: "pending", url: undefined, postedAs: undefined, githubReviewId: undefined })]);
    rerender(
      <I18nProvider>
        <PrReviewPanel taskId={7} runStatus="done" />
      </I18nProvider>,
    );

    expect(await screen.findByText(/Pending approval/i)).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("discarding a pending review switches to the discarded view", async () => {
    const pending = fakeReview({ status: "pending", url: undefined, postedAs: undefined, githubReviewId: undefined });
    apiFetchMock.mockResolvedValueOnce([pending]);
    renderPanel();
    const discardButton = await screen.findByRole("button", { name: /^Discard$/i });

    apiFetchMock.mockResolvedValueOnce(fakeReview({ status: "discarded" }));
    fireEvent.click(discardButton);

    expect(await screen.findByText(/Discarded — never posted to GitHub/i)).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/pr-reviews/1/discard", { method: "POST" });
  });
});
