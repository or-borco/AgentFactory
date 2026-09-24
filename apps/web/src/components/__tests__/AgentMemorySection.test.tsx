// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { AgentMemorySection } from "../AgentMemorySection";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function renderSection(agentId = 5) {
  return render(
    <I18nProvider>
      <AgentMemorySection agentId={agentId} />
    </I18nProvider>,
  );
}

const ENTRY_ONE = {
  id: 1,
  agentId: 5,
  orgId: 3,
  source: "manual" as const,
  weight: 1,
  content: "Never push directly to main.",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastReinforcedAt: "2026-09-01T00:00:00.000Z",
};

const ENTRY_TWO = {
  id: 2,
  agentId: 5,
  orgId: 3,
  source: "retrospective" as const,
  weight: 3,
  content: "Run the test suite before opening a PR.",
  createdAt: "2026-08-20T00:00:00.000Z",
  lastReinforcedAt: "2026-09-10T00:00:00.000Z",
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("AgentMemorySection", () => {
  it("shows the empty state when there are no entries", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderSection();

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/memory"));
    expect(await screen.findByText(/No memory entries yet/)).toBeInTheDocument();
  });

  it("renders each entry's content, source, and reinforcement count", async () => {
    apiFetchMock.mockResolvedValue([ENTRY_ONE, ENTRY_TWO]);
    renderSection();

    expect(await screen.findByText("Never push directly to main.")).toBeInTheDocument();
    expect(screen.getByText("Run the test suite before opening a PR.")).toBeInTheDocument();
    expect(screen.getByText(/Reinforced 3x/)).toBeInTheDocument();
  });

  it("edits an entry's content", async () => {
    apiFetchMock.mockResolvedValueOnce([ENTRY_ONE]);
    apiFetchMock.mockResolvedValueOnce(undefined); // PATCH response
    renderSection();
    await screen.findByText("Never push directly to main.");

    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Never push directly to main, always PR." } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/memory/1", {
        method: "PATCH",
        body: JSON.stringify({ content: "Never push directly to main, always PR." }),
      }),
    );
  });

  it("deletes an entry", async () => {
    apiFetchMock.mockResolvedValueOnce([ENTRY_ONE]);
    apiFetchMock.mockResolvedValueOnce(undefined); // DELETE response
    renderSection();
    await screen.findByText("Never push directly to main.");

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/memory/1", { method: "DELETE" }),
    );
    await waitFor(() => expect(screen.queryByText("Never push directly to main.")).not.toBeInTheDocument());
  });

  it("shows a load error when the initial fetch fails", async () => {
    apiFetchMock.mockRejectedValue(new Error("network down"));
    renderSection();

    expect(await screen.findByText(/Couldn't load this agent's memory/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("keeps the entries list visible when a delete fails", async () => {
    apiFetchMock.mockResolvedValueOnce([ENTRY_ONE]);
    apiFetchMock.mockRejectedValueOnce(new Error("network down")); // DELETE response
    renderSection();
    await screen.findByText("Never push directly to main.");

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    // The delete failed, so `entries` is still the populated array it was before the click:
    // the section must still be rendering that row (its delete-confirm copy), not have
    // collapsed the whole entries-driven branch to nothing but the error banner.
    expect(await screen.findByText(/Couldn't delete that entry/)).toBeInTheDocument();
    expect(screen.getByText("Delete this memory entry?")).toBeInTheDocument();
    expect(screen.getByText("Told to remember")).toBeInTheDocument();
  });
});
