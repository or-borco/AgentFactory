import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { I18nProvider } from "@/lib/i18n/context";
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolved here (rather than left to (app)/layout.tsx alone) so the *first* server-rendered
  // HTML already carries the right data-theme attribute on <html> — the light-theme CSS
  // overrides in globals.css key off `:root[data-theme="light"]`, so setting this after the
  // fact (client-side, post-hydration) would flash dark for logged-in light-theme users. Logged
  // out visitors (and (auth) pages) get "dark", matching the app's original/only theme.
  const user = await getCurrentUser();
  const theme = user?.themePreference ?? "dark";

  return (
    <html lang="en" data-theme={theme} className={`${inter.className} h-full antialiased`}>
      <body className="min-h-full">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
