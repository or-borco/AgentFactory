import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";
import {
  detectEcosystems,
  fingerprintSetup,
  parseProbeOutput,
  parseStepOutput,
  planDependencySetup,
  runDependencySetup,
  selectVerificationScripts,
  type SetupMarker,
} from "../dependency-setup";

const ids = (files: string[]) => detectEcosystems(files).map((ecosystem) => ecosystem.id);

describe("detectEcosystems", () => {
  it.each([
    [["package.json", "pnpm-lock.yaml"], ["pnpm"]],
    [["package.json", "package-lock.json"], ["npm"]],
    [["package.json", "yarn.lock"], ["yarn"]],
    [["pyproject.toml", "uv.lock"], ["uv"]],
    [["pyproject.toml", "poetry.lock"], ["poetry"]],
    [["requirements.txt"], ["pip"]],
    [["requirements-dev.txt"], ["pip"]],
    [["pom.xml"], ["maven"]],
    [["build.gradle.kts", "gradlew"], ["gradle-wrapper"]],
    [["build.gradle"], ["gradle"]],
  ])("detects %j as %j", (files, expected) => {
    expect(ids(files)).toEqual(expected);
  });

  it("prefers pnpm over a stray package-lock.json in the same repo", () => {
    expect(ids(["pnpm-lock.yaml", "package-lock.json"])).toEqual(["pnpm"]);
  });

  it("prefers uv over requirements files", () => {
    expect(ids(["uv.lock", "requirements.txt"])).toEqual(["uv"]);
  });

  it("returns one ecosystem per group for a polyglot repo", () => {
    expect(ids(["pnpm-lock.yaml", "poetry.lock", "pom.xml"])).toEqual(["pnpm", "poetry", "maven"]);
  });

  it("detects nothing for a package.json without a lockfile", () => {
    expect(ids(["package.json", "README.md"])).toEqual([]);
  });

  it("does not treat a prefix-only match as a requirements file", () => {
    expect(ids(["requirements.txt.bak", "my-requirements.txt"])).toEqual([]);
  });
});

describe("planDependencySetup", () => {
  it("plans nothing when no manifest is recognised", () => {
    expect(planDependencySetup(["README.md"])).toEqual({ source: "none", steps: [] });
  });

  it("plans the detected install commands in table order", () => {
    const plan = planDependencySetup(["requirements.txt", "pnpm-lock.yaml"]);
    expect(plan.source).toBe("detected");
    expect(plan.steps.map((step) => step.command)).toEqual([
      "pnpm install --frozen-lockfile",
      expect.stringContaining("python3 -m venv .venv"),
    ]);
  });
});

describe("planDependencySetup with an override", () => {
  it("replaces every detected install with the override command", () => {
    const plan = planDependencySetup(["pnpm-lock.yaml", "requirements.txt"], "make deps");
    expect(plan.source).toBe("override");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ label: "override", command: "make deps", scriptRunner: "pnpm" });
    expect(plan.steps[0]?.tool).toBeUndefined();
  });

  it("runs the override even when no manifest is recognised", () => {
    expect(planDependencySetup(["Makefile"], "make deps")).toMatchObject({
      source: "override",
      steps: [{ command: "make deps" }],
    });
  });

  it.each([undefined, null, "", "   "])("falls back to detection for an empty override (%j)", (override) => {
    expect(planDependencySetup(["pnpm-lock.yaml"], override)).toMatchObject({
      source: "detected",
      steps: [{ command: "pnpm install --frozen-lockfile" }],
    });
  });

  it("re-runs the install when the override changes", () => {
    const files = { "pnpm-lock.yaml": "a" };
    const before = fingerprintSetup(planDependencySetup(Object.keys(files), "make deps").steps, files);
    const after = fingerprintSetup(planDependencySetup(Object.keys(files), "make deps-v2").steps, files);
    expect(before).not.toBe(after);
  });
});

describe("selectVerificationScripts", () => {
  it("keeps verification-shaped scripts and drops lifecycle hooks", () => {
    const packageJson = JSON.stringify({
      scripts: { dev: "next dev", typecheck: "tsc", lint: "eslint .", "test:unit": "vitest", prebuild: "x", build: "tsc -b" },
    });
    expect(selectVerificationScripts(packageJson, "pnpm")).toEqual([
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test:unit",
      "pnpm build",
    ]);
  });

  it("returns nothing for missing or malformed package.json", () => {
    expect(selectVerificationScripts(undefined, "npm run")).toEqual([]);
    expect(selectVerificationScripts("{not json", "npm run")).toEqual([]);
    expect(selectVerificationScripts(JSON.stringify({ name: "x" }), "npm run")).toEqual([]);
  });
});

