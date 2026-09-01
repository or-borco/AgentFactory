import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteTaskContextItemForOrgMock = vi.fn();

vi.mock("@agentfactory/db", () => ({
  deleteTaskContextItemForOrg: (...args: unknown[]) => deleteTaskContextItemForOrgMock(...args),
}));
const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

import { DELETE } from "../route";

function params(itemId = "9") {
  return { params: Promise.resolve({ taskId: "1", itemId }) };
}

beforeEach(() => {
  deleteTaskContextItemForOrgMock.mockReset();
  requireAuthContextMock.mockReset();
  requireAuthContextMock.mockResolvedValue({ user: { id: 5 }, orgId: 1 });
});

describe("DELETE /api/tasks/[taskId]/context-items/[itemId]", () => {
  it("deletes the item (and its blob-reference row) scoped to the caller's org", async () => {
    deleteTaskContextItemForOrgMock.mockResolvedValue(true);

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(204);
    expect(deleteTaskContextItemForOrgMock).toHaveBeenCalledWith(9, 1);
  });

  it("answers 404 when the item doesn't exist or belongs to another org", async () => {
    deleteTaskContextItemForOrgMock.mockResolvedValue(false);

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(404);
  });

  it("answers 401 without deleting when unauthorized", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(401);
    expect(deleteTaskContextItemForOrgMock).not.toHaveBeenCalled();
  });
});
