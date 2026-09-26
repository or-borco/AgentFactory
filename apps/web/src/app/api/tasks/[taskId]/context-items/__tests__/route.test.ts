import { beforeEach, describe, expect, it, vi } from "vitest";

const putMock = vi.fn();
const getTaskMock = vi.fn();
const insertContentBlobMock = vi.fn();
const createTaskContextItemMock = vi.fn();
const listTaskContextItemsForOrgMock = vi.fn();
const enqueueTaskContextIngestJobMock = vi.fn();

// Mirrors apps/web/src/app/api/teams/[teamId]/context-items/__tests__/route.test.ts exactly —
// same mocking strategy, same cases, scoped to tasks instead of teams.
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => ({ put: putMock, get: vi.fn() }),
}));
vi.mock("@agentfactory/db", () => ({
  getTask: (...args: unknown[]) => getTaskMock(...args),
  insertContentBlob: (...args: unknown[]) => insertContentBlobMock(...args),
  createTaskContextItem: (...args: unknown[]) => createTaskContextItemMock(...args),
  listTaskContextItemsForOrg: (...args: unknown[]) => listTaskContextItemsForOrgMock(...args),
}));
// @agentfactory/queue throws at module load when REDIS_URL is unset, which it is in the unit
// test env — mock it out so the route's import of enqueueTaskContextIngestJob doesn't touch Redis.
vi.mock("@agentfactory/queue", () => ({
  enqueueTaskContextIngestJob: (...args: unknown[]) => enqueueTaskContextIngestJobMock(...args),
}));
const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

import { GET, MAX_UPLOAD_BYTES, POST } from "../route";

const URL_1 = "http://localhost/api/tasks/1/context-items";
const BOUNDARY = "----afboundary";

function params() {
  return { params: Promise.resolve({ taskId: "1" }) };
}

