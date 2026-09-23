import { createHash } from "node:crypto";
import type { DependencyInstallStep } from "@agentfactory/core";
import type { SandboxProvider } from "./sandbox/types";

export type StepResult = DependencyInstallStep;
export type StepStatus = StepResult["status"];

export type EcosystemGroup = "node" | "python" | "jvm";

export interface Ecosystem {
  id: string;
  group: EcosystemGroup;
  matches: string[];
  requires?: string[];
  tool: string;
  install: string;
  scriptRunner?: string;
  verification: string[];
  note?: string;
}

const PYTHON_VENV_NOTE =
  "Python packages are installed in the virtualenv at `/workspace/.venv`. Run tools through it " +
  "(for example `.venv/bin/python -m pytest`) instead of the system Python.";

export const ECOSYSTEMS: Ecosystem[] = [
  {
    id: "pnpm",
    group: "node",
    matches: ["pnpm-lock.yaml"],
    tool: "pnpm",
    install: "pnpm install --frozen-lockfile",
    scriptRunner: "pnpm",
    verification: [],
  },
  {
    id: "yarn",
    group: "node",
    matches: ["yarn.lock"],
    tool: "yarn",
    install: "yarn install --immutable",
    scriptRunner: "yarn",
    verification: [],
  },
  {
    id: "npm",
    group: "node",
    matches: ["package-lock.json"],
    tool: "npm",
    install: "npm ci",
    scriptRunner: "npm run",
    verification: [],
  },
  {
    id: "uv",
    group: "python",
    matches: ["uv.lock"],
    tool: "uv",
    install: "uv sync --frozen",
    verification: [],
    note: PYTHON_VENV_NOTE,
  },
  {
    id: "poetry",
    group: "python",
    matches: ["poetry.lock"],
    tool: "poetry",
    install: "POETRY_VIRTUALENVS_IN_PROJECT=true poetry install --no-root --no-interaction",
    verification: [],
    note: PYTHON_VENV_NOTE,
  },
  {
    id: "pip",
    group: "python",
    matches: ["requirements*.txt"],
    tool: "python3",
    install:
      "python3 -m venv .venv && .venv/bin/pip install --quiet " +
      "$(for f in requirements*.txt; do printf -- '-r %s ' \"$f\"; done)",
    verification: [],
    note: PYTHON_VENV_NOTE,
  },
  {
    id: "maven",
    group: "jvm",
    matches: ["pom.xml"],
    tool: "mvn",
    install: "mvn -q -B dependency:go-offline",
    verification: ["mvn -o -q test"],
  },
  {
    id: "gradle-wrapper",
    group: "jvm",
    matches: ["build.gradle", "build.gradle.kts"],
    requires: ["gradlew"],
    tool: "java",
    install: "sh ./gradlew --no-daemon -q dependencies",
    verification: ["./gradlew --offline test"],
  },
  {
    id: "gradle",
    group: "jvm",
    matches: ["build.gradle", "build.gradle.kts"],
    tool: "gradle",
    install: "gradle --no-daemon -q dependencies",
    verification: ["gradle --offline test"],
  },
];

export const DEPENDENCY_INSTALL_TIMEOUT_SECONDS = 300;
export const PYTHON_VENV_EXCLUDE_PATTERN = "/.venv/";
export const DEPENDENCY_MARKER_PATH = ".git/arata-deps-installed";
const OUTPUT_TAIL_CHARS = 1500;
const MAX_VERIFICATION_COMMANDS = 12;
const SCRIPT_NAME_PATTERN = /^[\w:.-]{1,64}$/;
const STEP_OUTPUT_MAX_CHARS = 16 * 1024;
const PROBE_OUTPUT_MAX_CHARS = 512 * 1024;
const STEP_STATUSES: ReadonlySet<StepStatus> = new Set(["ok", "failed", "timed_out", "missing_tool"]);
const EXIT_MARKER = "__ARATA_SETUP_EXIT__:";
const MISSING_TOOL_MARKER = "__ARATA_SETUP_MISSING_TOOL__";
const FILE_HASH_MARKER = "__ARATA_FILE__:";
const INSTALL_MARKER = "__ARATA_MARKER__:";
const PACKAGE_JSON_MARKER = "__ARATA_PACKAGE_JSON__:";
const TIMEOUT_EXIT_CODES = new Set([124, 137]);
const VERIFICATION_SCRIPT_PATTERN = /type-?check|tsc|lint|test|check|build|format/i;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function anyFileMatches(files: string[], pattern: string): boolean {
  const regex = globToRegExp(pattern);
  return files.some((file) => regex.test(file));
}

