// The SandboxProvider port from ARCHITECTURE.md §4. Worker-internal for now — promote to
// packages/core only if a second consumer (e.g. a future apps/api) actually needs it.

export interface SandboxSpec {
  image: string;
  env: Record<string, string>;
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
  writeFiles(id: string, files: Record<string, string>): Promise<void>;
  // Returns text files under /workspace, keyed by path relative to /workspace.
  // Skips node_modules, .git, and binary files. Best-effort — never throws.
  readWorkspace(id: string): Promise<Record<string, string>>;
  destroy(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
}
