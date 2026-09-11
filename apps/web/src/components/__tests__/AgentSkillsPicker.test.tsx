// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { AgentSkillsPicker } from "../AgentSkillsPicker";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const SKILLS: Skill[] = [
  {
    id: 1,
    orgId: 1,
    name: "Code review",
    slug: "code-review",
    description: "",
    source: "authored",
    currentVersionId: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 2,
    orgId: 1,
    name: "Onboarding",
    slug: "onboarding",
    description: "",
    source: "authored",
    currentVersionId: 20,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 3,
    orgId: 1,
    name: "Release notes",
    slug: "release-notes",
    description: "",
    source: "authored",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const ASSIGNED = [
  { agentId: 5, skillId: 1, skillVersionId: 10, skillName: "Code review", skillSlug: "code-review", version: 2 },
];

// path.startsWith below is String(path).startsWith rather than a bare path.startsWith: this
// test harness (React 19 + RTL 16 + Vitest 4) issues one extra apiFetch call with undefined
// arguments during unmount/cleanup. apps/web/src/components/__tests__/RunContextPanel.test.tsx
// works around the same quirk the same way (String(path).endsWith(...)); a bare path.startsWith
// crashes on that phantom call with "Cannot read properties of undefined (reading 'startsWith')".
function mockApi({ assigned = ASSIGNED, skills = SKILLS } = {}) {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve({});
    if (init?.method === "DELETE") return Promise.resolve(undefined);
    if (path === "/api/agents/5/skills") return Promise.resolve(assigned);
    if (path === "/api/skills") return Promise.resolve(skills);
    if (String(path).startsWith("/api/skills/")) {
      const id = Number(path.split("/").pop());
      return Promise.resolve({ skill: skills.find((s) => s.id === id), versions: [] });
    }
    return Promise.resolve(undefined);
  });
}

function renderPicker() {
  return render(
    <I18nProvider>
      <AgentSkillsPicker agentId={5} />
    </I18nProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("AgentSkillsPicker", () => {
  it("shows every org skill, checked for the ones assigned to this agent", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Code review/ })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: /Onboarding/ })).not.toBeChecked();
  });

  it("assigns a skill when its checkbox is checked", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Onboarding/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Onboarding/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/skills", {
        method: "POST",
        body: JSON.stringify({ skillId: 2 }),
      }),
    );
  });

  it("unassigns a skill when its checkbox is unchecked", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Code review/ })).toBeChecked());

    fireEvent.click(screen.getByRole("checkbox", { name: /Code review/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/skills/1", { method: "DELETE" }),
    );
  });

  it("disables an unpublished skill's checkbox and labels it Draft only", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Release notes/ })).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: /Release notes/ })).toBeDisabled();
    expect(screen.getByText("Draft only")).toBeInTheDocument();
  });

  it("shows an error when a toggle fails", async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.reject(new Error("boom"));
      if (path === "/api/agents/5/skills") return Promise.resolve(ASSIGNED);
      if (path === "/api/skills") return Promise.resolve(SKILLS);
      // The already-assigned skill (id 1) triggers a per-skill version lookup on every
      // render of the assigned list; this branch must resolve it the same way mockApi()
      // does, or that lookup rejects with an unhandled promise rejection instead of the
      // toggle failure this test is actually about.
      if (String(path).startsWith("/api/skills/")) {
        const id = Number(path.split("/").pop());
        return Promise.resolve({ skill: SKILLS.find((s) => s.id === id), versions: [] });
      }
      return Promise.resolve(undefined);
    });
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Onboarding/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Onboarding/ }));

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    // There's no optimistic update to revert: state is only set after a successful response, so
    // a failed toggle simply means the checkbox never becomes checked in the first place.
    expect(screen.getByRole("checkbox", { name: /Onboarding/ })).not.toBeChecked();
  });
});
