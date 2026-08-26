import { redirect } from "next/navigation";
import { LeftPane } from "@/components/LeftPane";
import { AuthProvider } from "@/lib/auth/context";
import { MockBackendProvider } from "@/lib/mock/context";
import { ThemeProvider } from "@/lib/theme/context";
import { getCurrentUser } from "@/server/auth";

// MockBackendProvider lives here (not the root layout) because every one of its API calls
// requires the auth this layout already gates on — mounting it above /login would fire
// authenticated-only fetches for a visitor who isn't logged in yet. ThemeProvider is nested
// inside it (rather than the root layout, which already sets the initial data-theme attribute
// on <html>) because it reports save failures via MockBackendProvider's toast.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <AuthProvider user={user}>
      <MockBackendProvider>
        <ThemeProvider initialTheme={user.themePreference}>
          <LeftPane>{children}</LeftPane>
        </ThemeProvider>
      </MockBackendProvider>
    </AuthProvider>
  );
}
