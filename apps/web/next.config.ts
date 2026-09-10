import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Pin the workspace root to this checkout. Without this, Turbopack's root inference walks up
// from cwd looking for a lockfile/pnpm-workspace.yaml and — because this repo runs as a bare
// repo with git worktrees nested under .claude/worktrees/*, each worktree containing its own
// full checkout (and its own pnpm-workspace.yaml) — it can walk straight past this worktree's
// root into a sibling worktree's or the bare repo's own stale top-level checkout, colliding
// with whatever dev server is already running there.
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  transpilePackages: [
    "@agentfactory/core",
    "@agentfactory/shared",
    "@agentfactory/db",
    "@agentfactory/queue",
    "@agentfactory/storage",
  ],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
