import { beforeEach, describe, expect, it, vi } from "vitest";

const getTaskContextItemForOrgMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getTaskContextItemForOrg: (...args: unknown[]) => getTaskContextItemForOrgMock(...args),
}));
const getBlobMock = vi.fn();
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => ({ put: vi.fn(), get: (...args: unknown[]) => getBlobMock(...args) }),
}));
const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

import { GET } from "../route";

function params(itemId = "9") {
  return { params: Promise.resolve({ taskId: "1", itemId }) };
}

const ITEM = {
  id: 9,
  taskId: 1,
  orgId: 1,
  title: "screenshot.png",
  sizeBytes: 4,
  sha256: "a".repeat(64),
  mime: "image/png",
  source: "upload",
  status: "indexed",
  createdAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  getTaskContextItemForOrgMock.mockReset();
  getBlobMock.mockReset();
  requireAuthContextMock.mockReset();
  requireAuthContextMock.mockResolvedValue({ user: { id: 5 }, orgId: 1 });
});

describe("GET /api/tasks/[taskId]/context-items/[itemId]/content", () => {
  it("streams the blob's bytes with the item's mime as Content-Type", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue(ITEM);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    getBlobMock.mockResolvedValue(bytes);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(getTaskContextItemForOrgMock).toHaveBeenCalledWith(9, 1);
    expect(getBlobMock).toHaveBeenCalledWith(1, "a".repeat(64));
  });

  it("answers 404 when the item doesn't exist or belongs to another org", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue(undefined);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(404);
    expect(getBlobMock).not.toHaveBeenCalled();
  });

  it("answers 404 when the item exists but its blob is missing", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue(ITEM);
    getBlobMock.mockResolvedValue(undefined);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(404);
  });

  it("answers 401 without touching the db or blob store when unauthorized", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(401);
    expect(getTaskContextItemForOrgMock).not.toHaveBeenCalled();
    expect(getBlobMock).not.toHaveBeenCalled();
  });
});
