import { resolveDetectedLanguage } from "./scm-provider";

export const SANDBOX_IMAGE_NODE = process.env.SANDBOX_IMAGE_NODE ?? "arata-sandbox-node:local";
export const SANDBOX_IMAGE_PYTHON = process.env.SANDBOX_IMAGE_PYTHON ?? "arata-sandbox-python:local";
export const SANDBOX_IMAGE_JAVA = process.env.SANDBOX_IMAGE_JAVA ?? "arata-sandbox-java:local";

const LANGUAGE_IMAGE_MAP: Record<string, string> = {
  JavaScript: SANDBOX_IMAGE_NODE,
  TypeScript: SANDBOX_IMAGE_NODE,
  Python: SANDBOX_IMAGE_PYTHON,
  Java: SANDBOX_IMAGE_JAVA,
};

export async function resolveSandboxImage(orgId: number, repoFullName: string | undefined): Promise<string> {
  if (!repoFullName) return SANDBOX_IMAGE_NODE;
  const language = await resolveDetectedLanguage(orgId, repoFullName).catch(() => undefined);
  if (!language) return SANDBOX_IMAGE_NODE;
  return LANGUAGE_IMAGE_MAP[language] ?? SANDBOX_IMAGE_NODE;
}