export function detectEcosystems(presentFiles: string[], table: Ecosystem[] = ECOSYSTEMS): Ecosystem[] {
  const chosen = new Map<EcosystemGroup, Ecosystem>();
  for (const ecosystem of table) {
    if (chosen.has(ecosystem.group)) continue;
    const matched = ecosystem.matches.some((pattern) => anyFileMatches(presentFiles, pattern));
    const satisfied = (ecosystem.requires ?? []).every((pattern) => anyFileMatches(presentFiles, pattern));
    if (matched && satisfied) chosen.set(ecosystem.group, ecosystem);
  }
  return [...chosen.values()];
}

export interface SetupStep {
  label: string;
  tool?: string;
  command: string;
  scriptRunner?: string;
  verification: string[];
  note?: string;
}

export type DependencySetupPlan =
  | { source: "override"; steps: [SetupStep] }
  | { source: "detected"; steps: SetupStep[] }
  | { source: "none"; steps: [] };

export function planDependencySetup(presentFiles: string[], overrideCommand?: string | null): DependencySetupPlan {
  const ecosystems = detectEcosystems(presentFiles);
  const override = overrideCommand?.trim();
  if (override) {
    return {
      source: "override",
      steps: [
        {
          label: "override",
          command: override,
          scriptRunner: ecosystems.find((ecosystem) => ecosystem.scriptRunner)?.scriptRunner,
          verification: ecosystems.flatMap((ecosystem) => ecosystem.verification),
        },
      ],
    };
  }
  if (ecosystems.length === 0) return { source: "none", steps: [] };
  return {
    source: "detected",
    steps: ecosystems.map((ecosystem) => ({
      label: ecosystem.id,
      tool: ecosystem.tool,
      command: ecosystem.install,
      scriptRunner: ecosystem.scriptRunner,
      verification: ecosystem.verification,
      note: ecosystem.note,
    })),
  };
}

export function selectVerificationScripts(packageJson: string | undefined, runner: string): string[] {
  if (!packageJson) return [];
  let scripts: unknown;
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (!scripts || typeof scripts !== "object") return [];
  return Object.keys(scripts)
    .filter(
      (name) =>
        SCRIPT_NAME_PATTERN.test(name) && !/^(pre|post)/.test(name) && VERIFICATION_SCRIPT_PATTERN.test(name),
    )
    .slice(0, MAX_VERIFICATION_COMMANDS)
    .map((name) => `${runner} ${name}`);
}

export function fingerprintSetup(steps: SetupStep[], fileHashes: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const step of steps) hash.update(`step:${step.command}\n`);
  for (const file of Object.keys(fileHashes).sort()) hash.update(`file:${file}:${fileHashes[file]}\n`);
  return hash.digest("hex");
}

export interface MarkerStep {
  status: StepStatus;
  exitCode?: number;
}

export interface SetupMarker {
  fingerprint: string;
  steps: MarkerStep[];
}

export interface WorkspaceProbe {
  fileHashes: Record<string, string>;
  marker?: SetupMarker;
  packageJson?: string;
}

function probePatterns(): string[] {
  const patterns = new Set<string>(["package.json"]);
  for (const ecosystem of ECOSYSTEMS) {
    for (const pattern of [...ecosystem.matches, ...(ecosystem.requires ?? [])]) patterns.add(pattern);
  }
  return [...patterns];
}

function probeScript(): string {
  return `
cd /workspace 2>/dev/null || exit 0
for f in ${probePatterns().join(" ")}; do
  [ -f "$f" ] && printf '${FILE_HASH_MARKER}%s\\n' "$(sha256sum "$f")"
done
[ -f ${DEPENDENCY_MARKER_PATH} ] && printf '${INSTALL_MARKER}%s\\n' "$(base64 -w0 ${DEPENDENCY_MARKER_PATH})"
[ -f package.json ] && printf '${PACKAGE_JSON_MARKER}%s\\n' "$(base64 -w0 package.json)"
exit 0`;
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function parseMarkerStep(value: unknown): MarkerStep | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { status, exitCode } = value as { status?: unknown; exitCode?: unknown };
  if (typeof status !== "string" || !STEP_STATUSES.has(status as StepStatus)) return undefined;
  if (exitCode !== undefined && !(Number.isInteger(exitCode) && (exitCode as number) >= 0 && (exitCode as number) < 256)) {
    return undefined;
  }
  return exitCode === undefined ? { status: status as StepStatus } : { status: status as StepStatus, exitCode: exitCode as number };
}

