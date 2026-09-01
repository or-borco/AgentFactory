import { NextResponse } from "next/server";
import {
  createTeamContextItem,
  getTeam,
  insertContentBlob,
  listTeamContextItemsForOrg,
} from "@agentfactory/db";
import { enqueueTeamContextIngestJob } from "@agentfactory/queue";
import { createBlobStore } from "@agentfactory/storage";
import { requireAuthContext } from "@/server/auth";

// Nothing else caps an upload. Next.js 16 Route Handlers have no request body limit of their own
// (bodySizeLimit is enforced only on the Server Actions path), there is no middleware and no
// proxy, and request.formData() buffers the whole body into the single web process that serves
// every org.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

// Ingestion reads exactly these two (TextExtractor is the seam where PDF and .docx arrive
// later). Accepting anything else here only produces an item that can never leave "pending".
const ALLOWED_MIMES = new Set(["text/markdown", "text/plain"]);

// Mirrors the client-side fallback in ContextDocumentsPanel.tsx. The client already reconstructs
// the File with a corrected type before it uploads, but this is the actual enforcement point —
// a client that skips that step (or any other caller of this route) must not have a real .md
// file rejected just because the browser/OS never populated file.type. When the fallback fires,
// `mime` (never `file.type`) is what gets persisted, so PR4's text extractor can trust the
// mime column is always one of the two real supported values.
function extensionMime(filename: string): "text/markdown" | "text/plain" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}

// Built lazily rather than eagerly at module scope: this module is imported before test files'
// own top-level `vi.fn()` mocks finish initializing, and an eager `createBlobStore()` call here
// would read those mocks while they are still in their temporal dead zone. Lazy + memoized keeps
// the "one store for the process" property without that ordering hazard.
let blobStore: ReturnType<typeof createBlobStore> | undefined;
function getBlobStore() {
  if (!blobStore) blobStore = createBlobStore();
  return blobStore;
}

export async function GET(_req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { teamId } = await params;
  const team = await getTeam(Number(teamId));
  // 404, not 403: a team in another org must not be distinguishable from one that isn't there.
  if (!team || team.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }
  return NextResponse.json(await listTeamContextItemsForOrg(team.id, ctx.orgId));
}

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { teamId } = await params;
  const team = await getTeam(Number(teamId));
  if (!team || team.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  // Content-Length is a gate, not the cap. It is client-supplied and absent entirely under
  // Transfer-Encoding: chunked, so the rule is "no trustworthy declared length ⇒ no upload":
  // Number(null) > MAX is false, so a missing or unparseable header has to be rejected
  // explicitly rather than falling through the comparison. An understated length is not a
  // second hole — Node delivers only the declared byte count — and the parsed file is
  // re-checked below anyway.
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is too large" }, { status: 413 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  let mime = file.type;
  if (!ALLOWED_MIMES.has(mime)) {
    const fallback = extensionMime(file.name);
    if (!fallback) {
      return NextResponse.json({ error: "Only Markdown and plain text files are supported" }, { status: 415 });
    }
    mime = fallback;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // The declared length covered the whole multipart envelope; this is the file itself.
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is too large" }, { status: 413 });
  }
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }

  // Bytes first, then the blob row, then the item: the composite (org_id, sha256) FK means the
  // item cannot be written before the blob exists, and a blob with no item is inert.
  const { sha256, sizeBytes } = await getBlobStore().put(ctx.orgId, bytes, mime);
  await insertContentBlob(ctx.orgId, sha256, sizeBytes, mime);

  const submittedTitle = form.get("title");
  const title = typeof submittedTitle === "string" && submittedTitle.trim() ? submittedTitle.trim() : file.name;

  const item = await createTeamContextItem({
    teamId: team.id,
    orgId: ctx.orgId,
    title,
    sizeBytes,
    sha256,
    mime,
    uploadedBy: ctx.user.id,
  });
  if (!item) {
    return NextResponse.json(
      { error: "This document has already been uploaded to this team" },
      { status: 409 },
    );
  }
  // Enqueued after the row exists, never before: the job's first act is to load the item by
  // id, and jobId is `item-${itemId}`, so an id that isn't in the table yet is a job that
  // logs "not found" and drops itself. The response does not wait for ingestion — the item
  // comes back at "pending" and the panel polls it to "indexed".
  await enqueueTeamContextIngestJob(item.id);
  return NextResponse.json(item, { status: 201 });
}
