import { describe, expect, it } from "vitest";
import { DEPENDENCY_CACHE_DIR, dependencyCacheEnv, dependencyCacheVolume } from "../sandbox-cache";

describe("dependencyCacheVolume", () => {
  it("gives each org its own volume mounted at the cache dir", () => {
    expect(dependencyCacheVolume(7)).toMatchObject({ name: "arata-deps-cache-org-7", target: "/cache" });
    expect(dependencyCacheVolume(7).name).not.toBe(dependencyCacheVolume(8).name);
  });
});

describe("dependencyCacheEnv", () => {
  it("points every supported package manager cache inside the mounted volume", () => {
    const env = dependencyCacheEnv();
    for (const key of [
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "npm_config_cache",
      "YARN_CACHE_FOLDER",
      "PIP_CACHE_DIR",
      "UV_CACHE_DIR",
      "POETRY_CACHE_DIR",
      "GRADLE_USER_HOME",
    ]) {
      expect(env[key]?.startsWith(`${DEPENDENCY_CACHE_DIR}/`)).toBe(true);
    }
    expect(env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${DEPENDENCY_CACHE_DIR}/m2/repository`);
  });
});
