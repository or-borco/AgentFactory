import { listAgentSkills } from "@agentfactory/db";
import { getSkillVersion, getSkillVersionMarkdown } from "@agentfactory/db";
import { createBlobStore, type BlobStore } from "@agentfactory/storage";
import type { SandboxProvider } from "./sandbox/types";
import { SKILL_DIR } from "./skill-paths";

export { SKILL_DIR, SKILL_EXCLUDE_PATTERN } from "./skill-paths";

export interface SkillMaterializeDeps {
  listAgentSkills: (agentId: number) => Promise<Array<{ skillId: number; skillVersionId: number; skillSlug: string }>>;
  getSkillVersion: (id: number) => ReturnType<typeof getSkillVersion>;
  getSkillVersionMarkdown: (orgId: number, version: NonNullable<Awaited<ReturnType<typeof getSkillVersion>>>) => Promise<string | undefined>;
  blobStore: BlobStore;
}

function resolveDeps(overrides?: Partial<SkillMaterializeDeps>): SkillMaterializeDeps {
  return {
    listAgentSkills,
    getSkillVersion,
    getSkillVersionMarkdown,
    blobStore: overrides?.blobStore ?? createBlobStore(),
    ...overrides,
  };
}

// Writes each of the agent's pinned skill versions into the sandbox at
// .claude/skills/<slug>/SKILL.md, so the Claude Agent SDK discovers and can load them. Never
// fails the run — same degrade-to-empty contract as materialiseTaskDocuments: a skill that can't
// be materialized is dropped from the enabled list and logged, not a run-ending error.
export async function materialiseSkills(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  agentId: number,
  orgId: number,
  deps?: Partial<SkillMaterializeDeps>,
): Promise<string[]> {
  try {
    const resolved = resolveDeps(deps);
    const pins = await resolved.listAgentSkills(agentId);
    if (pins.length === 0) return [];

    const files: Record<string, string> = {};
    const written: string[] = [];

    for (const pin of pins) {
      const version = await resolved.getSkillVersion(pin.skillVersionId);
      if (!version) {
        console.error(`Agent ${agentId} skill pin references missing version ${pin.skillVersionId}`);
        continue;
      }
      const markdown = await resolved.getSkillVersionMarkdown(orgId, version);
      if (!markdown) {
        console.error(`Skill version ${version.id} (${pin.skillSlug}) has no blob under ${version.bodySha256}`);
        continue;
      }
      files[`${SKILL_DIR}/${pin.skillSlug}/SKILL.md`] = markdown;
      written.push(pin.skillSlug);
    }

    if (written.length === 0) return [];

    for (const slug of written) {
      await execToCompletion(sandboxProvider, sandboxId, ["mkdir", "-p", `/workspace/${SKILL_DIR}/${slug}`]);
    }
    await sandboxProvider.writeFiles(sandboxId, files);
    return written;
  } catch (err) {
    console.error(`Failed to materialise skills for agent ${agentId}:`, err);
    return [];
  }
}

async function execToCompletion(sandboxProvider: SandboxProvider, sandboxId: string, cmd: string[]): Promise<void> {
  for await (const _chunk of sandboxProvider.exec(sandboxId, cmd)) {
    // drained, not collected — same as task-documents.ts's helper
  }
}
