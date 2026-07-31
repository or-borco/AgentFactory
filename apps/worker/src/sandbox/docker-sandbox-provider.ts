import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { extract, pack } from "tar-stream";
import type { ExecOptions, OutputChunk, Sandbox, SandboxProvider, SandboxSpec } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__"]);
const MAX_FILE_BYTES = 512 * 1024; // 512 KB per file — skip larger blobs

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
        Memory: (spec.memoryLimitMb ?? 512) * 1024 * 1024,
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
    yield* demux(stream);
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
    await container.remove();
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
