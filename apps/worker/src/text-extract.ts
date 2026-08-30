// The format seam. Ingestion accepts plain text and markdown only; PDF and .docx are each one
// later, isolated PR behind this function rather than a change to the ingest handler. Pure and
// synchronous — nothing here touches the database, the blob store, or the model.
export const SUPPORTED_MIMES: readonly string[] = ["text/markdown", "text/plain"];

export class UnsupportedMimeError extends Error {
  constructor(mime: string) {
    super(`Unsupported mime type: ${mime}`);
    this.name = "UnsupportedMimeError";
  }
}

export function extractText(mime: string, bytes: Uint8Array): string {
  // The upload route caps the mime, but a browser is free to send "text/markdown; charset=utf-8"
  // and the stored value is whatever it sent, so the comparison normalises rather than trusting.
  const base = mime.split(";")[0].trim().toLowerCase();
  if (!SUPPORTED_MIMES.includes(base)) throw new UnsupportedMimeError(base);

  // Non-fatal decoding: a stray invalid byte becomes U+FFFD rather than failing a whole
  // document. CRLF is normalised and a BOM stripped so the chunker's heading regex, which is
  // anchored to line starts, sees one convention.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return decoded.replace(/^﻿/, "").replace(/\r\n/g, "\n");
}
