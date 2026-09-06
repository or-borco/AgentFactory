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

// getCurrentUser is cache()-wrapped, so this costs no extra DB round trip beyond the identical
// call (app)/layout.tsx already makes. Reading it here — purely to stamp data-theme before the
// HTML ships — is what avoids a flash of the wrong theme for a user with an explicit preference.
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