// Hand-built so the test controls Content-Length exactly: undici never populates that header on
// a Request it constructs, and the header is the whole subject here.
function multipartRequest(
  { filename, type, content }: { filename: string; type: string; content: string },
  headerOverrides: Record<string, string> = {},
) {
  const body =
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${type}\r\n\r\n` +
    `${content}\r\n` +
    `--${BOUNDARY}--\r\n`;
  return new Request(URL_1, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      "content-length": String(new TextEncoder().encode(body).length),
      ...headerOverrides,
    },
    body,
  });
}

const ITEM = {
  id: 9,
  taskId: 1,
  orgId: 1,
  title: "handbook.md",
  sizeBytes: 11,
  sha256: "a".repeat(64),
  mime: "text/markdown",
  source: "upload",
  status: "pending",
  createdAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  putMock.mockReset();
  getTaskMock.mockReset();
  insertContentBlobMock.mockReset();
  createTaskContextItemMock.mockReset();
  listTaskContextItemsForOrgMock.mockReset();
  enqueueTaskContextIngestJobMock.mockReset();
  requireAuthContextMock.mockReset();
  requireAuthContextMock.mockResolvedValue({ user: { id: 5 }, orgId: 1 });
  getTaskMock.mockResolvedValue({ id: 1, orgId: 1 });
  putMock.mockResolvedValue({ sha256: "a".repeat(64), sizeBytes: 11 });
  createTaskContextItemMock.mockResolvedValue(ITEM);
});

describe("POST /api/tasks/[taskId]/context-items", () => {
  it("rejects a body with no Content-Length before reading it", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("# Handbook"));
        controller.close();
      },
    });
    const request = new Request(URL_1, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const res = await POST(request, params());

    expect(res.status).toBe(413);
    expect(putMock).not.toHaveBeenCalled();
    expect(createTaskContextItemMock).not.toHaveBeenCalled();
    expect(enqueueTaskContextIngestJobMock).not.toHaveBeenCalled();
  });

  it("rejects an unparseable Content-Length", async () => {
    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }, {
        "content-length": "not-a-number",
      }),
      params(),
    );

    expect(res.status).toBe(413);
    expect(putMock).not.toHaveBeenCalled();
    expect(enqueueTaskContextIngestJobMock).not.toHaveBeenCalled();
  });

  it("rejects a declared length over the cap without reading the body", async () => {
    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }, {
        "content-length": String(MAX_UPLOAD_BYTES + 1),
      }),
      params(),
    );

    expect(res.status).toBe(413);
    expect(putMock).not.toHaveBeenCalled();
    expect(enqueueTaskContextIngestJobMock).not.toHaveBeenCalled();
  });

  it("rejects a mime outside the allowlist", async () => {
    const res = await POST(
      multipartRequest({ filename: "spec.pdf", type: "application/pdf", content: "%PDF-1.7" }),
      params(),
    );

    expect(res.status).toBe(415);
    expect(putMock).not.toHaveBeenCalled();
    expect(enqueueTaskContextIngestJobMock).not.toHaveBeenCalled();
  });

  it("accepts a JPEG file and returns 201", async () => {
    const res = await POST(
      multipartRequest({ filename: "screenshot.jpg", type: "image/jpeg", content: "\xFF\xD8\xFF" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("image/jpeg");
  });

  it("accepts a PNG file and returns 201", async () => {
    const res = await POST(
      multipartRequest({ filename: "diagram.png", type: "image/png", content: "\x89PNG" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("image/png");
  });

  it("falls back to the extension when a browser mis-declares an image's mime", async () => {
    const res = await POST(
      multipartRequest({ filename: "diagram.png", type: "application/octet-stream", content: "\x89PNG" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("image/png");
  });

  it("still rejects a mime that isn't in the task's allowlist, e.g. GIF", async () => {
    const res = await POST(
      multipartRequest({ filename: "anim.gif", type: "image/gif", content: "GIF89a" }),
      params(),
    );

    expect(res.status).toBe(415);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects a taskId belonging to another org", async () => {
    getTaskMock.mockResolvedValue({ id: 1, orgId: 2 });

    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(404);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects a taskId that does not exist", async () => {
    getTaskMock.mockResolvedValue(undefined);

    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(404);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("stores the bytes, records the blob, and returns the pending item", async () => {
    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(ITEM);
    expect(putMock).toHaveBeenCalledTimes(1);
    const [orgId, bytes, mime] = putMock.mock.calls[0];
    expect(orgId).toBe(1);
    expect(new TextDecoder().decode(bytes)).toBe("# Handbook");
    expect(mime).toBe("text/markdown");
    expect(insertContentBlobMock).toHaveBeenCalledWith(1, "a".repeat(64), 11, "text/markdown");
    expect(createTaskContextItemMock).toHaveBeenCalledWith({
      taskId: 1,
      orgId: 1,
      title: "handbook.md",
      sizeBytes: 11,
      sha256: "a".repeat(64),
      mime: "text/markdown",
      uploadedBy: 5,
    });
    expect(enqueueTaskContextIngestJobMock).toHaveBeenCalledWith(ITEM.id);
  });

  it("answers 409 when the same document is already attached to the task", async () => {
    createTaskContextItemMock.mockResolvedValue(undefined);

    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(409);
    expect(enqueueTaskContextIngestJobMock).not.toHaveBeenCalled();
  });

  it("answers 400 when the file field is missing", async () => {
    const body = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="title"\r\n\r\nsome title\r\n--${BOUNDARY}--\r\n`;
    const request = new Request(URL_1, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": String(new TextEncoder().encode(body).length),
      },
      body,
    });

    const res = await POST(request, params());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "No file uploaded" });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("answers 400 for a zero-byte file", async () => {
    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "" }),
      params(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "File is empty" });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("answers 401 without touching the blob store or DB when unauthorized", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(401);
    expect(getTaskMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(createTaskContextItemMock).not.toHaveBeenCalled();
  });

  it("accepts a .md file whose declared mime is empty or application/octet-stream, and persists the normalized mime", async () => {
    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "application/octet-stream", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("text/markdown");
    expect(insertContentBlobMock).toHaveBeenCalledWith(1, "a".repeat(64), 11, "text/markdown");
    expect(createTaskContextItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ mime: "text/markdown" }),
    );
  });
});

describe("GET /api/tasks/[taskId]/context-items", () => {
  it("lists the task's items scoped to the caller's org", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([ITEM]);

    const res = await GET(new Request(URL_1), params());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([ITEM]);
    expect(listTaskContextItemsForOrgMock).toHaveBeenCalledWith(1, 1);
  });

  it("answers 404 for a task in another org instead of listing it", async () => {
    getTaskMock.mockResolvedValue({ id: 1, orgId: 2 });

    const res = await GET(new Request(URL_1), params());

    expect(res.status).toBe(404);
    expect(listTaskContextItemsForOrgMock).not.toHaveBeenCalled();
  });

  it("answers 401 without listing when unauthorized", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await GET(new Request(URL_1), params());

    expect(res.status).toBe(401);
    expect(getTaskMock).not.toHaveBeenCalled();
    expect(listTaskContextItemsForOrgMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/tasks/[taskId]/context-items on a closed task", () => {
  it.each(["done", "cancelled"])("answers 409 without storing anything when the task is %s", async (status) => {
    getTaskMock.mockResolvedValue({ id: 1, orgId: 1, status });

    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(409);
    expect(putMock).not.toHaveBeenCalled();
    expect(createTaskContextItemMock).not.toHaveBeenCalled();
    expect(enqueueTaskContextIngestJobMock).not.toHaveBeenCalled();
  });

  it("still accepts an upload on a failed task, which stays retryable", async () => {
    getTaskMock.mockResolvedValue({ id: 1, orgId: 1, status: "failed" });

    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(201);
  });
});
