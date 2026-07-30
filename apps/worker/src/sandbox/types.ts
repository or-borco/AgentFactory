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
  destroy(id: string): Promise<void>;
  // Whether `id` still refers to a live, running container — lets a caller reuse a session's
  // warm sandbox across runs instead of assuming it survived (worker restart, manual removal, ...).
  exists(id: string): Promise<boolean>;
}
