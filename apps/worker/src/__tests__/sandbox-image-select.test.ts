import { describe, expect, it, vi } from "vitest";

const resolveDetectedLanguageMock = vi.fn();
vi.mock("../scm-provider", () => ({
  resolveDetectedLanguage: (orgId: number, repoFullName: string) => resolveDetectedLanguageMock(orgId, repoFullName),
}));

const { resolveSandboxImage, SANDBOX_IMAGE, SANDBOX_IMAGE_JAVA, SANDBOX_IMAGE_PYTHON } = await import(
  "../sandbox-image-select"
);

describe("resolveSandboxImage", () => {
  it("returns the base image when repoFullName is undefined", async () => {
    await expect(resolveSandboxImage(1, undefined)).resolves.toBe(SANDBOX_IMAGE);
    expect(resolveDetectedLanguageMock).not.toHaveBeenCalled();
  });

  it("returns the base image when detection returns undefined", async () => {
    resolveDetectedLanguageMock.mockResolvedValue(undefined);
    await expect(resolveSandboxImage(1, "acme/widgets")).resolves.toBe(SANDBOX_IMAGE);
  });

  it("returns the base image when detection throws", async () => {
    resolveDetectedLanguageMock.mockRejectedValue(new Error("network"));
    await expect(resolveSandboxImage(1, "acme/widgets")).resolves.toBe(SANDBOX_IMAGE);
  });

  it("maps Python to SANDBOX_IMAGE_PYTHON", async () => {
    resolveDetectedLanguageMock.mockResolvedValue("Python");
    await expect(resolveSandboxImage(1, "acme/widgets")).resolves.toBe(SANDBOX_IMAGE_PYTHON);
  });

  it("maps Java to SANDBOX_IMAGE_JAVA", async () => {
    resolveDetectedLanguageMock.mockResolvedValue("Java");
    await expect(resolveSandboxImage(1, "acme/widgets")).resolves.toBe(SANDBOX_IMAGE_JAVA);
  });

  it("returns the base image for an unmapped language", async () => {
    resolveDetectedLanguageMock.mockResolvedValue("Go");
    await expect(resolveSandboxImage(1, "acme/widgets")).resolves.toBe(SANDBOX_IMAGE);
  });
});
