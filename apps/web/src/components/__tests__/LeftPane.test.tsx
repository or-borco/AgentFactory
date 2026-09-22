// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { User } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { LeftPane } from "../LeftPane";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
}));

vi.mock("@/lib/app-data/context", () => ({
  useAppData: () => ({ toast: null }),
}));

const user: User = { id: 1, email: "ada@example.com", name: "Ada Lovelace" };

vi.mock("@/lib/auth/context", () => ({
  useAuth: () => ({ user, logout: vi.fn() }),
}));

function renderLeftPane() {
  render(
    <I18nProvider>
      <LeftPane>
        <div>content</div>
      </LeftPane>
    </I18nProvider>,
  );
}

describe("LeftPane", () => {
  it("labels the settings nav link as Configuration", () => {
    renderLeftPane();
    expect(screen.getByRole("link", { name: "Configuration" })).toHaveAttribute("href", "/settings");
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });
});
