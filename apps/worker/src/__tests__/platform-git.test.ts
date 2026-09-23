import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  platformGitEnv,
  refuseUnsafeGitConfig,
  unsafeGitConfigError,
  unsafeGitConfigKeys,
} from "../platform-git";

let repo: string;

function sh(script: string, env: Record<string, string> = {}): string {
  return execFileSync("sh", ["-c", script], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", HOME: repo, ...env },
    encoding: "utf8",
  });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "platform-git-"));
  sh("git init -q . && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("platformGitEnv", () => {
  it("stops a repo-installed hook from running during a platform commit", () => {
    const marker = path.join(repo, "hook-ran");
    mkdirSync(path.join(repo, ".husky"));
    writeFileSync(path.join(repo, ".husky", "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(path.join(repo, ".husky", "pre-commit"), 0o755);
    sh("git config core.hooksPath .husky");

    sh("git -c user.email=a@b -c user.name=a commit -q --allow-empty -m platform", platformGitEnv());

    expect(existsSync(marker)).toBe(false);
  });

  it("really does run that hook without the platform env, proving the test exercises it", () => {
    const marker = path.join(repo, "hook-ran");
    mkdirSync(path.join(repo, ".husky"));
    writeFileSync(path.join(repo, ".husky", "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(path.join(repo, ".husky", "pre-commit"), 0o755);
    sh("git config core.hooksPath .husky");

    sh("git -c user.email=a@b -c user.name=a commit -q --allow-empty -m plain");

    expect(existsSync(marker)).toBe(true);
  });
});

describe("refuseUnsafeGitConfig", () => {
  const check = () => sh(`${refuseUnsafeGitConfig(repo)}\necho SAFE`, platformGitEnv());

  it("passes a freshly cloned-style config", () => {
    expect(check()).toBe("SAFE\n");
  });

  it("passes husky's hooksPath, which the platform env overrides instead", () => {
    sh("git config core.hooksPath .husky");
    expect(check()).toBe("SAFE\n");
  });

  it.each([
    ["url.https://evil.example/.insteadOf", "https://github.com/", "url.https://evil.example/.insteadof"],
    ["http.https://github.com/.proxy", "http://evil.example:8080", "http.https://github.com/.proxy"],
    ["http.sslVerify", "false", "http.sslverify"],
    ["credential.helper", "!sh -c 'cat > /tmp/stolen'", "credential.helper"],
    ["include.path", "/tmp/more-config", "include.path"],
    ["filter.x.clean", "sh -c 'env > /tmp/env'", "filter.x.clean"],
    ["merge.x.driver", "sh -c id", "merge.x.driver"],
    ["diff.x.textconv", "sh -c id", "diff.x.textconv"],
    ["core.sshCommand", "sh -c id", "core.sshcommand"],
  ])("refuses %s before any token is used", (key, value, reported) => {
    sh(`git config ${JSON.stringify(key)} ${JSON.stringify(value)}`);

    const output = check();

    expect(output).not.toMatch(/^SAFE$/m);
    expect(unsafeGitConfigKeys(output)).toEqual([reported]);
  });
});

describe("unsafeGitConfigKeys", () => {
  it("returns undefined when nothing was refused", () => {
    expect(unsafeGitConfigKeys("SYNC_UP_TO_DATE\n")).toBeUndefined();
  });

  it("names the offending keys in the error", () => {
    expect(unsafeGitConfigError(["http.proxy"]).message).toContain("http.proxy");
  });
});
