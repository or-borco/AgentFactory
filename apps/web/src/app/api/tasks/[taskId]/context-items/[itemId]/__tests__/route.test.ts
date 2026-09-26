import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteTaskContextItemForOrgMock = vi.fn();
const getTaskContextItemForOrgMock = vi.fn();
const getTaskMock = vi.fn();

vi.mock("@agentfactory/db", () => ({
  deleteTaskContextItemForOrg: (...args: unknown[]) => deleteTaskContextItemForOrgMock(...args),
  getTaskContextItemForOrg: (...args: unknown[]) => getTaskContextItemForOrgMock(...args),
  getTask: (...args: unknown[]) => getTaskMock(...args),
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
  getTaskContextItemForOrgMock.mockReset().mockResolvedValue({ id: 9, taskId: 1, orgId: 1 });
  getTaskMock.mockReset().mockResolvedValue({ id: 1, orgId: 1, status: "in_progress" });
  requireAuthContextMock.mockReset();
  requireAuthContextMock.mockResolvedValue({ user: { id: 5 }, orgId: 1 });
});

describe("DELETE /api/tasks/[taskId]/context-items/[itemId]", () => {
  it("deletes the item (and its blob-reference row) scoped to the caller's org", async () => {
    deleteTaskContextItemForOrgMock.mockResolvedValue(true);

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(204);
    expect(getTaskContextItemForOrgMock).toHaveBeenCalledWith(9, 1);
    expect(deleteTaskContextItemForOrgMock).toHaveBeenCalledWith(9, 1);
  });

  it("answers 404 when the item doesn't exist or belongs to another org", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue(undefined);

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(404);
    expect(deleteTaskContextItemForOrgMock).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])("answers 409 without deleting when the item's task is %s", async (status) => {
    getTaskMock.mockResolvedValue({ id: 1, orgId: 1, status });

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(409);
    expect(deleteTaskContextItemForOrgMock).not.toHaveBeenCalled();
  });

  it("checks the item's own task, not the task id in the URL", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue({ id: 9, taskId: 77, orgId: 1 });
    getTaskMock.mockImplementation(async (id: number) =>
      id === 77 ? { id: 77, orgId: 1, status: "done" } : { id, orgId: 1, status: "in_progress" },
    );

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(409);
    expect(getTaskMock).toHaveBeenCalledWith(77);
  });

  it("still deletes from a failed task, which stays retryable", async () => {
    getTaskMock.mockResolvedValue({ id: 1, orgId: 1, status: "failed" });
    deleteTaskContextItemForOrgMock.mockResolvedValue(true);

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(204);
  });

  it("answers 401 without deleting when unauthorized", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await DELETE(new Request("http://localhost/api/tasks/1/context-items/9"), params());

    expect(res.status).toBe(401);
    expect(deleteTaskContextItemForOrgMock).not.toHaveBeenCalled();
  });
});
