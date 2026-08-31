import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContextRetrieval } from "@agentfactory/core";

const requireAuthContext = vi.fn();
const getRun = vi.fn();
const getSession = vi.fn();
const getAgent = vi.fn();
const listRunContextRetrievals = vi.fn();

// The real @agentfactory/db throws at import when DATABASE_URL is unset (client.ts), and the
// unit project has no database — a factory mock keeps the module from ever loading.
vi.mock("@agentfactory/db", () => ({
  getRun: (...args: unknown[]) => getRun(...args),
  getSession: (...args: unknown[]) => getSession(...args),
  getAgent: (...args: unknown[]) => getAgent(...args),
  listRunContextRetrievals: (...args: unknown[]) => listRunContextRetrievals(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { GET } from "../route";

const RETRIEVAL: RunContextRetrieval = {
  id: 1,
  runId: 7,
  itemId: 4,
  itemTitle: "Engineering handbook",
  chunkIdx: 3,
  rank: 1,
  score: 0.82,
  createdAt: "2026-08-27T10:00:00.000Z",
};

function call(runId: string) {
  return GET(new Request(`http://localhost/api/runs/${runId}/retrievals`), {
    params: Promise.resolve({ runId }),
  });
}

beforeEach(() => {
  requireAuthContext.mockReset();
  getRun.mockReset();
  getSession.mockReset();
  getAgent.mockReset();
  listRunContextRetrievals.mockReset();
});

describe("GET /api/runs/[runId]/retrievals", () => {
  it("401s when there is no session, without reading anything", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await call("7");

    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("returns the run's retrievals for a caller in the run's org", async () => {
    requireAuthContext.mockResolvedValue({ user: { id: 1 }, orgId: 3 });
    getRun.mockResolvedValue({ id: 7, sessionId: 11 });
    getSession.mockResolvedValue({ id: 11, agentId: 21 });
    getAgent.mockResolvedValue({ id: 21, orgId: 3 });
    listRunContextRetrievals.mockResolvedValue([RETRIEVAL]);

    const res = await call("7");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([RETRIEVAL]);
    expect(listRunContextRetrievals).toHaveBeenCalledWith(7);
  });

  // The whole reason this route is org-scoped where prompt/route.ts is not: these rows carry
  // another team's document titles.
  it("404s a run in another org without reading its retrievals", async () => {
    requireAuthContext.mockResolvedValue({ user: { id: 1 }, orgId: 3 });
    getRun.mockResolvedValue({ id: 7, sessionId: 11 });
    getSession.mockResolvedValue({ id: 11, agentId: 21 });
    getAgent.mockResolvedValue({ id: 21, orgId: 99 });

    const res = await call("7");

    expect(res.status).toBe(404);
    expect(listRunContextRetrievals).not.toHaveBeenCalled();
  });

  // Without the integer guard NaN reaches Postgres as an invalid integer and the route 500s.
  it("404s a non-numeric run id without touching the database", async () => {
    requireAuthContext.mockResolvedValue({ user: { id: 1 }, orgId: 3 });

    const res = await call("not-a-run");

    expect(res.status).toBe(404);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("404s a run that does not exist", async () => {
    requireAuthContext.mockResolvedValue({ user: { id: 1 }, orgId: 3 });
    getRun.mockResolvedValue(undefined);

    const res = await call("7");

    expect(res.status).toBe(404);
  });
});
