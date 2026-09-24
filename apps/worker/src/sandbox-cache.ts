import { createHash } from "node:crypto";
import type { SandboxVolume } from "./sandbox/types";

export const DEPENDENCY_CACHE_DIR = "/cache";
export const DEPENDENCY_CACHE_VOLUME_PREFIX = "arata-deps-cache-org-";
const REPO_SLUG_MAX_CHARS = 40;

export function dependencyCacheVolume(orgId: number, repoFullName: string): SandboxVolume {
  const normalized = repoFullName.toLowerCase();
  const slug = normalized.replace(/[^a-z0-9_.-]+/g, "-").slice(0, REPO_SLUG_MAX_CHARS);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return { name: `${DEPENDENCY_CACHE_VOLUME_PREFIX}${orgId}-${slug}-${hash}`, target: DEPENDENCY_CACHE_DIR };
}

export interface ParsedCacheVolumeName {
  orgId: number;
  perRepo: boolean;
}

export function parseDependencyCacheVolumeName(name: string): ParsedCacheVolumeName | undefined {
  if (!name.startsWith(DEPENDENCY_CACHE_VOLUME_PREFIX)) return undefined;
  const match = /^(\d+)(-.+)?$/.exec(name.slice(DEPENDENCY_CACHE_VOLUME_PREFIX.length));
  if (!match) return undefined;
  return { orgId: Number(match[1]), perRepo: Boolean(match[2]) };
}

export function dependencyCacheEnv(): Record<string, string> {
  const dir = DEPENDENCY_CACHE_DIR;
  return {
    XDG_DATA_HOME: `${dir}/xdg-data`,
    XDG_CACHE_HOME: `${dir}/xdg-cache`,
    npm_config_cache: `${dir}/npm`,
    YARN_CACHE_FOLDER: `${dir}/yarn`,
    YARN_GLOBAL_FOLDER: `${dir}/yarn-berry`,
    PIP_CACHE_DIR: `${dir}/pip`,
    UV_CACHE_DIR: `${dir}/uv`,
    UV_LINK_MODE: "copy",
    POETRY_CACHE_DIR: `${dir}/poetry`,
    MAVEN_OPTS: `-Dmaven.repo.local=${dir}/m2/repository`,
    GRADLE_USER_HOME: `${dir}/gradle`,
  };
}
