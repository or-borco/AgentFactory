import { and, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { CODEBASE_SETUP_COMMAND_MAX_CHARS, codebaseSettings } from "../schema";

export interface CodebaseSettings {
  orgId: number;
  repoFullName: string;
  setupCommand: string | null;
  updatedAt: string;
}

function toCodebaseSettings(row: typeof codebaseSettings.$inferSelect): CodebaseSettings {
  return {
    orgId: row.orgId,
    repoFullName: row.repoFullName,
    setupCommand: row.setupCommand,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getCodebaseSettings(orgId: number, repoFullName: string): Promise<CodebaseSettings | undefined> {
  const [row] = await db
    .select()
    .from(codebaseSettings)
    .where(and(eq(codebaseSettings.orgId, orgId), eq(codebaseSettings.repoFullName, repoFullName)));
  return row ? toCodebaseSettings(row) : undefined;
}

export async function listCodebaseSettings(orgId: number): Promise<CodebaseSettings[]> {
  const rows = await db
    .select()
    .from(codebaseSettings)
    .where(eq(codebaseSettings.orgId, orgId))
    .orderBy(codebaseSettings.repoFullName);
  return rows.map(toCodebaseSettings);
}

export function normalizeSetupCommand(setupCommand: string | null): string | null {
  const trimmed = setupCommand?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export async function setCodebaseSetupCommand(
  orgId: number,
  repoFullName: string,
  setupCommand: string | null,
): Promise<CodebaseSettings> {
  const normalized = normalizeSetupCommand(setupCommand);
  if (normalized && normalized.length > CODEBASE_SETUP_COMMAND_MAX_CHARS) {
    throw new Error(`Setup command exceeds ${CODEBASE_SETUP_COMMAND_MAX_CHARS} characters`);
  }
  const [row] = await db
    .insert(codebaseSettings)
    .values({ orgId, repoFullName, setupCommand: normalized })
    .onConflictDoUpdate({
      target: [codebaseSettings.orgId, codebaseSettings.repoFullName],
      set: { setupCommand: normalized, updatedAt: sql`now()` },
    })
    .returning();
  return toCodebaseSettings(row!);
}
