import { describe, expect, it } from "vitest";
import { SUPPORTED_MIMES, UnsupportedMimeError, extractText } from "../text-extract";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("extractText", () => {
  it("decodes UTF-8 markdown, multi-byte codepoints included", () => {
    expect(extractText("text/markdown", bytes("# Déploiements\n\nUtilisez pnpm — 日本語 too."))).toBe(
      "# Déploiements\n\nUtilisez pnpm — 日本語 too.",
    );
  });

  it("decodes text/plain", () => {
    expect(extractText("text/plain", bytes("Run pnpm build."))).toBe("Run pnpm build.");
  });

  it("normalises CRLF line endings so the chunker sees one newline convention", () => {
    expect(extractText("text/markdown", bytes("# Deploys\r\n\r\nRun pnpm build.\r\n"))).toBe(
      "# Deploys\n\nRun pnpm build.\n",
    );
  });

  it("strips a leading BOM, which would otherwise break heading detection on line 1", () => {
    expect(extractText("text/markdown", bytes("﻿# Deploys\n\nBody."))).toBe("# Deploys\n\nBody.");
  });

  it("accepts a mime carrying a charset parameter", () => {
    expect(extractText("text/markdown; charset=utf-8", bytes("Body."))).toBe("Body.");
    expect(extractText("TEXT/PLAIN", bytes("Body."))).toBe("Body.");
  });

  it("rejects an unsupported mime with UnsupportedMimeError", () => {
    expect(() => extractText("application/pdf", bytes("%PDF-1.7"))).toThrow(UnsupportedMimeError);
    expect(() => extractText("application/pdf", bytes("%PDF-1.7"))).toThrow(
      "Unsupported mime type: application/pdf",
    );
  });

  it("exposes exactly the two mimes the upload route accepts", () => {
    expect(SUPPORTED_MIMES).toEqual(["text/markdown", "text/plain"]);
  });

  it("returns an empty string for empty bytes rather than throwing", () => {
    expect(extractText("text/plain", new Uint8Array())).toBe("");
  });
});
