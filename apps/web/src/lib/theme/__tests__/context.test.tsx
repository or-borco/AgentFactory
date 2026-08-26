// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "../context";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const notifyMock = vi.fn();
vi.mock("@/lib/mock/context", () => ({ useMockBackend: () => ({ notify: notifyMock }) }));

function ThemeProbe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button onClick={() => setTheme("light")}>go light</button>
      <button onClick={() => setTheme("dark")}>go dark</button>
    </div>
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  notifyMock.mockReset();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeProvider / useTheme", () => {
  it("initializes theme state and the data-theme attribute from initialTheme", () => {
    render(
      <ThemeProvider initialTheme="dark">
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
  });

  it("switching themes updates state, sets data-theme on <html>, and PATCHes the server", async () => {
    apiFetchMock.mockResolvedValue({});
    render(
      <ThemeProvider initialTheme="dark">
        <ThemeProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByText("go light").click());

    expect(screen.getByTestId("theme-value")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ themePreference: "light" }),
      }),
    );
  });

  it("rolls back the theme and DOM attribute and notifies on a failed save", async () => {
    apiFetchMock.mockRejectedValue(new Error("network error"));
    render(
      <ThemeProvider initialTheme="dark">
        <ThemeProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByText("go light").click());
    // Optimistic update applies immediately, before the rejected fetch resolves.
    expect(screen.getByTestId("theme-value")).toHaveTextContent("light");

    await waitFor(() => expect(notifyMock).toHaveBeenCalledWith("toast.error"));
    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("throws when useTheme is used outside a ThemeProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ThemeProbe />)).toThrow("useTheme must be used within ThemeProvider");
    spy.mockRestore();
  });
});
