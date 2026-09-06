import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { I18nProvider } from "@/lib/i18n/context";
import { resolveDataTheme } from "@/lib/theme/resolve-data-theme";
import { getCurrentUser } from "@/server/auth";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "AgentFactory",
  description: "Shared AI agents for your engineering team",
};

// Reads the current user (cache()-deduped with the identical call in (app)/layout.tsx, so this
// costs no extra DB round-trip) purely to stamp data-theme before the HTML ships. When the
// preference is explicit ("light"/"dark") the server commits to it here, avoiding a flash of the
// wrong theme; "system" and logged-out requests (no user at all, e.g. (auth) routes) get no
// attribute and fall through to globals.css's `@media (prefers-color-scheme)` block, which is
// correct on first paint by construction since it reflects the browser's own setting.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();
  const dataTheme = resolveDataTheme(user?.preferences?.theme);

  return (
    <html lang="en" data-theme={dataTheme} className={`${inter.className} h-full antialiased`}>
      <body className="min-h-full">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
