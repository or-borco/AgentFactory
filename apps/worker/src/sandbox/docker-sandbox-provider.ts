import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { extract, pack } from "tar-stream";
import type { ExecOptions, OutputChunk, Sandbox, SandboxProvider, SandboxSpec } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__"]);
const MAX_FILE_BYTES = 512 * 1024; // 512 KB per file — skip larger blobs

// Dynamic memory scaling (grow during a run, shrink between runs — see the design note on
// DockerSandboxProvider.resetMemory and watchMemory below). Base matches the pre-existing
// default so a task that never bursts behaves exactly as before.
const MB = 1024 * 1024;
const MEMORY_BASE_MB = 512;
const MEMORY_MAX_MB = 4096;
const MEMORY_GROWTH_FACTOR = 2;
const MEMORY_GROWTH_THRESHOLD = 0.8; // fraction of the current cap that triggers a grow

function memoryHostConfig(mb: number): { Memory: number; MemorySwap: number } {
  const bytes = mb * MB;
  // MemorySwap === Memory: no swap beyond the cap, so growing/shrinking the pair together keeps
  // the same "hard RAM ceiling" semantics the original single-field config had.
  return { Memory: bytes, MemorySwap: bytes };
}

// Polls a running container's live memory usage for the duration of one exec() call and grows
// its cap (doubling, capped at MEMORY_MAX_MB) before the kernel OOM-kills the process inside it —
// this is what T-165 hit with the old fixed 512MB cap. Best-effort: a failure here is logged and
// swallowed, never allowed to interrupt the command actually running in the sandbox. Returns a
// stop function the caller must invoke once the exec() it was watching has finished.
function watchMemory(container: Docker.Container, id: string): () => void {
  let stopped = false;
  let activeStream: Readable | undefined;

  container
    .stats({ stream: true })
    .then((stream) => {
      if (stopped) {
        (stream as unknown as Readable).destroy();
        return;
      }
      activeStream = stream as unknown as Readable;
      activeStream.on("data", (chunk: Buffer) => {
        let stats: Docker.ContainerStats;
        try {
          stats = JSON.parse(chunk.toString("utf8"));
        } catch {
          return; // a chunk split across a JSON boundary — the next chunk parses fine
        }
        const mem = stats.memory_stats;
        if (!mem?.usage || !mem?.limit) return;
        const currentMb = Math.round(mem.limit / MB);
        if (currentMb >= MEMORY_MAX_MB) return;
        // Raw `usage` over-counts reclaimable page cache; subtract it the same way `docker
        // stats` does, or growth would trigger on cache pressure instead of real memory need.
        const reclaimable = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0;
        const effectiveUsage = mem.usage - reclaimable;
        if (effectiveUsage / mem.limit < MEMORY_GROWTH_THRESHOLD) return;
        const nextMb = Math.min(currentMb * MEMORY_GROWTH_FACTOR, MEMORY_MAX_MB);
        container.update(memoryHostConfig(nextMb)).catch((err: unknown) => {
          console.error(`Failed to grow sandbox ${id} memory to ${nextMb}MB:`, err);
        });
      });
      activeStream.on("error", () => undefined);
    })
    .catch((err: unknown) => {
      console.error(`Failed to open stats stream for sandbox ${id}:`, err);
    });

  return () => {
    stopped = true;
    activeStream?.destroy();
  };
}

async function extractTar(stream: NodeJS.ReadableStream): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  return new Promise((resolve) => {
    const ex = extract();
    ex.on("entry", (header, entryStream, next) => {
      const parts = header.name.split("/");
      const skip = parts.some((p) => SKIP_DIRS.has(p)) || header.type !== "file";
      if (skip || (header.size ?? 0) > MAX_FILE_BYTES) {
        entryStream.resume();
        return next();
      }
      const chunks: Buffer[] = [];
      entryStream.on("data", (c: Buffer) => chunks.push(c));
      entryStream.on("end", () => {
        const buf = Buffer.concat(chunks);
        // Skip binary — a null byte is a reliable-enough heuristic.
        if (!buf.includes(0)) {
          const relPath = parts.slice(1).join("/"); // strip leading "workspace/" prefix
          if (relPath) files[relPath] = buf.toString("utf8");
        }
        next();
      });
    });
    ex.on("finish", () => resolve(files));
    ex.on("error", () => resolve(files)); // best-effort
    stream.pipe(ex);
  });
}

const docker = new Docker();

function toEnvList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

