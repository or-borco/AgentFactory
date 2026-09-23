// The SandboxProvider port from ARCHITECTURE.md §4. Worker-internal for now — promote to
// packages/core only if a second consumer (e.g. a future apps/api) actually needs it.

export interface SandboxVolume {
  name: string;
  target: string;
}

export interface SandboxSpec {
  image: string;
  env: Record<string, string>;
  volumes?: SandboxVolume[];
  memoryLimitMb?: number;
  cpuLimit?: number;
  pidsLimit?: number;
}

export interface Sandbox {
  id: string;
}

export interface ExecOptions {
  env?: Record<string, string>;
}

export interface OutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<Sandbox>;
  exec(id: string, cmd: string[], opts?: ExecOptions): AsyncIterable<OutputChunk>;
  writeFiles(id: string, files: Record<string, string | Buffer>): Promise<void>;
  // Resets a container's memory cap back to the provider's base value (no-op if already there).
  // Called once per run, before that run's exec() calls — see DockerSandboxProvider for why.
  resetMemory(id: string): Promise<void>;
  // Returns text files under /workspace, keyed by path relative to /workspace.
  // Skips node_modules, .git, and binary files. Best-effort — never throws.
  readWorkspace(id: string): Promise<Record<string, string>>;
  destroy(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  // Kills whatever command is currently running via exec() in this sandbox, without touching the
  // container itself — the Stop button's "leave the sandbox warm, just stop the turn" contract
  // (see apps/worker/src/worker.ts's runCancelWorker). A no-op if nothing is running right now
  // (e.g. the turn had already finished by the time the stop request arrived).
  interrupt(id: string): Promise<void>;
}
