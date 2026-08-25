import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { I18nProvider } from "@/lib/i18n/context";
import { ThemeProvider } from "@/lib/theme/context";
import { themeStorageKey } from "@/lib/theme/theme";
import "./globals.css";

// Runs before React hydrates so the page paints with the right theme immediately — otherwise
// the server-rendered markup (no data-theme attribute) would flash dark before the client
// effect in ThemeProvider applies the stored preference. Keep the storage key literal in sync
// with themeStorageKey (can't import it into a string template used at runtime in the DOM).
const noFlashThemeScript = `(function(){try{var v=localStorage.getItem(${JSON.stringify(themeStorageKey)});var t=(v==="light"||v==="dark")?v:(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "AgentFactory",
  description: "Shared AI agents for your engineering team",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.className} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashThemeScript }} />
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          <I18nProvider>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
