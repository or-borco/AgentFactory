import type { SandboxVolume } from "./sandbox/types";

export const DEPENDENCY_CACHE_DIR = "/cache";

export function dependencyCacheVolume(orgId: number): SandboxVolume {
  return { name: `arata-deps-cache-org-${orgId}`, target: DEPENDENCY_CACHE_DIR };
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
