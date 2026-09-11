// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { SkillAgentsPicker, type SkillAssignment } from "../SkillAgentsPicker";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const AGENTS: Agent[] = [
  { id: 1, orgId: 1, name: "Coding agent" } as Agent,
  { id: 2, orgId: 1, name: "Review agent" } as Agent,
];

const ASSIGNMENTS: SkillAssignment[] = [{ agentId: 1, agentName: "Coding agent", skillVersionId: 10, version: 2 }];

function mockApi(agents: Agent[] = AGENTS) {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve({ agentId: 2, skillId: 9, skillVersionId: 11, createdAt: "2026-01-01T00:00:00.000Z" });
    }
    if (init?.method === "DELETE") return Promise.resolve(undefined);
    if (path === "/api/agents") return Promise.resolve(agents);
    return Promise.resolve(undefined);
  });
}

function renderPicker(assignments = ASSIGNMENTS) {
  const onAssignmentsChange = vi.fn();
  render(
    <I18nProvider>
      <SkillAgentsPicker
        skillId={9}
        currentVersionNumber={3}
        assignments={assignments}
        onAssignmentsChange={onAssignmentsChange}
      />
    </I18nProvider>,
  );
  return { onAssignmentsChange };
}

beforeEach(() => apiFetchMock.mockReset());

describe("SkillAgentsPicker", () => {
  it("shows every org agent, checked for the ones assigned to this skill", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Coding agent/ })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: /Review agent/ })).not.toBeChecked();
  });

  it("shows the pinned version badge for an assigned agent", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
  });

  it("assigns the skill to an agent when its checkbox is checked", async () => {
    mockApi();
    const { onAssignmentsChange } = renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Review agent/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Review agent/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/2/skills", {
        method: "POST",
        body: JSON.stringify({ skillId: 9 }),
      }),
    );
    expect(onAssignmentsChange).toHaveBeenCalledWith([
      ...ASSIGNMENTS,
      { agentId: 2, agentName: "Review agent", skillVersionId: 11, version: 3 },
    ]);
  });

  it("unassigns the skill from an agent when its checkbox is unchecked", async () => {
    mockApi();
    const { onAssignmentsChange } = renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Coding agent/ })).toBeChecked());

    fireEvent.click(screen.getByRole("checkbox", { name: /Coding agent/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/1/skills/9", { method: "DELETE" }),
    );
    expect(onAssignmentsChange).toHaveBeenCalledWith([]);
  });

  it("shows an error when a toggle fails", async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.reject(new Error("boom"));
      if (path === "/api/agents") return Promise.resolve(AGENTS);
      return Promise.resolve(undefined);
    });
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Review agent/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Review agent/ }));

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });
});
