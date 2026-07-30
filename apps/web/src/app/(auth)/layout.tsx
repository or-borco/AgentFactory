import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (user) redirect("/agents");

  return <>{children}</>;
}
