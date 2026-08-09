import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { I18nProvider } from "@/lib/i18n/context";
import { ThemeProvider } from "@/lib/theme/context";
import { THEME_STORAGE_KEY } from "@/lib/theme/constants";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "AgentFactory",
  description: "Shared AI agents for your engineering team",
};

// Runs before hydration (and before first paint) so a stored/system "light" preference is
// applied immediately, instead of flashing the default dark theme and then swapping. Plain JS,
// no imports — this string is injected verbatim, it doesn't run through the bundler.
const themeInitScript = `
(function () {
  try {
    var stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var theme = stored === "light" || stored === "dark" ? stored : null;
    if (!theme) {
      var prefersDark = !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
      theme = stored === "system" || !stored ? (prefersDark ? "dark" : "light") : stored;
    }
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.className} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full">
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
        <ThemeProvider>
          <I18nProvider>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
