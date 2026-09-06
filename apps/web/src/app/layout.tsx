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
  // getCurrentUser is cache()-wrapped (server/auth.ts), so (app)/layout.tsx's own call for the
  // auth guard/AuthProvider reuses this same request-scoped result instead of a second DB hit.
  // No user (logged out, or on (auth) routes) and "system" both fall through to `undefined`,
  // which omits data-theme entirely and lets globals.css's prefers-color-scheme media query
  // decide — see globals.css for the no-flash mechanism this stamp exists for.
  const user = await getCurrentUser();
  const theme = user?.preferences?.theme;
  const dataTheme = theme === "light" || theme === "dark" ? theme : undefined;

  return (
    <html lang="en" data-theme={dataTheme} className={`${inter.className} h-full antialiased`}>
      <body className="min-h-full">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
