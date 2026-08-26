// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { SettingsView } from "../SettingsView";

const setThemeMock = vi.fn();
let currentTheme: "dark" | "light" = "dark";
vi.mock("@/lib/theme/context", () => ({
  useTheme: () => ({ theme: currentTheme, setTheme: setThemeMock }),
}));

// ConnectionsList pulls from the (unrelated, org-scoped) mock backend — stub it out so this test
// stays focused on the Appearance section instead of also standing up that data layer.
vi.mock("@/components/ConnectionsList", () => ({ ConnectionsList: () => null }));

function renderSettings() {
  return render(
    <I18nProvider>
      <SettingsView orgName="Acme" orgSlug="acme" github={{ configured: false }} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  setThemeMock.mockReset();
  currentTheme = "dark";
});

describe("SettingsView — Appearance", () => {
  it("renders Dark and Light options", () => {
    renderSettings();
    expect(screen.getByRole("radio", { name: /Dark/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Light/i })).toBeInTheDocument();
  });

  it("marks the current theme as checked", () => {
    currentTheme = "light";
    renderSettings();
    expect(screen.getByRole("radio", { name: /Light/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Dark/i })).toHaveAttribute("aria-checked", "false");
  });

  it("calls setTheme with 'light' when the Light option is clicked", () => {
    renderSettings();
    screen.getByRole("radio", { name: /Light/i }).click();
    expect(setThemeMock).toHaveBeenCalledWith("light");
  });

  it("calls setTheme with 'dark' when the Dark option is clicked", () => {
    currentTheme = "light";
    renderSettings();
    screen.getByRole("radio", { name: /Dark/i }).click();
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });
});
