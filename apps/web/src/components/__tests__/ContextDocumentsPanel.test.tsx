// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgMember, TaskContextItem, TeamContextItem } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { ContextDocumentsPanel, type ContextDocumentsScope } from "../ContextDocumentsPanel";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const MEMBERS: OrgMember[] = [
  {
    userId: 5,
    orgId: 1,
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  },
];

const ITEM: TeamContextItem = {
  id: 1,
  teamId: 3,
  orgId: 1,
  title: "Engineering handbook",
  sizeBytes: 18200,
  sha256: "a".repeat(64),
  mime: "text/markdown",
  source: "upload",
  status: "pending",
  uploadedBy: 5,
  createdAt: "2026-08-27T10:00:00.000Z",
};

const TEAM_SCOPE: ContextDocumentsScope = { kind: "team", teamId: 3 };
const TASK_SCOPE: ContextDocumentsScope = { kind: "task", taskId: 9 };

const TASK_ITEM: TaskContextItem = {
  id: 1,
  taskId: 9,
  orgId: 1,
  title: "Migration runbook",
  sizeBytes: 4200,
  sha256: "b".repeat(64),
  mime: "text/markdown",
  source: "upload",
  status: "pending",
  uploadedBy: 5,
  createdAt: "2026-08-27T10:00:00.000Z",
};

function renderPanel(scope: ContextDocumentsScope = TEAM_SCOPE) {
  return render(
    <I18nProvider>
      <ContextDocumentsPanel scope={scope} members={MEMBERS} />
    </I18nProvider>,
  );
}

function markdownFile(name = "runbook.md", contents = "# Runbook") {
  return new File([contents], name, { type: "text/markdown" });
}

beforeEach(() => apiFetchMock.mockReset());

