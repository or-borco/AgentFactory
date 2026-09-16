import { listAgentSkills, getSkillVersion, getSkillVersionMarkdown } from "@agentfactory/db";
import { createLogger } from "@agentfactory/logger";
import type { SandboxProvider } from "./sandbox/types";
import { SKILL_DIR } from "./skill-paths";

const log = createLogger("skills-materialize");

export { SKILL_DIR, SKILL_EXCLUDE_PATTERN } from "./skill-paths";

// Writes each of the agent's pinned skill versions into the sandbox at
// .claude/skills/<slug>/SKILL.md, so the Claude Agent SDK discovers and can load them. Never
// fails the run — same degrade-to-empty contract as materialiseTaskDocuments: a skill that can't
// be materialized is dropped from the enabled list and logged, not a run-ending error.
//
// skillDir defaults to SKILL_DIR (the Claude Agent SDK's own discovery path) — a future
// AgentRuntime adapter with a different skill-discovery directory passes its own via
// capabilities().skillDir (see worker.ts).
export async function materialiseSkills(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  agentId: number,
  orgId: number,
  opts?: { skillDir?: string },
): Promise<string[]> {
  try {
    const skillDir = opts?.skillDir ?? SKILL_DIR;
    const pins = await listAgentSkills(agentId);
    if (pins.length === 0) return [];

    const files: Record<string, string> = {};
    const written: string[] = [];

    for (const pin of pins) {
      const version = await getSkillVersion(pin.skillVersionId);
      if (!version) {
        log.error("Skill pin references missing version", { agentId, skillVersionId: pin.skillVersionId });
        continue;
      }
      const markdown = await getSkillVersionMarkdown(orgId, version);
      if (!markdown) {
        log.error("Skill version has no blob", { skillVersionId: version.id, skillSlug: pin.skillSlug, bodySha256: version.bodySha256 });
        continue;
      }
      files[`${skillDir}/${pin.skillSlug}/SKILL.md`] = markdown;
      written.push(pin.skillSlug);
    }

    if (written.length === 0) return [];

    for (const slug of written) {
      await execToCompletion(sandboxProvider, sandboxId, ["mkdir", "-p", `/workspace/${skillDir}/${slug}`]);
    }
    await sandboxProvider.writeFiles(sandboxId, files);
    return written;
  } catch (err) {
    log.error("Failed to materialise skills", { agentId, err });
    return [];
  }
}

async function execToCompletion(sandboxProvider: SandboxProvider, sandboxId: string, cmd: string[]): Promise<void> {
  for await (const _chunk of sandboxProvider.exec(sandboxId, cmd)) {
    // drained, not collected — same as task-documents.ts's helper
  }
}
