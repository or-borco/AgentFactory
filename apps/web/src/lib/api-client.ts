// Every client-side data call goes through here. Paths are same-origin now (Next.js Route
// Handlers), so there's no base URL to configure — but this is the one place that would
// change if the mock API were ever replaced by the real apps/worker service from
// ARCHITECTURE.md, instead of every call site.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
