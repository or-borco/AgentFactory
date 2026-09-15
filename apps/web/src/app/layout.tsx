import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { I18nProvider } from "@/lib/i18n/context";
import { ThemeProvider } from "@/lib/theme/context";
import "./globals.css";

const THEME_INIT_SCRIPT = `try{if(localStorage.getItem("agentfactory-theme")==="light"){document.documentElement.dataset.theme="light"}}catch(e){}`;

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
    <html lang="en" className={`${inter.className} h-full antialiased`}>
      <head>
        {/* Applies the persisted theme to <html> before first paint, so light-mode users don't
            see a flash of the default dark theme. Mutates the DOM directly (not through React),
            so it never causes a hydration mismatch — see ThemeProvider for how the React side
            picks this back up after mount. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <I18nProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
