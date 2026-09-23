// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { CodebaseSetupSettings } from "../CodebaseSetupSettings";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const REPOS = [
  { id: "1", fullName: "acme/widgets", provider: "github" },
  { id: "2", fullName: "acme/legacy", provider: "github" },
];

function mockLoad(settings: Array<{ repoFullName: string; setupCommand: string | null }>) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/connections/repos") return REPOS;
    if (path === "/api/codebases/settings" && !init) return settings;
    const body = JSON.parse(String(init?.body));
    return { repoFullName: body.repoFullName, setupCommand: body.setupCommand };
  });
}

function renderSettings() {
  return render(
    <I18nProvider>
      <CodebaseSetupSettings />
    </I18nProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("CodebaseSetupSettings", () => {
  it("shows every codebase with its saved override", async () => {
    mockLoad([{ repoFullName: "acme/legacy", setupCommand: "./bootstrap.sh" }]);
    renderSettings();

    expect(await screen.findByLabelText("acme/legacy")).toHaveValue("./bootstrap.sh");
    expect(screen.getByLabelText("acme/widgets")).toHaveValue("");
  });

  it("saves a new override for one codebase", async () => {
    mockLoad([]);
    renderSettings();

    const input = await screen.findByLabelText("acme/widgets");
    fireEvent.change(input, { target: { value: "  make deps  " } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/codebases/settings", {
        method: "PUT",
        body: JSON.stringify({ repoFullName: "acme/widgets", setupCommand: "make deps" }),
      }),
    );
    expect(await screen.findByText(/Takes effect on the next agent turn/)).toBeInTheDocument();
  });

  it("clears an override by saving an empty command", async () => {
    mockLoad([{ repoFullName: "acme/legacy", setupCommand: "./bootstrap.sh" }]);
    renderSettings();

    const input = await screen.findByLabelText("acme/legacy");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]!);

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/codebases/settings", {
        method: "PUT",
        body: JSON.stringify({ repoFullName: "acme/legacy", setupCommand: null }),
      }),
    );
  });

  it("keeps Save disabled until the command changes", async () => {
    mockLoad([]);
    renderSettings();

    await screen.findByLabelText("acme/widgets");
    for (const button of screen.getAllByRole("button", { name: "Save" })) expect(button).toBeDisabled();
  });

  it("shows a message when there are no codebases", async () => {
    apiFetchMock.mockImplementation(async (path: string) => (path === "/api/connections/repos" ? [] : []));
    renderSettings();

    expect(await screen.findByText(/No codebases yet/)).toBeInTheDocument();
  });
});
