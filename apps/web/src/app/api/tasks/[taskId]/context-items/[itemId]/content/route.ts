import { NextResponse } from "next/server";
import { getTaskContextItemForOrg } from "@agentfactory/db";
import { createBlobStore } from "@agentfactory/storage";
import { requireAuthContext } from "@/server/auth";

let blobStore: ReturnType<typeof createBlobStore> | undefined;
function getBlobStore() {
  if (!blobStore) blobStore = createBlobStore();
  return blobStore;
}

// Generic content-serving route, not image-specific: it streams whatever bytes and mime an item
// has. Only the UI's choice to render an <img> for image rows (ContextDocumentsPanel) makes this
// "the image route" in practice.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string; itemId: string }> },
) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { itemId } = await params;
  const item = await getTaskContextItemForOrg(Number(itemId), ctx.orgId);
  // 404, not 403: an item in another org must not be distinguishable from one that isn't there.
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bytes = await getBlobStore().get(item.orgId, item.sha256);
  if (!bytes) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Buffer.from(...), not the Uint8Array directly: BlobStore.get's declared return type is
  // Uint8Array<ArrayBufferLike>, which this TS/@types-node combination's BodyInit no longer
  // accepts (its buffer could in principle be a SharedArrayBuffer). Buffer's type is pinned to
  // ArrayBuffer, so this satisfies the type without changing the bytes served.
  return new NextResponse(Buffer.from(bytes), {
    headers: { "Content-Type": item.mime, "X-Content-Type-Options": "nosniff" },
  });
}