describe("fingerprintSetup", () => {
  const steps = planDependencySetup(["pnpm-lock.yaml"]).steps;

  it("is stable regardless of file order", () => {
    expect(fingerprintSetup(steps, { a: "1", b: "2" })).toBe(fingerprintSetup(steps, { b: "2", a: "1" }));
  });

  it("changes when a lockfile changes", () => {
    expect(fingerprintSetup(steps, { "pnpm-lock.yaml": "1" })).not.toBe(
      fingerprintSetup(steps, { "pnpm-lock.yaml": "2" }),
    );
  });
});

describe("parseStepOutput", () => {
  it("classifies exit codes", () => {
    expect(parseStepOutput("done\n__ARATA_SETUP_EXIT__:0\n").status).toBe("ok");
    expect(parseStepOutput("boom\n__ARATA_SETUP_EXIT__:1\n")).toMatchObject({ status: "failed", exitCode: 1, output: "boom\n" });
    expect(parseStepOutput("__ARATA_SETUP_EXIT__:124\n").status).toBe("timed_out");
    expect(parseStepOutput("__ARATA_SETUP_MISSING_TOOL__\n").status).toBe("missing_tool");
    expect(parseStepOutput("killed without a marker").status).toBe("failed");
  });
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function probeOutput(files: Record<string, string>, marker?: SetupMarker, packageJson?: string): string {
  const lines = Object.entries(files).map(([file, hash]) => `__ARATA_FILE__:${hash}  ${file}`);
  if (marker) lines.push(`__ARATA_MARKER__:${Buffer.from(JSON.stringify(marker)).toString("base64")}`);
  if (packageJson) lines.push(`__ARATA_PACKAGE_JSON__:${Buffer.from(packageJson).toString("base64")}`);
  return `${lines.join("\n")}\n`;
}

describe("parseProbeOutput", () => {
  it("reads file hashes, the marker, and package.json", () => {
    const marker: SetupMarker = { fingerprint: "abc", steps: [] };
    const probe = parseProbeOutput(probeOutput({ "pnpm-lock.yaml": HASH_A }, marker, '{"name":"x"}'));
    expect(probe).toEqual({ fileHashes: { "pnpm-lock.yaml": HASH_A }, marker, packageJson: '{"name":"x"}' });
  });

  it("ignores a marker it cannot decode", () => {
    const probe = parseProbeOutput("__ARATA_MARKER__:bm90IGpzb24=\n");
    expect(probe.marker).toBeUndefined();
  });
});

function fakeSandbox(respond: (script: string, env?: Record<string, string>) => string | Error) {
  const calls: Array<{ script: string; env?: Record<string, string> }> = [];
  const provider: SandboxProvider = {
    create: vi.fn(),
    exec: async function* (_id: string, cmd: string[], opts?: { env?: Record<string, string> }) {
      const script = cmd[2] ?? "";
      calls.push({ script, env: opts?.env });
      const result = respond(script, opts?.env);
      if (result instanceof Error) throw result;
      yield { stream: "stdout", data: result } satisfies OutputChunk;
    },
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    resetMemory: vi.fn(),
    interrupt: vi.fn(),
  };
  return { provider, calls };
}

const isProbe = (script: string) => script.includes("__ARATA_FILE__");
const isStep = (env?: Record<string, string>) => Boolean(env?.ARATA_SETUP_COMMAND);

describe("runDependencySetup", () => {
  const packageJson = JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint ." } });

  it("installs, writes the marker, and reports verification commands", async () => {
    const { provider, calls } = fakeSandbox((script, env) => {
      if (isProbe(script)) return probeOutput({ "package.json": HASH_B, "pnpm-lock.yaml": HASH_A }, undefined, packageJson);
      if (isStep(env)) return "Packages: +12\n__ARATA_SETUP_EXIT__:0\n";
      return "";
    });

    const outcome = await runDependencySetup(provider, "sbx");

    expect(outcome.status).toBe("installed");
    expect(outcome.source).toBe("detected");
    expect(outcome.steps).toEqual([
      expect.objectContaining({ label: "pnpm", command: "pnpm install --frozen-lockfile", status: "ok" }),
    ]);
    expect(outcome.verificationCommands).toEqual(["pnpm typecheck", "pnpm lint"]);
    const written = JSON.parse(calls.find((call) => call.env?.ARATA_SETUP_MARKER)?.env?.ARATA_SETUP_MARKER ?? "{}");
    expect(written.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(written.steps).toEqual([expect.objectContaining({ status: "ok" })]);
  });

  it("skips the install when the marker matches the current lockfiles", async () => {
    const files = { "package.json": HASH_B, "pnpm-lock.yaml": HASH_A };
    const fingerprint = fingerprintSetup(planDependencySetup(Object.keys(files)).steps, files);
    const marker: SetupMarker = { fingerprint, steps: [{ label: "pnpm", command: "x", status: "ok", durationMs: 1 }] };
    const { provider, calls } = fakeSandbox((script) => (isProbe(script) ? probeOutput(files, marker, packageJson) : ""));

    const outcome = await runDependencySetup(provider, "sbx");

    expect(outcome.status).toBe("up_to_date");
    expect(outcome.reused).toBe(true);
    expect(outcome.steps[0]?.status).toBe("up_to_date");
    expect(outcome.verificationCommands).toEqual(["pnpm typecheck", "pnpm lint"]);
    expect(calls.some((call) => isStep(call.env))).toBe(false);
  });

  it("reports a remembered failure without re-running the install", async () => {
    const files = { "pnpm-lock.yaml": HASH_A };
    const fingerprint = fingerprintSetup(planDependencySetup(Object.keys(files)).steps, files);
    const failedStep = { label: "pnpm", command: "pnpm install --frozen-lockfile", status: "timed_out" as const, durationMs: 300000 };
    const { provider, calls } = fakeSandbox((script) =>
      isProbe(script) ? probeOutput(files, { fingerprint, steps: [failedStep] }) : "",
    );

    const outcome = await runDependencySetup(provider, "sbx");

    expect(outcome).toMatchObject({ status: "failed", reused: true, steps: [failedStep] });
    expect(calls.some((call) => isStep(call.env))).toBe(false);
  });

  it("retries after a failure once the lockfile changes", async () => {
    const failedStep = { label: "pnpm", command: "pnpm install --frozen-lockfile", status: "failed" as const, durationMs: 1 };
    const { provider, calls } = fakeSandbox((script, env) => {
      if (isProbe(script)) return probeOutput({ "pnpm-lock.yaml": HASH_B }, { fingerprint: "stale", steps: [failedStep] });
      if (isStep(env)) return "__ARATA_SETUP_EXIT__:0\n";
      return "";
    });

    const outcome = await runDependencySetup(provider, "sbx");

    expect(outcome).toMatchObject({ status: "installed", reused: false });
    expect(calls.some((call) => isStep(call.env))).toBe(true);
  });

  it("reports a failed step with its output and remembers the failure", async () => {
    const { provider, calls } = fakeSandbox((script, env) => {
      if (isProbe(script)) return probeOutput({ "pnpm-lock.yaml": HASH_A });
      if (isStep(env)) return "ERR_PNPM_OUTDATED_LOCKFILE\n__ARATA_SETUP_EXIT__:1\n";
      return "";
    });

    const outcome = await runDependencySetup(provider, "sbx");

    expect(outcome.status).toBe("failed");
    expect(outcome.steps[0]).toMatchObject({ status: "failed", exitCode: 1, outputTail: "ERR_PNPM_OUTDATED_LOCKFILE" });
    expect(outcome.verificationCommands).toEqual([]);
    const written = JSON.parse(calls.find((call) => call.env?.ARATA_SETUP_MARKER)?.env?.ARATA_SETUP_MARKER ?? "{}");
    expect(written.steps).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("reports a timeout", async () => {
    const { provider } = fakeSandbox((script, env) => {
      if (isProbe(script)) return probeOutput({ "pom.xml": HASH_A });
      if (isStep(env)) return "__ARATA_SETUP_EXIT__:124\n";
      return "";
    });

    const outcome = await runDependencySetup(provider, "sbx", { timeoutSeconds: 5 });

    expect(outcome.status).toBe("failed");
    expect(outcome.steps[0]?.status).toBe("timed_out");
  });

  it("never throws when the sandbox exec itself fails", async () => {
    const { provider } = fakeSandbox(() => new Error("container gone"));

    const outcome = await runDependencySetup(provider, "sbx");

    expect(outcome.status).toBe("failed");
    expect(outcome.steps[0]?.outputTail).toBe("container gone");
  });

  it("runs the override instead of the detected install", async () => {
    const { provider, calls } = fakeSandbox((script, env) => {
      if (isProbe(script)) return probeOutput({ "pnpm-lock.yaml": HASH_A }, undefined, packageJson);
      if (isStep(env)) return "__ARATA_SETUP_EXIT__:0\n";
      return "";
    });

    const outcome = await runDependencySetup(provider, "sbx", { overrideCommand: "./scripts/bootstrap.sh" });

    expect(outcome).toMatchObject({ status: "installed", source: "override" });
    const commands = calls.filter((call) => isStep(call.env)).map((call) => call.env?.ARATA_SETUP_COMMAND);
    expect(commands).toEqual(["./scripts/bootstrap.sh"]);
    expect(outcome.verificationCommands).toEqual(["pnpm typecheck", "pnpm lint"]);
  });

  it("returns not_detected when no manifest is present", async () => {
    const { provider } = fakeSandbox((script) => (isProbe(script) ? probeOutput({}) : ""));

    await expect(runDependencySetup(provider, "sbx")).resolves.toMatchObject({ status: "not_detected", steps: [] });
  });
});
