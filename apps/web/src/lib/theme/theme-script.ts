// Runs before hydration (via next/script strategy="beforeInteractive") so the correct
// theme is painted on the very first frame instead of flashing dark and then switching.
// Keep the storage key in sync with THEME_STORAGE_KEY in ./context.tsx.
export const THEME_INIT_SCRIPT = `(function () {
  try {
    var stored = window.localStorage.getItem("af-theme");
    var theme = stored === "light" || stored === "dark" ? stored : "system";
    var resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : theme;
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) {}
})();`;