// Demuxes the single multiplexed exec stream (stdout+stderr interleaved, Docker's wire format
// when Tty is false) into an ordered async sequence of tagged chunks.
//
// docker-modem's demuxStream only forwards `data` from the source stream to the stdout/stderr
// destinations it's given — it never forwards `end`/`close`, so completion has to be detected
// on the source `execStream` itself, not on the two destination PassThroughs.
async function* demux(execStream: NodeJS.ReadableStream): AsyncGenerator<OutputChunk> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(execStream, stdout, stderr);

  const queue: OutputChunk[] = [];
  let waiter: (() => void) | null = null;
  let finished = false;

  const push = (chunk: OutputChunk) => {
    queue.push(chunk);
    waiter?.();
  };
  const finish = () => {
    finished = true;
    waiter?.();
  };

  stdout.on("data", (data: Buffer) => push({ stream: "stdout", data: data.toString("utf8") }));
  stderr.on("data", (data: Buffer) => push({ stream: "stderr", data: data.toString("utf8") }));
  execStream.on("end", finish);
  execStream.on("close", finish);

  while (true) {
    if (queue.length === 0) {
      if (finished) return;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
      waiter = null;
    }
    const chunk = queue.shift();
    if (chunk) yield chunk;
  }
}

// DockerSandboxProvider adapter (ARCHITECTURE.md §4). Hardening baked into create() from day
// one since the agent executes model-authored code: capabilities dropped, non-root, resource
// limits. The docker socket is never bound — the only way to guarantee that is to never write
// the code path that could bind it.
export class DockerSandboxProvider implements SandboxProvider {
  async create(spec: SandboxSpec): Promise<Sandbox> {
    const container = await docker.createContainer({
      Image: spec.image,
      Env: toEnvList(spec.env),
      HostConfig: {
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ...memoryHostConfig(spec.memoryLimitMb ?? MEMORY_BASE_MB),
        NanoCpus: (spec.cpuLimit ?? 1) * 1e9,
        PidsLimit: spec.pidsLimit ?? 128,
        AutoRemove: false,
      },
    });
    await container.start();
    return { id: container.id };
  }

  async *exec(id: string, cmd: string[], opts?: ExecOptions): AsyncIterable<OutputChunk> {
    const container = docker.getContainer(id);
    const dockerExec = await container.exec({
      Cmd: cmd,
      Env: opts?.env ? toEnvList(opts.env) : undefined,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    // Tty:false on both create and start — required for demuxStream's multiplexed-frame format
    // below; with Tty:true Docker returns a single raw stream and demuxing hangs.
    const stream = await dockerExec.start({ Tty: false });
    const stopWatchingMemory = watchMemory(container, id);
    try {
      yield* demux(stream);
    } finally {
      stopWatchingMemory();
    }
  }

  // Shrink half of the grow/shrink pair (see watchMemory above): called once per run, before
  // that run's exec() calls start, so a sandbox that grew to handle a heavy task doesn't keep
  // holding that cap for a small follow-up task. Never runs while a command is executing — a
  // live container's cap can't safely drop below its current usage.
  async resetMemory(id: string): Promise<void> {
    const container = docker.getContainer(id);
    try {
      const info = await container.inspect();
      const baseBytes = MEMORY_BASE_MB * MB;
      if (info.HostConfig.Memory !== baseBytes) {
        await container.update(memoryHostConfig(MEMORY_BASE_MB));
      }
    } catch (err) {
      console.error(`Failed to reset sandbox ${id} memory to base:`, err);
    }
  }

  async readWorkspace(id: string): Promise<Record<string, string>> {
    try {
      const container = docker.getContainer(id);
      const stream = await container.getArchive({ path: "/workspace" });
      return await extractTar(stream as unknown as NodeJS.ReadableStream);
    } catch {
      return {};
    }
  }

  async writeFiles(id: string, files: Record<string, string>): Promise<void> {
    const container = docker.getContainer(id);
    const tar = pack();
    for (const [path, contents] of Object.entries(files)) {
      tar.entry({ name: path }, contents);
    }
    tar.finalize();
    await container.putArchive(tar, { path: "/workspace" });
  }

  async destroy(id: string): Promise<void> {
    const container = docker.getContainer(id);
    await container.stop().catch(() => undefined);
    // Idempotent: teardown can be requested more than once for the same sandbox (e.g. a task
    // marked done after it was already deleted) — a missing container is a no-op, not an error.
    await container.remove().catch(() => undefined);
  }

  async exists(id: string): Promise<boolean> {
    try {
      const info = await docker.getContainer(id).inspect();
      return info.State.Running;
    } catch {
      return false;
    }
  }
}
