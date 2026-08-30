import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../api-client";

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed JSON body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 200 })));

    await expect(apiFetch("/api/agents")).resolves.toEqual({ id: 1 });
  });

  it("sends a JSON content-type header on a JSON body, merged with any custom headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({ name: "Platform" });
    await apiFetch("/api/agents", { method: "POST", body, headers: { "X-Test": "1" } });

    expect(fetchMock).toHaveBeenCalledWith("/api/agents", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "X-Test": "1" },
    });
  });

  // A multipart body must carry the browser's own content-type, boundary and all. The default
  // can't be removed at the call site — the headers object spreads the JSON default in first, so
  // passing `undefined` leaves the key present — which is why the branch belongs here, in the
  // one place all client→API traffic goes through.
  it("omits the JSON content-type for a FormData body so the browser sets the boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = new FormData();
    body.append("file", new File(["# Handbook"], "handbook.md", { type: "text/markdown" }));

    await apiFetch("/api/teams/3/context-items", { method: "POST", body });

    expect(fetchMock).toHaveBeenCalledWith("/api/teams/3/context-items", {
      method: "POST",
      body,
      headers: {},
    });
  });

  it("returns undefined for a 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(apiFetch("/api/sessions/1")).resolves.toBeUndefined();
  });

  it("throws the server-provided error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: "Invalid email or password" }), { status: 401 })),
    );

    await expect(apiFetch("/api/auth/login")).rejects.toThrow("Invalid email or password");
  });

  it("falls back to a generic message when the error body isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 })));

    await expect(apiFetch("/api/agents")).rejects.toThrow("GET /api/agents failed: 500 Internal Server Error");
  });
});
