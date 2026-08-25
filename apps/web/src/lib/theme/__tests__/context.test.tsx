// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "../context";

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

describe("ThemeProvider / useTheme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    // jsdom doesn't implement matchMedia; stub it to report no light-mode preference so
    // "system" has a deterministic resolution in tests.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  it("defaults to dark before the stored preference is read", () => {
    renderProbe();
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });

  it("picks up a previously stored preference on mount", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    await act(async () => {
      renderProbe();
    });
    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
  });

  it("updates the theme, persists it, and applies it to <html data-theme>", () => {
    renderProbe();

    act(() => screen.getByText("light").click());
    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => screen.getByText("dark").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("resolves 'system' against matchMedia", () => {
    renderProbe();
    act(() => screen.getByText("system").click());

    expect(screen.getByTestId("theme").textContent).toBe("system");
    // jsdom's matchMedia (see vitest-setup) reports no light preference by default, so
    // "system" resolves to "dark".
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("throws when useTheme is used outside a ThemeProvider", () => {
    const Broken = () => {
      useTheme();
      return null;
    };
    expect(() => render(<Broken />)).toThrow("useTheme must be used within a ThemeProvider");
  });
});