export function parseMarker(encoded: string): SetupMarker | undefined {
  try {
    const parsed = JSON.parse(decodeBase64(encoded)) as { fingerprint?: unknown; steps?: unknown };
    if (typeof parsed.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(parsed.fingerprint)) return undefined;
    if (!Array.isArray(parsed.steps) || parsed.steps.length > ECOSYSTEMS.length) return undefined;
    const steps = parsed.steps.map(parseMarkerStep);
    if (steps.some((step) => step === undefined)) return undefined;
    return { fingerprint: parsed.fingerprint, steps: steps as MarkerStep[] };
  } catch {
    return undefined;
  }
}

export function parseProbeOutput(stdout: string): WorkspaceProbe {
  const probe: WorkspaceProbe = { fileHashes: {} };
  for (const line of stdout.split("\n")) {
    if (line.startsWith(FILE_HASH_MARKER)) {
      const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.slice(FILE_HASH_MARKER.length));
      if (match) probe.fileHashes[match[2]!] = match[1]!;
    } else if (line.startsWith(INSTALL_MARKER)) {
      probe.marker = parseMarker(line.slice(INSTALL_MARKER.length).trim());
    } else if (line.startsWith(PACKAGE_JSON_MARKER)) {
      probe.packageJson = decodeBase64(line.slice(PACKAGE_JSON_MARKER.length).trim());
    }
  }
  return probe;
}


export interface DependencySetupOutcome {
  status: "not_detected" | "up_to_date" | "installed" | "failed";
  source: DependencySetupPlan["source"];
  durationMs: number;
  reused: boolean;
  steps: StepResult[];
  verificationCommands: string[];
  notes: string[];
}

export interface OutputLimit {
  maxChars: number;
  keep: "head" | "tail";
}

export async function collectStdout(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  cmd: string[],
  limit: OutputLimit,
  env?: Record<string, string>,
): Promise<string> {
  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, cmd, env ? { env } : undefined)) {
    if (chunk.stream !== "stdout") continue;
    if (limit.keep === "head") {
      if (stdout.length < limit.maxChars) stdout = (stdout + chunk.data).slice(0, limit.maxChars);
    } else {
      stdout = (stdout + chunk.data).slice(-limit.maxChars);
    }
  }
  return stdout;
}

function stepScript(timeoutSeconds: number): string {
  return `
cd /workspace || { echo "${EXIT_MARKER}1"; exit 0; }
if [ -n "$ARATA_SETUP_TOOL" ] && ! command -v "$ARATA_SETUP_TOOL" >/dev/null 2>&1; then
  echo "${MISSING_TOOL_MARKER}"
  exit 0
fi
timeout -k 10 ${timeoutSeconds} sh -c "$ARATA_SETUP_COMMAND" 2>&1
echo "${EXIT_MARKER}$?"`;
}

export function parseStepOutput(stdout: string): { status: Exclude<StepStatus, "up_to_date">; exitCode?: number; output: string } {
  if (stdout.includes(MISSING_TOOL_MARKER)) return { status: "missing_tool", output: "" };
  const markerIndex = stdout.lastIndexOf(EXIT_MARKER);
  if (markerIndex === -1) return { status: "failed", output: stdout };
  const output = stdout.slice(0, markerIndex);
  const exitCode = Number.parseInt(stdout.slice(markerIndex + EXIT_MARKER.length), 10);
  if (Number.isNaN(exitCode)) return { status: "failed", output };
  if (exitCode === 0) return { status: "ok", exitCode, output };
  if (TIMEOUT_EXIT_CODES.has(exitCode)) return { status: "timed_out", exitCode, output };
  return { status: "failed", exitCode, output };
}

async function runStep(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  step: SetupStep,
  timeoutSeconds: number,
): Promise<StepResult> {
  const startedAt = Date.now();
  try {
    const stdout = await collectStdout(
      sandboxProvider,
      sandboxId,
      ["sh", "-c", stepScript(timeoutSeconds)],
      { maxChars: STEP_OUTPUT_MAX_CHARS, keep: "tail" },
      { ARATA_SETUP_COMMAND: step.command, ARATA_SETUP_TOOL: step.tool ?? "" },
    );
    const parsed = parseStepOutput(stdout);
    return {
      label: step.label,
      command: step.command,
      status: parsed.status,
      exitCode: parsed.exitCode,
      durationMs: Date.now() - startedAt,
      outputTail: parsed.status === "ok" ? undefined : parsed.output.slice(-OUTPUT_TAIL_CHARS).trim() || undefined,
    };
  } catch (err) {
    return {
      label: step.label,
      command: step.command,
      status: "failed",
      durationMs: Date.now() - startedAt,
      outputTail: err instanceof Error ? err.message : String(err),
    };
  }
}

