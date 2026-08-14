import { redirect } from "next/navigation";

// Connections now lives inside Settings (see /settings/page.tsx). This route stays as a
// redirect — rather than being deleted outright — because the GitHub connect flow
// (api/connections/github/callback/route.ts) still sends users back to /connections with
// ?connected=github or ?error=... query params, and apps/web/src/app/(app)/tasks/new/page.tsx
// links here directly.
export default async function ConnectionsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
  }
  const suffix = qs.toString();
  redirect(suffix ? `/settings?${suffix}` : "/settings");
}
