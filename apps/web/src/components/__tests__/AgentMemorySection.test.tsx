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

  describe("history panel", () => {
    const RETRO_INSERT = {
      id: 11,
      kind: "insert",
      source: "retrospective",
      createdAt: "2026-09-20T00:00:00.000Z",
      lesson: "Run the tests before a PR.",
      reason: "CI failed on the first PR.",
      session: { id: 71 },
      task: { id: 163, ref: "T-163", title: "Add divide()" },
    };
    const EDIT = {
      id: 12,
      kind: "edit",
      createdAt: "2026-09-21T00:00:00.000Z",
      lesson: "Run the test suite before opening a PR.",
      editedBy: { id: 1, name: "Dana" },
    };

    function routeFetch(writes: unknown) {
      apiFetchMock.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith("/writes") ? writes : [ENTRY_TWO]),
      );
    }

    it("loads history only when expanded", async () => {
      routeFetch([RETRO_INSERT]);
      renderSection();
      await screen.findByText("Run the test suite before opening a PR.");

      expect(apiFetchMock).not.toHaveBeenCalledWith("/api/agents/5/memory/2/writes");
      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));

      expect(await screen.findByText("CI failed on the first PR.")).toBeInTheDocument();
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/memory/2/writes");
      expect(screen.getByText("Run the tests before a PR.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "From: T-163 · Add divide()" })).toHaveAttribute("href", "/tasks/163");
    });

    it("does not refetch when collapsed and expanded again", async () => {
      routeFetch([RETRO_INSERT]);
      renderSection();
      await screen.findByText("Run the test suite before opening a PR.");

      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));
      await screen.findByText("CI failed on the first PR.");
      fireEvent.click(screen.getByRole("button", { name: "Hide history" }));
      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));
      await screen.findByText("CI failed on the first PR.");

      expect(apiFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/writes"))).toHaveLength(1);
    });

    it("marks rows older than the newest edit and names the editor", async () => {
      routeFetch([EDIT, RETRO_INSERT]);
      renderSection();
      await screen.findByText("Run the test suite before opening a PR.");

      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));

      expect(await screen.findByText(/Edited by Dana/)).toBeInTheDocument();
      const markers = screen.getAllByText(/\(before edit\)/);
      expect(markers).toHaveLength(1);
      expect(markers[0].closest("li")).toHaveTextContent("CI failed on the first PR.");
    });

    it("falls back to the session link when the task is gone", async () => {
      routeFetch([{ ...RETRO_INSERT, task: undefined }]);
      renderSection();
      await screen.findByText("Run the test suite before opening a PR.");

      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));

      expect(await screen.findByRole("link", { name: "From: session 71" })).toHaveAttribute("href", "/sessions/71");
    });

    it("shows the empty state for an entry with no recorded history", async () => {
      routeFetch([]);
      renderSection();
      await screen.findByText("Run the test suite before opening a PR.");

      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));

      expect(await screen.findByText("No history recorded for this entry.")).toBeInTheDocument();
    });

    it("shows an unreadable row without failing the panel", async () => {
      routeFetch([{ id: 13, kind: "insert", source: "retrospective", createdAt: "2026-09-20T00:00:00.000Z", decryptError: true }, EDIT]);
      renderSection();
      await screen.findByText("Run the test suite before opening a PR.");

      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));

      expect(await screen.findByText("This record couldn't be read.")).toBeInTheDocument();
      expect(screen.getByText(/Edited by Dana/)).toBeInTheDocument();
    });

    it("labels the toggle History for a manual entry", async () => {
      apiFetchMock.mockResolvedValueOnce([ENTRY_ONE]);
      renderSection();
      await screen.findByText("Never push directly to main.");

      expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
    });

    it("notes when only the latest 20 changes are shown", async () => {
      routeFetch(Array.from({ length: 20 }, (_, i) => ({ ...RETRO_INSERT, id: 100 + i, kind: "reinforce" })));
      renderSection();
      await screen.findByText("Run the test suite before opening a PR.");

      fireEvent.click(screen.getByRole("button", { name: "Why was this learned?" }));

      expect(await screen.findByText("Showing only the latest 20 changes.")).toBeInTheDocument();
    });
  });
});
