import { redirect } from "next/navigation";
import { LeftPane } from "@/components/LeftPane";
import { AuthProvider } from "@/lib/auth/context";
import { AppDataProvider } from "@/lib/app-data/context";
import { getCurrentUser } from "@/server/auth";

// AppDataProvider lives here (not the root layout) because every one of its API calls
// requires the auth this layout already gates on — mounting it above /login would fire
// authenticated-only fetches for a visitor who isn't logged in yet.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <AuthProvider user={user}>
      <AppDataProvider>
        <LeftPane>{children}</LeftPane>
      </AppDataProvider>
    </AuthProvider>
  );
}
