// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "../context";
import { themeStorageKey } from "../theme";

// jsdom doesn't implement matchMedia. This stub tracks the "change" listener the provider
// registers for the "system" preference so tests can simulate an OS theme change.
function mockMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_event: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_event: string, cb: () => void) => listeners.delete(cb),
  })) as unknown as typeof window.matchMedia;

  return {
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb());
    },
  };
}

function Probe() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setPreference("light")}>light</button>
      <button onClick={() => setPreference("dark")}>dark</button>
      <button onClick={() => setPreference("system")}>system</button>
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to system preference and resolves dark when the OS prefers dark", () => {
    mockMatchMedia(false);
    renderProbe();
    expect(screen.getByTestId("preference")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("resolves light when the OS prefers light", () => {
    mockMatchMedia(true);
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("reads a previously stored explicit preference on mount, overriding the OS setting", () => {
    window.localStorage.setItem(themeStorageKey, "light");
    mockMatchMedia(false); // OS prefers dark, but the stored explicit preference should win
    renderProbe();
    expect(screen.getByTestId("preference")).toHaveTextContent("light");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("ignores a corrupt/unknown stored value and falls back to system", () => {
    window.localStorage.setItem(themeStorageKey, "sepia");
    mockMatchMedia(true);
    renderProbe();
    expect(screen.getByTestId("preference")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("setPreference updates state, the DOM attribute, and persists to localStorage", () => {
    mockMatchMedia(false);
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "light" }));

    expect(screen.getByTestId("preference")).toHaveTextContent("light");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(themeStorageKey)).toBe("light");
  });

  it("reacts to OS theme changes while the preference is system", () => {
    const media = mockMatchMedia(false);
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");

    act(() => media.setMatches(true));

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stops reacting to OS changes once an explicit preference is set", () => {
    const media = mockMatchMedia(false);
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");

    act(() => media.setMatches(true));

    // Explicit "dark" preference should not be overridden by the OS switching to light.
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("throws when useTheme is called outside a ThemeProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useTheme must be used within ThemeProvider");
    spy.mockRestore();
  });
});
