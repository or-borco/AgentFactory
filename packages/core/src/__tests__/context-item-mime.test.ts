import { describe, expect, it } from "vitest";
import { TASK_CONTEXT_MIME_CONFIG, isTaskContextMimeAllowed, taskContextExtensionMime } from "../context-item-mime";

describe("TASK_CONTEXT_MIME_CONFIG", () => {
  it("marks text mimes as requiring indexing and decodable as text", () => {
    expect(TASK_CONTEXT_MIME_CONFIG["text/markdown"]).toMatchObject({ requiresIndexing: true, decodeAsText: true });
    expect(TASK_CONTEXT_MIME_CONFIG["text/plain"]).toMatchObject({ requiresIndexing: true, decodeAsText: true });
  });

  it("marks image mimes as not requiring indexing and not decodable as text", () => {
    expect(TASK_CONTEXT_MIME_CONFIG["image/jpeg"]).toMatchObject({ requiresIndexing: false, decodeAsText: false });
    expect(TASK_CONTEXT_MIME_CONFIG["image/png"]).toMatchObject({ requiresIndexing: false, decodeAsText: false });
  });

  it("every entry's extensions resolve back to its own mime", () => {
    for (const [mime, config] of Object.entries(TASK_CONTEXT_MIME_CONFIG)) {
      for (const ext of config.extensions) {
        expect(taskContextExtensionMime(`file${ext}`)).toBe(mime);
      }
    }
  });
});

describe("isTaskContextMimeAllowed", () => {
  it("allows every configured mime", () => {
    for (const mime of Object.keys(TASK_CONTEXT_MIME_CONFIG)) {
      expect(isTaskContextMimeAllowed(mime)).toBe(true);
    }
  });

  it("rejects a mime that isn't configured", () => {
    expect(isTaskContextMimeAllowed("application/pdf")).toBe(false);
    expect(isTaskContextMimeAllowed("image/gif")).toBe(false);
  });
});

describe("taskContextExtensionMime", () => {
  it("is case-insensitive", () => {
    expect(taskContextExtensionMime("SCREENSHOT.PNG")).toBe("image/png");
  });

  it("returns null for an unrecognised extension", () => {
    expect(taskContextExtensionMime("archive.zip")).toBeNull();
  });
});