function verificationCommandsFor(steps: SetupStep[], results: StepResult[], packageJson: string | undefined): string[] {
  const commands: string[] = [];
  steps.forEach((step, index) => {
    const status = results[index]?.status;
    if (status !== "ok" && status !== "up_to_date") return;
    if (step.scriptRunner) commands.push(...selectVerificationScripts(packageJson, step.scriptRunner));
    commands.push(...step.verification);
  });
  return commands;
}

function notesFor(steps: SetupStep[], results: StepResult[]): string[] {
  const notes = new Set<string>();
  steps.forEach((step, index) => {
    const status = results[index]?.status;
    if (step.note && (status === "ok" || status === "up_to_date")) notes.add(step.note);
  });
  return [...notes];
}

export interface DependencySetupOptions {
  timeoutSeconds?: number;
  overrideCommand?: string | null;
}

export async function runDependencySetup(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  options: DependencySetupOptions = {},
): Promise<DependencySetupOutcome> {
  const startedAt = Date.now();
  const timeoutSeconds = options.timeoutSeconds ?? DEPENDENCY_INSTALL_TIMEOUT_SECONDS;
  let probe: WorkspaceProbe;
  try {
    probe = parseProbeOutput(
      await collectStdout(sandboxProvider, sandboxId, ["sh", "-c", probeScript()], {
        maxChars: PROBE_OUTPUT_MAX_CHARS,
        keep: "head",
      }),
    );
  } catch (err) {
    return {
      status: "failed",
      source: "none",
      durationMs: Date.now() - startedAt,
      reused: false,
      steps: [
        {
          label: "probe",
          command: "",
          status: "failed",
          durationMs: Date.now() - startedAt,
          outputTail: err instanceof Error ? err.message : String(err),
        },
      ],
      verificationCommands: [],
      notes: [],
    };
  }

  const plan = planDependencySetup(Object.keys(probe.fileHashes), options.overrideCommand);
  if (plan.steps.length === 0) {
    return {
      status: "not_detected",
      source: plan.source,
      durationMs: Date.now() - startedAt,
      reused: false,
      steps: [],
      verificationCommands: [],
      notes: [],
    };
  }

  const fingerprint = fingerprintSetup(plan.steps, probe.fileHashes);
  const marker = probe.marker;
  if (marker?.fingerprint === fingerprint && marker.steps.length === plan.steps.length) {
    const previousOk = marker.steps.every((step) => step.status === "ok");
    const results: StepResult[] = plan.steps.map((step, index) => {
      const previous = marker.steps[index]!;
      return previousOk
        ? { label: step.label, command: step.command, status: "up_to_date", durationMs: 0 }
        : { label: step.label, command: step.command, status: previous.status, exitCode: previous.exitCode, durationMs: 0 };
    });
    return {
      status: previousOk ? "up_to_date" : "failed",
      source: plan.source,
      durationMs: Date.now() - startedAt,
      reused: true,
      steps: results,
      verificationCommands: verificationCommandsFor(plan.steps, results, probe.packageJson),
      notes: notesFor(plan.steps, results),
    };
  }

  const results: StepResult[] = [];
  for (const step of plan.steps) {
    results.push(await runStep(sandboxProvider, sandboxId, step, timeoutSeconds));
  }
  const allOk = results.every((result) => result.status === "ok");
  const nextMarker: SetupMarker = {
    fingerprint,
    steps: results.map((result) =>
      result.exitCode === undefined ? { status: result.status } : { status: result.status, exitCode: result.exitCode },
    ),
  };
  const writeMarker = `[ -d /workspace/.git ] && printf '%s' "$ARATA_SETUP_MARKER" > /workspace/${DEPENDENCY_MARKER_PATH}; exit 0`;
  await collectStdout(
    sandboxProvider,
    sandboxId,
    ["sh", "-c", writeMarker],
    { maxChars: 0, keep: "head" },
    { ARATA_SETUP_MARKER: JSON.stringify(nextMarker) },
  ).catch(() => "");
  return {
    status: allOk ? "installed" : "failed",
    source: plan.source,
    durationMs: Date.now() - startedAt,
    reused: false,
    steps: results,
    verificationCommands: verificationCommandsFor(plan.steps, results, probe.packageJson),
    notes: notesFor(plan.steps, results),
  };
}
