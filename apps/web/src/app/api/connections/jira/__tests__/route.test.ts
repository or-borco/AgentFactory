import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const listConnectionsMock = vi.fn();
const createConnectionMock = vi.fn();
const createConnectionSecretMock = vi.fn();

vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));
// @agentfactory/db throws at import when DATABASE_URL is unset, which it is in the unit test env
// — mock it out, same pattern as apps/web/src/app/api/tasks/__tests__/route.test.ts.
vi.mock("@agentfactory/db", () => ({
  listConnections: (...args: unknown[]) => listConnectionsMock(...args),
  createConnection: (...args: unknown[]) => createConnectionMock(...args),
  createConnectionSecret: (...args: unknown[]) => createConnectionSecretMock(...args),
}));

import { POST } from "../route";

// The real JiraTaskProvider is exercised as-is (not mocked) so this test also proves the route
// wires it correctly — only the network boundary (global fetch) is stubbed.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/connections/jira", { method: "POST", body: JSON.stringify(body) }),
  );
}

const validBody = {
  siteUrl: "https://acme.atlassian.net",
  accountEmail: "svc@acme.com",
  apiToken: "super-secret-token",
};

beforeEach(() => {
  requireAuthContextMock.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  listConnectionsMock.mockReset().mockResolvedValue([]);
  createConnectionMock.mockReset();
  createConnectionSecretMock.mockReset().mockResolvedValue(42);
  fetchMock.mockReset();
});

describe("POST /api/connections/jira", () => {
  it("401s when unauthenticated, without checking connections or calling Jira", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);

    const res = await post(validBody);

    expect(res.status).toBe(401);
    expect(listConnectionsMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Design decision 15: at most one kind:"tasks" connection per org, any provider — not just
  // another Jira site. This check must run before verify() ever fires, so a doomed request never
  // makes a wasted Jira API call.
  it('409s when the org already has any kind:"tasks" connection (even a different provider), and never calls Jira', async () => {
    listConnectionsMock.mockResolvedValue([
      {
        id: 9,
        orgId: 3,
        provider: "monday",
        kind: "tasks",
        label: "Monday board",
        health: "healthy",
        config: {},
        auth: "api_token",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await post(validBody);

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("Monday board");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createConnectionSecretMock).not.toHaveBeenCalled();
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("400s on a verify() failure and writes no rows at all (no orphaned secret or connection)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { errorMessages: ["You do not have the permission to see the specified issue."] },
        401,
      ),
    );

    const res = await post(validBody);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
    expect(createConnectionSecretMock).not.toHaveBeenCalled();
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("400s on a non-atlassian.net siteUrl before ever calling Jira", async () => {
    const res = await post({ ...validBody, siteUrl: "https://example.com" });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createConnectionSecretMock).not.toHaveBeenCalled();
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("201s on success, persists the secret then the connection, and echoes neither the token nor credentialRef", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ accountId: "acc-1", displayName: "Jane Doe" }, 200));
    createConnectionMock.mockResolvedValue({
      id: 5,
      orgId: 3,
      provider: "jira",
      kind: "tasks",
      label: "https://acme.atlassian.net",
      health: "healthy",
      config: {
        siteUrl: "https://acme.atlassian.net",
        accountEmail: "svc@acme.com",
        accountId: "acc-1",
        writeBack: { comment: true },
      },
      auth: "api_token",
      createdAt: "2026-09-14T00:00:00.000Z",
    });

    const res = await post(validBody);

    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("credentialRef");

    expect(createConnectionSecretMock).toHaveBeenCalledExactlyOnceWith(3, { apiToken: "super-secret-token" });
    expect(createConnectionMock).toHaveBeenCalledExactlyOnceWith(3, {
      provider: "jira",
      kind: "tasks",
      label: "https://acme.atlassian.net",
      auth: "api_token",
      credentialRef: 42,
      config: {
        siteUrl: "https://acme.atlassian.net",
        accountEmail: "svc@acme.com",
        accountId: "acc-1",
        writeBack: { comment: true },
      },
    });
  });

  // Simulates the reconnect flow: disconnect (DELETE /api/connections/[connectionId], out of
  // scope here) removes the existing tasks connection, and a second POST then succeeds normally.
  it("succeeds on a second POST after the existing connection is gone", async () => {
    listConnectionsMock.mockResolvedValueOnce([
      {
        id: 9,
        orgId: 3,
        provider: "jira",
        kind: "tasks",
        label: "Old site",
        health: "healthy",
        config: {},
        auth: "api_token",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const firstRes = await post(validBody);
    expect(firstRes.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();

    listConnectionsMock.mockResolvedValueOnce([]);
    fetchMock.mockResolvedValue(jsonResponse({ accountId: "acc-2", displayName: "Jane Doe" }, 200));
    createConnectionMock.mockResolvedValue({
      id: 6,
      orgId: 3,
      provider: "jira",
      kind: "tasks",
      label: "https://acme.atlassian.net",
      health: "healthy",
      config: {},
      auth: "api_token",
      createdAt: "2026-09-14T00:00:00.000Z",
    });

    const secondRes = await post(validBody);

    expect(secondRes.status).toBe(201);
    expect(createConnectionSecretMock).toHaveBeenCalledOnce();
    expect(createConnectionMock).toHaveBeenCalledOnce();
  });
});
