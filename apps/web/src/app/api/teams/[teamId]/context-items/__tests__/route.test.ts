import { beforeEach, describe, expect, it, vi } from "vitest";

const putMock = vi.fn();
const getTeamMock = vi.fn();
const insertContentBlobMock = vi.fn();
const createTeamContextItemMock = vi.fn();
const listTeamContextItemsForOrgMock = vi.fn();

// The route builds its store once at module scope; mocking the module hands it this spy, which
// is how "the blob store was never touched" becomes an assertion rather than a hope.
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => ({ put: putMock, get: vi.fn() }),
}));
vi.mock("@agentfactory/db", () => ({
  getTeam: (...args: unknown[]) => getTeamMock(...args),
  insertContentBlob: (...args: unknown[]) => insertContentBlobMock(...args),
  createTeamContextItem: (...args: unknown[]) => createTeamContextItemMock(...args),
  listTeamContextItemsForOrg: (...args: unknown[]) => listTeamContextItemsForOrgMock(...args),
}));
const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

import { GET, MAX_UPLOAD_BYTES, POST } from "../route";

const URL_1 = "http://localhost/api/teams/1/context-items";
const BOUNDARY = "----afboundary";

function params() {
  return { params: Promise.resolve({ teamId: "1" }) };
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
  teamId: 1,
  orgId: 1,
  title: "handbook.md",
  sizeBytes: 11,
  sha256: "a".repeat(64),
  mime: "text/markdown",
  source: "upload",
  status: "pending",
  createdAt: "2026-08-27T10:00:00.000Z",
};

beforeEach(() => {
  putMock.mockReset();
  getTeamMock.mockReset();
  insertContentBlobMock.mockReset();
  createTeamContextItemMock.mockReset();
  listTeamContextItemsForOrgMock.mockReset();
  requireAuthContextMock.mockReset();
  requireAuthContextMock.mockResolvedValue({ user: { id: 5 }, orgId: 1 });
  getTeamMock.mockResolvedValue({ id: 1, orgId: 1 });
  putMock.mockResolvedValue({ sha256: "a".repeat(64), sizeBytes: 11 });
  createTeamContextItemMock.mockResolvedValue(ITEM);
});

describe("POST /api/teams/[teamId]/context-items", () => {
  // The case a bare comparison waves through: Number(null) > MAX is false. A ReadableStream body
  // (Transfer-Encoding: chunked) carries no Content-Length, and Playwright always sends an honest
  // header, so this path is unreachable from e2e — it lives or dies here.
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
    expect(createTeamContextItemMock).not.toHaveBeenCalled();
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
  });

  it("rejects a mime outside the allowlist", async () => {
    const res = await POST(
      multipartRequest({ filename: "spec.pdf", type: "application/pdf", content: "%PDF-1.7" }),
      params(),
    );

    expect(res.status).toBe(415);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects a teamId belonging to another org", async () => {
    getTeamMock.mockResolvedValue({ id: 1, orgId: 2 });

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
    expect(createTeamContextItemMock).toHaveBeenCalledWith({
      teamId: 1,
      orgId: 1,
      title: "handbook.md",
      sizeBytes: 11,
      sha256: "a".repeat(64),
      mime: "text/markdown",
      uploadedBy: 5,
    });
  });

  it("answers 409 when the same document is already in the team", async () => {
    createTeamContextItemMock.mockResolvedValue(undefined);

    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "text/markdown", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(409);
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
    expect(getTeamMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(createTeamContextItemMock).not.toHaveBeenCalled();
  });

  // The reviewer's finding: some OS/browser combos never populate a .md file's mime — locally
  // it's "", and once a File round-trips through FormData it can come back
  // "application/octet-stream". The route must fall back to the extension rather than reject the
  // PR's own headline scenario, and must persist the normalized mime, never the raw one.
  it("accepts a .md file whose declared mime is empty or application/octet-stream, and persists the normalized mime", async () => {
    const res = await POST(
      multipartRequest({ filename: "handbook.md", type: "application/octet-stream", content: "# Handbook" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("text/markdown");
    expect(insertContentBlobMock).toHaveBeenCalledWith(1, "a".repeat(64), 11, "text/markdown");
    expect(createTeamContextItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ mime: "text/markdown" }),
    );
  });
});

describe("GET /api/teams/[teamId]/context-items", () => {
  it("lists the team's items scoped to the caller's org", async () => {
    listTeamContextItemsForOrgMock.mockResolvedValue([ITEM]);

    const res = await GET(new Request(URL_1), params());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([ITEM]);
    expect(listTeamContextItemsForOrgMock).toHaveBeenCalledWith(1, 1);
  });

  it("answers 404 for a team in another org instead of listing it", async () => {
    getTeamMock.mockResolvedValue({ id: 1, orgId: 2 });

    const res = await GET(new Request(URL_1), params());

    expect(res.status).toBe(404);
    expect(listTeamContextItemsForOrgMock).not.toHaveBeenCalled();
  });

  it("answers 401 without listing when unauthorized", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await GET(new Request(URL_1), params());

    expect(res.status).toBe(401);
    expect(getTeamMock).not.toHaveBeenCalled();
    expect(listTeamContextItemsForOrgMock).not.toHaveBeenCalled();
  });
});
