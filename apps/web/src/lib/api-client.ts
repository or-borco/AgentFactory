// Every client-side data call goes through here. Paths are same-origin now (Next.js Route
// Handlers), so there's no base URL to configure — but this is the one place that would
// change if these Route Handlers were ever replaced by the real apps/worker service from
// ARCHITECTURE.md, instead of every call site.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // A FormData body has to reach the server with the browser's own multipart content-type,
  // boundary included — setting application/json on it makes the body unparseable. The default
  // can't be cancelled by a caller (the spread below would keep the key with an undefined
  // value), so the exception lives here rather than at any call site.
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: isFormData
      ? { ...init?.headers }
      : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Route handlers return { error: "human-readable message" } — surface that directly when
    // present so callers (e.g. auth forms) can show it as-is instead of a raw fetch failure.
    const parsedError = (() => {
      try {
        return (JSON.parse(body) as { error?: string }).error;
      } catch {
        return undefined;
      }
    })();
    throw new Error(parsedError ?? `${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