describe("ContextDocumentsPanel", () => {
  it("asks for the team's documents and shows the empty state when there are none", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderPanel();

    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/teams/3/context-items");
  });

  it("lists a document with its size, uploader and status", async () => {
    apiFetchMock.mockResolvedValue([ITEM]);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Engineering handbook")).toBeInTheDocument());
    expect(screen.getByText(/17\.8 KB/)).toBeInTheDocument();
    expect(screen.getByText(/Uploaded by Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  // "Failed" alone says nothing actionable; Badge has no danger tone, so the message from
  // ingestion is rendered inline underneath instead.
  it("renders a failed document's message inline", async () => {
    apiFetchMock.mockResolvedValue([
      { ...ITEM, status: "failed", error: "Could not read the file as UTF-8 text" },
    ]);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
    expect(
      screen.getByText("Indexing failed: Could not read the file as UTF-8 text"),
    ).toBeInTheDocument();
  });

  it("refuses a file over the 2 MB cap without calling the API", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    const file = markdownFile("huge.md");
    // Faked rather than allocated: the assertion is about the size check, not about jsdom's
    // willingness to hold 2 MB in memory.
    Object.defineProperty(file, "size", { value: 2 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [file] } });

    await waitFor(() =>
      expect(screen.getByText("That file is larger than the 2 MB limit.")).toBeInTheDocument(),
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1); // the initial list, and nothing else
  });

  it("refuses a file type ingestion cannot read", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    const file = new File(["%PDF-1.7"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [file] } });

    await waitFor(() =>
      expect(
        screen.getByText("Only Markdown (.md) and plain text (.txt) files can be uploaded."),
      ).toBeInTheDocument(),
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads a Markdown file as multipart and shows the new document", async () => {
    apiFetchMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ...ITEM, id: 2, title: "runbook.md", sizeBytes: 9 });
    renderPanel();
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [markdownFile()] } });

    await waitFor(() => expect(screen.getByText("runbook.md")).toBeInTheDocument());
    const [path, init] = apiFetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/teams/3/context-items");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
    expect((init.body as FormData).get("title")).toBe("runbook.md");
  });

  it("surfaces one translated line when the server rejects the upload", async () => {
    apiFetchMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("This document has already been uploaded to this team"));
    renderPanel();
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [markdownFile()] } });

    await waitFor(() =>
      expect(
        screen.getByText("Couldn't upload that file — it may already be in this team's documents."),
      ).toBeInTheDocument(),
    );
  });

  // The reviewer's finding: some OS/browser combos never populate file.type for a .md file (""
  // locally, or "application/octet-stream" once the File round-trips through FormData). This is
  // exactly the PR's headline scenario, so it must not be rejected, and what goes out over the
  // wire must carry the corrected mime, not the browser's unreliable one.
  it("accepts a .md file with an unreliable declared mime and sends the normalized mime", async () => {
    apiFetchMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ...ITEM, id: 2, title: "runbook.md", sizeBytes: 9 });
    renderPanel();
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    const file = new File(["# Runbook"], "runbook.md", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("runbook.md")).toBeInTheDocument());
    const [, init] = apiFetchMock.mock.calls[1] as [string, RequestInit];
    const uploaded = (init.body as FormData).get("file") as File;
    expect(uploaded.type).toBe("text/markdown");
  });

  it("removes a document", async () => {
    apiFetchMock.mockResolvedValueOnce([ITEM]).mockResolvedValueOnce(undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByText("Engineering handbook")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/teams/3/context-items/1", { method: "DELETE" });
  });

  it("polls again while a document is pending, and stops once it reaches a terminal state", async () => {
    vi.useFakeTimers();
    try {
      apiFetchMock.mockResolvedValueOnce([ITEM]); // initial GET on mount, status: pending

      renderPanel();

      // Flush the mount-time fetch effect.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Engineering handbook")).toBeInTheDocument();
      expect(apiFetchMock).toHaveBeenCalledTimes(1);

      // One poll tick fires while the item is still pending — a second list-fetch.
      apiFetchMock.mockResolvedValueOnce([ITEM]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(apiFetchMock).toHaveBeenCalledTimes(2);

      // The next tick reports the item as indexed — a terminal status.
      apiFetchMock.mockResolvedValueOnce([{ ...ITEM, status: "indexed" as const }]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(apiFetchMock).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Indexed")).toBeInTheDocument();

      // Further ticks must NOT issue another GET — the assertion that would catch a poll that
      // never stops once every item is terminal.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000 * 5);
      });
      expect(apiFetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Same component, task scope: only the route base and the copy naming the scope explicitly
// should differ from the team-scope suite above — everything else (upload, delete, polling,
// status badges) is exercised there and is not re-tested here.
describe("ContextDocumentsPanel with task scope", () => {
  it("asks for the task's documents and shows a task-specific empty state", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderPanel(TASK_SCOPE);

    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/tasks/9/context-items");
    expect(
      screen.getByText("Upload a Markdown or text file to give this task's agent something to draw on."),
    ).toBeInTheDocument();
  });

  it("lists a task document", async () => {
    apiFetchMock.mockResolvedValue([TASK_ITEM]);
    renderPanel(TASK_SCOPE);

    await waitFor(() => expect(screen.getByText("Migration runbook")).toBeInTheDocument());
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("uploads a file to the task-scoped route", async () => {
    apiFetchMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ...TASK_ITEM, id: 2, title: "runbook.md", sizeBytes: 9 });
    renderPanel(TASK_SCOPE);
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [markdownFile()] } });

    await waitFor(() => expect(screen.getByText("runbook.md")).toBeInTheDocument());
    const [path, init] = apiFetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/tasks/9/context-items");
    expect(init.method).toBe("POST");
  });

  it("surfaces the task-specific line when the server rejects the upload", async () => {
    apiFetchMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("This document has already been uploaded to this task"));
    renderPanel(TASK_SCOPE);
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [markdownFile()] } });

    await waitFor(() =>
      expect(
        screen.getByText("Couldn't upload that file — it may already be attached to this task."),
      ).toBeInTheDocument(),
    );
  });

  it("removes a task document from the task-scoped route", async () => {
    apiFetchMock.mockResolvedValueOnce([TASK_ITEM]).mockResolvedValueOnce(undefined);
    renderPanel(TASK_SCOPE);
    await waitFor(() => expect(screen.getByText("Migration runbook")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/tasks/9/context-items/1", { method: "DELETE" });
  });

  it("shows the task-specific line when the list can't be loaded", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    renderPanel(TASK_SCOPE);

    await waitFor(() => expect(screen.getByText("Couldn't load this task's documents.")).toBeInTheDocument());
  });
});
