// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgMember, TeamContextItem } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { ContextDocumentsPanel } from "../ContextDocumentsPanel";

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

function renderPanel() {
  return render(
    <I18nProvider>
      <ContextDocumentsPanel teamId={3} members={MEMBERS} />
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
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  // "Failed" alone says nothing actionable; Badge has no danger tone, so the message from
  // ingestion is rendered inline underneath instead.
  it("renders a failed document's message inline", async () => {
    apiFetchMock.mockResolvedValue([
      { ...ITEM, status: "failed", error: "Could not read the file as UTF-8 text" },
    ]);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
    expect(screen.getByText("Could not read the file as UTF-8 text")).toBeInTheDocument();
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

  it("removes a document", async () => {
    apiFetchMock.mockResolvedValueOnce([ITEM]).mockResolvedValueOnce(undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByText("Engineering handbook")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/teams/3/context-items/1", { method: "DELETE" });
  });
});
