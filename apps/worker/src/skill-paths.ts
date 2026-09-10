// Mirrors task-document-paths.ts: a leaf module with no imports, so both skills-materialize.ts
// (which writes the files) and scm-provider.ts (which teaches git to ignore them) can share
// these two strings without pulling storage/db into scm-provider's import graph.

// The Claude Agent SDK's own project-level skill discovery path, relative to /workspace (cwd) —
// not a free choice of directory name the way TASK_DOCUMENT_DIR is.
export const SKILL_DIR = ".claude/skills";

export const SKILL_EXCLUDE_PATTERN = "/.claude/skills/";
