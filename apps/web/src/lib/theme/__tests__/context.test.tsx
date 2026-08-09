// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { ThemeProvider, useTheme, type Theme } from "../context";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

// Test component that uses the theme hook
function ThemeTestComponent() {
  const { theme, toggleTheme, setTheme } = useTheme();

  return (
    <div>
      <div data-testid="theme-display">{theme}</div>
      <button onClick={() => toggleTheme()}>Toggle Theme</button>
      <button onClick={() => setTheme("light")}>Set Light</button>
      <button onClick={() => setTheme("dark")}>Set Dark</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("provides theme context to children", () => {
    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    const themeDisplay = screen.getByTestId("theme-display");
    expect(themeDisplay).toBeInTheDocument();
  });

  it("initializes with dark theme as default", async () => {
    // Mock matchMedia to not match light preference
    window.matchMedia = vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: light)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as any;

    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme-display").textContent).toBe("dark");
    });
  });

  it("respects saved theme from localStorage", async () => {
    localStorage.setItem("agentfactory-theme", "light");

    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme-display").textContent).toBe("light");
    });
  });

  it("detects system preference for light theme", async () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: light)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as any;

    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme-display").textContent).toBe("light");
    });
  });

  it("detects system preference for dark theme", async () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as any;

    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme-display").textContent).toBe("dark");
    });
  });

  it("toggles theme between light and dark", async () => {
    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    const themeDisplay = screen.getByTestId("theme-display");
    const toggleButton = screen.getByRole("button", { name: "Toggle Theme" });

    await waitFor(() => {
      const currentTheme = themeDisplay.textContent as Theme;
      expect(["light", "dark"]).toContain(currentTheme);
    });

    const initialTheme = themeDisplay.textContent;

    fireEvent.click(toggleButton);

    await waitFor(() => {
      const newTheme = themeDisplay.textContent;
      expect(newTheme).not.toBe(initialTheme);
    });
  });

  it("allows setting theme explicitly", async () => {
    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    const themeDisplay = screen.getByTestId("theme-display");
    const setLightButton = screen.getByRole("button", { name: "Set Light" });

    fireEvent.click(setLightButton);

    await waitFor(() => {
      expect(themeDisplay.textContent).toBe("light");
    });

    const setDarkButton = screen.getByRole("button", { name: "Set Dark" });
    fireEvent.click(setDarkButton);

    await waitFor(() => {
      expect(themeDisplay.textContent).toBe("dark");
    });
  });

  it("persists theme choice to localStorage", async () => {
    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    const setLightButton = screen.getByRole("button", { name: "Set Light" });
    fireEvent.click(setLightButton);

    await waitFor(() => {
      expect(localStorage.getItem("agentfactory-theme")).toBe("light");
    });

    const setDarkButton = screen.getByRole("button", { name: "Set Dark" });
    fireEvent.click(setDarkButton);

    await waitFor(() => {
      expect(localStorage.getItem("agentfactory-theme")).toBe("dark");
    });
  });

  it("applies dark class to html element when theme is dark", async () => {
    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    const setDarkButton = screen.getByRole("button", { name: "Set Dark" });
    fireEvent.click(setDarkButton);

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });
  });

  it("removes dark class from html element when theme is light", async () => {
    render(
      <ThemeProvider>
        <ThemeTestComponent />
      </ThemeProvider>,
    );

    const setLightButton = screen.getByRole("button", { name: "Set Light" });
    fireEvent.click(setLightButton);

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });

  it("throws when useTheme is used outside of ThemeProvider", () => {
    // Suppress console.error for this test
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<ThemeTestComponent />);
    }).toThrow("useTheme must be used within ThemeProvider");

    consoleErrorSpy.mockRestore();
  });
});
