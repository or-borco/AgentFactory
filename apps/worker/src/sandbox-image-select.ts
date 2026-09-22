import { resolveDetectedLanguage } from "./scm-provider";

export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "agentfactory-sandbox:local";
export const SANDBOX_IMAGE_PYTHON = process.env.SANDBOX_IMAGE_PYTHON ?? "agentfactory-sandbox-python:local";
export const SANDBOX_IMAGE_JAVA = process.env.SANDBOX_IMAGE_JAVA ?? "agentfactory-sandbox-java:local";

const LANGUAGE_IMAGE_MAP: Record<string, string> = {
  Python: SANDBOX_IMAGE_PYTHON,
  Java: SANDBOX_IMAGE_JAVA,
};

export async function resolveSandboxImage(orgId: number, repoFullName: string | undefined): Promise<string> {
  if (!repoFullName) return SANDBOX_IMAGE;
  const language = await resolveDetectedLanguage(orgId, repoFullName).catch(() => undefined);
  if (!language) return SANDBOX_IMAGE;
  return LANGUAGE_IMAGE_MAP[language] ?? SANDBOX_IMAGE;
}
