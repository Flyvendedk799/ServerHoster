import type Docker from "dockerode";
import { PassThrough } from "node:stream";
import path from "node:path";
import { ensureCiNetwork } from "./ciNetwork.js";

/**
 * One-shot Docker sandbox for a CI run.
 * The container does not mount the Docker socket, is not privileged, and drops
 * every Linux capability. It is not a GitHub Actions runner.
 */
export type CiSandbox = {
  run(input: {
    runId: string;
    image: string;
    workspace: string;
    env: Record<string, string>;
    timeoutMs: number;
    memoryMb: number;
    cpus: number;
    /** Per-repository dependency cache on the host, mounted at /cache. */
    cacheDir?: string | null;
    readonlyRootfs?: boolean;
    hostCpus?: number;
    steps: Array<{ name: string; run: string }>;
    onSetupLog: (chunk: string) => void;
    onLog: (stepIndex: number, chunk: string) => void;
    onStep: (
      stepIndex: number,
      status: "running" | "passed" | "failed" | "skipped",
      exitCode: number | null
    ) => void;
    isCancelled: () => boolean;
    signal?: AbortSignal;
  }): Promise<{ failedStep: number | null; cancelled: boolean; timedOut: boolean }>;
};

/** uid:gid the job uses when ServerHoster itself runs as root. */
export const CI_ROOT_FALLBACK_UID = 10001;

/**
 * Run the job as a non-root user that owns the checkout.
 * CapDrop ALL removes CAP_DAC_OVERRIDE, so container root cannot write a
 * directory owned by a non-root host user (npm ci cannot create node_modules).
 * Matching uid:gid can write the workspace without giving the job capabilities.
 * When ServerHoster runs as root the job still runs unprivileged, as
 * CI_ROOT_FALLBACK_UID, and the runner chowns the checkout and cache to it.
 * Windows has no uid to map.
 */
export function ciContainerUser(
  platform: NodeJS.Platform = process.platform,
  uid: number | null = typeof process.getuid === "function" ? (process.getuid() ?? null) : null,
  gid: number | null = typeof process.getgid === "function" ? (process.getgid() ?? null) : null
): string | undefined {
  // null is an explicit "no id" so tests can cover a missing uid without
  // passing undefined, which would fire these defaults and read the real user.
  if (platform === "win32" || uid == null) return undefined;
  if (uid === 0) return `${CI_ROOT_FALLBACK_UID}:${CI_ROOT_FALLBACK_UID}`;
  return `${uid}:${gid ?? uid}`;
}

export const CI_CACHE_MOUNT = "/cache";

/**
 * Point the common package managers at the mounted cache. Values the job sets
 * itself in `env:` win.
 */
export function ciCacheEnv(): Record<string, string> {
  return {
    npm_config_cache: `${CI_CACHE_MOUNT}/npm`,
    // pnpm reads its store location from npm_config_store_dir.
    npm_config_store_dir: `${CI_CACHE_MOUNT}/pnpm-store`,
    YARN_CACHE_FOLDER: `${CI_CACHE_MOUNT}/yarn`,
    COREPACK_HOME: `${CI_CACHE_MOUNT}/corepack`,
    PIP_CACHE_DIR: `${CI_CACHE_MOUNT}/pip`,
    XDG_CACHE_HOME: `${CI_CACHE_MOUNT}/xdg`,
    GOMODCACHE: `${CI_CACHE_MOUNT}/go/mod`,
    GOCACHE: `${CI_CACHE_MOUNT}/go/build`
  };
}

/**
 * Hard CPU ceiling for one job. The job may burst to twice what it asked for
 * (never past 4 cores or the host) because CpuShares keeps it behind the
 * hosted services whenever the CPU is contended.
 */
export function ciCpuCap(cpus: number, hostCpus: number): number {
  const asked = Math.min(4, Math.max(0.25, cpus));
  const host = Math.max(0.25, hostCpus);
  return Math.min(host, Math.max(asked, Math.min(4, asked * 2)));
}

/** cgroup weight of a CI job; Docker's default for every other container is 1024. */
export const CI_CPU_SHARES = 256;
/** Block I/O weight (10–1000, Docker's default is 500). Dropped if the kernel lacks it. */
export const CI_BLKIO_WEIGHT = 100;
export const CI_PIDS_LIMIT = 512;
export const CI_NOFILE = { soft: 16_384, hard: 32_768 };

export type CiContainerSpecInput = {
  name: string;
  runId: string;
  image: string;
  workspace: string;
  env: Record<string, string>;
  memoryMb: number;
  cpus: number;
  hostCpus: number;
  user: string | undefined;
  cacheDir?: string | null;
  network: string;
  readonlyRootfs: boolean;
  blkioWeight: boolean;
};

/** The exact create options for a CI container. Pure, so tests can assert them. */
export function buildCiContainerSpec(input: CiContainerSpecInput): Docker.ContainerCreateOptions {
  const memoryMb = Math.max(128, input.memoryMb);
  const memory = memoryMb * 1024 * 1024;
  const merged: Record<string, string> = { ...(input.cacheDir ? ciCacheEnv() : {}), ...input.env };
  if (!Object.prototype.hasOwnProperty.call(input.env, "HOME")) merged.HOME = "/tmp";
  const env = Object.entries(merged).map(([key, value]) => `${key}=${value}`);
  // tmpfs pages count against the memory limit, so /tmp gets half of it at most.
  const tmpMb = Math.max(64, Math.floor(memoryMb / 2));
  const binds = [`${dockerBindPath(input.workspace)}:/workspace:rw`];
  if (input.cacheDir) binds.push(`${dockerBindPath(input.cacheDir)}:${CI_CACHE_MOUNT}:rw`);
  return {
    name: input.name,
    Image: input.image,
    // Replace the image entrypoint so `sleep` is actually pid 1.
    Entrypoint: ["sleep", "86400"],
    WorkingDir: "/workspace",
    ...(input.user ? { User: input.user } : {}),
    Env: env,
    Labels: { "survhub.ci": "1", "survhub.ci.run": input.runId },
    HostConfig: {
      Memory: memory,
      // Equal to Memory: no swap, so a runaway job is OOM-killed instead of
      // pushing the host into swap.
      MemorySwap: memory,
      NanoCpus: Math.round(ciCpuCap(input.cpus, input.hostCpus) * 1e9),
      CpuShares: CI_CPU_SHARES,
      ...(input.blkioWeight ? { BlkioWeight: CI_BLKIO_WEIGHT } : {}),
      PidsLimit: CI_PIDS_LIMIT,
      Ulimits: [{ Name: "nofile", Soft: CI_NOFILE.soft, Hard: CI_NOFILE.hard }],
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: input.readonlyRootfs,
      Tmpfs: {
        "/tmp": `rw,exec,nosuid,nodev,size=${tmpMb}m,mode=1777`,
        "/var/tmp": `rw,nosuid,nodev,size=${Math.min(256, tmpMb)}m,mode=1777`
      },
      NetworkMode: input.network,
      Binds: binds,
      // Step output is streamed through exec, so the daemon keeps no log file.
      LogConfig: { Type: "none", Config: {} },
      AutoRemove: false,
      Init: true
    }
  };
}

function isBlkioUnsupported(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /blkio|block i\/o|io\.weight|io\.bfq/i.test(text);
}

function dockerBindPath(hostPath: string): string {
  const resolved = path.resolve(hostPath);
  if (process.platform !== "win32") return resolved;
  const posix = resolved.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(posix);
  return drive ? `/${drive[1].toLowerCase()}${posix.slice(2)}` : posix;
}

async function pullImage(
  docker: Docker,
  image: string,
  onLog: (chunk: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  // The signal also cancels the request itself, so a registry that never
  // answers the first byte does not hang here.
  const stream = (await docker.pull(
    image,
    signal ? { abortSignal: signal } : {}
  )) as NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void;
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      stream.destroy?.(new Error("aborted"));
      finish(new Error("aborted"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    docker.modem.followProgress(
      stream,
      (error: Error | null) => finish(error),
      (event: { status?: string; id?: string }) => {
        if (event?.status) onLog(`${event.id ? `${event.id} ` : ""}${event.status}\n`);
      }
    );
  });
}

/**
 * Reject when the run is stopped or out of time, even if Docker never answers.
 * The caller then reports the stop instead of waiting on the daemon.
 */
function guarded<T>(work: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(new Error("aborted")));
    const timer = setTimeout(
      () => settle(() => reject(new Error("timed out"))),
      Math.max(0, deadline - Date.now())
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

function collectExec(
  docker: Docker,
  stream: NodeJS.ReadableStream,
  onChunk: (text: string) => void
): Promise<void> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const write = (buf: Buffer | string) => onChunk(typeof buf === "string" ? buf : buf.toString("utf8"));
  stdout.on("data", write);
  stderr.on("data", write);
  docker.modem.demuxStream(stream, stdout, stderr);
  return new Promise((resolve, reject) => {
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
}

export function dockerCiSandbox(docker: Docker): CiSandbox {
  return {
    async run(input) {
      const deadline = Date.now() + input.timeoutMs;
      let timedOut = false;
      let cancelled = false;
      const noteSetup = (chunk: string) => input.onSetupLog(chunk);
      const halted = (): { failedStep: null; cancelled: boolean; timedOut: boolean } | null => {
        if (input.isCancelled()) return { failedStep: null, cancelled: true, timedOut: false };
        if (input.signal?.aborted || Date.now() > deadline) {
          return { failedStep: null, cancelled: false, timedOut: true };
        }
        return null;
      };
      const before = halted();
      if (before) return before;
      const guard = <T>(work: Promise<T>) => guarded(work, input.signal, deadline);

      try {
        await guard(docker.getImage(input.image).inspect());
        noteSetup(`Using local image ${input.image}.\n`);
      } catch {
        const stopped = halted();
        if (stopped) return stopped;
        noteSetup(`Pulling ${input.image}…\n`);
        try {
          await guard(pullImage(docker, input.image, noteSetup, input.signal));
        } catch (error) {
          const stop = halted();
          if (stop) return stop;
          throw error;
        }
      }
      const afterPull = halted();
      if (afterPull) return afterPull;

      const name = `survhub-ci-${input.runId.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}`;
      try {
        await guard(docker.getContainer(name).remove({ force: true }));
      } catch {
        /* no previous container with this name */
      }

      const network = await guard(ensureCiNetwork(docker));
      if (network.note) noteSetup(`${network.note}\n`);
      const spec = (blkioWeight: boolean) =>
        buildCiContainerSpec({
          name,
          runId: input.runId,
          image: input.image,
          workspace: input.workspace,
          env: input.env,
          memoryMb: input.memoryMb,
          cpus: input.cpus,
          hostCpus: input.hostCpus ?? 4,
          user: ciContainerUser(),
          cacheDir: input.cacheDir,
          network: network.name,
          readonlyRootfs: input.readonlyRootfs ?? false,
          blkioWeight
        });
      let creating = docker.createContainer(spec(true));
      // Some kernels (cgroup v2 without the io controller) reject BlkioWeight.
      creating = creating.catch(async (error: unknown) => {
        if (!isBlkioUnsupported(error)) throw error;
        noteSetup("Block I/O weight is not supported on this host; continuing without it.\n");
        return docker.createContainer(spec(false));
      });
      let container: Docker.Container;
      try {
        container = await guard(creating);
      } catch (error) {
        // Docker may still create it after we gave up; remove it when it lands.
        void creating.then((late) => late.remove({ force: true })).catch(() => undefined);
        const stop = halted();
        if (stop) return stop;
        throw error;
      }

      const stop = async () => {
        try {
          await container.kill();
        } catch {
          /* already stopped */
        }
      };
      const watch = setInterval(() => {
        if (Date.now() > deadline) {
          timedOut = true;
          void stop();
        } else if (input.isCancelled() || input.signal?.aborted) {
          if (input.isCancelled()) cancelled = true;
          else timedOut = true;
          void stop();
        }
      }, 1000);
      const onAbort = () => {
        if (input.isCancelled()) cancelled = true;
        else timedOut = true;
        void stop();
      };
      input.signal?.addEventListener("abort", onAbort);

      let current = 0;
      try {
        await guard(container.start());
        for (let index = 0; index < input.steps.length; index += 1) {
          current = index;
          if (input.isCancelled() || cancelled) {
            for (let rest = index; rest < input.steps.length; rest += 1) input.onStep(rest, "skipped", null);
            return { failedStep: null, cancelled: true, timedOut: false };
          }
          if (Date.now() > deadline || timedOut) {
            for (let rest = index; rest < input.steps.length; rest += 1) input.onStep(rest, "skipped", null);
            return { failedStep: null, cancelled: false, timedOut: true };
          }
          const step = input.steps[index];
          input.onStep(index, "running", null);
          input.onLog(index, `$ ${step.run}\n`);
          const exec = await guard(
            container.exec({
              Cmd: ["sh", "-c", step.run],
              AttachStdout: true,
              AttachStderr: true,
              WorkingDir: "/workspace"
            })
          );
          const stream = await guard(exec.start({ hijack: true, stdin: false }));
          try {
            await collectExec(docker, stream, (chunk) => input.onLog(index, chunk));
          } catch (error) {
            if (timedOut || cancelled || input.isCancelled()) {
              for (let rest = index; rest < input.steps.length; rest += 1)
                input.onStep(rest, "skipped", null);
              return {
                failedStep: null,
                cancelled: cancelled || input.isCancelled(),
                timedOut: timedOut && !cancelled
              };
            }
            throw error;
          }
          const info = await guard(exec.inspect());
          const exitCode = typeof info.ExitCode === "number" ? info.ExitCode : 1;
          if (timedOut || Date.now() > deadline) {
            input.onStep(index, "skipped", exitCode);
            for (let rest = index + 1; rest < input.steps.length; rest += 1)
              input.onStep(rest, "skipped", null);
            return { failedStep: null, cancelled: false, timedOut: true };
          }
          if (cancelled || input.isCancelled()) {
            input.onStep(index, "skipped", exitCode);
            for (let rest = index + 1; rest < input.steps.length; rest += 1)
              input.onStep(rest, "skipped", null);
            return { failedStep: null, cancelled: true, timedOut: false };
          }
          if (exitCode !== 0) {
            input.onStep(index, "failed", exitCode);
            input.onLog(index, `\nExited ${exitCode}.\n`);
            for (let rest = index + 1; rest < input.steps.length; rest += 1)
              input.onStep(rest, "skipped", null);
            return { failedStep: index, cancelled: false, timedOut: false };
          }
          input.onStep(index, "passed", 0);
        }
        return { failedStep: null, cancelled: false, timedOut: false };
      } catch (error) {
        const stop = halted() ?? (timedOut ? { failedStep: null, cancelled: false, timedOut: true } : null);
        if (!stop) throw error;
        for (let rest = current; rest < input.steps.length; rest += 1) input.onStep(rest, "skipped", null);
        return stop;
      } finally {
        clearInterval(watch);
        input.signal?.removeEventListener("abort", onAbort);
        try {
          // Bounded: a hung daemon must not keep the run (and its slot) open.
          await guarded(container.remove({ force: true }), undefined, Date.now() + 30_000);
        } catch {
          /* already gone, or removed by the run's own cleanup */
        }
      }
    }
  };
}

export async function removeCiContainers(docker: Docker): Promise<void> {
  await removeLabelled(docker, "survhub.ci=1");
}

/** Remove the container of one run, wherever its setup got to. */
export async function removeCiRunContainers(docker: Docker, runId: string): Promise<void> {
  await removeLabelled(docker, `survhub.ci.run=${runId}`);
}

async function removeLabelled(docker: Docker, label: string): Promise<void> {
  let listed: Array<{ Id: string }> = [];
  try {
    listed = (await docker.listContainers({
      all: true,
      filters: { label: [label] }
    })) as Array<{ Id: string }>;
  } catch {
    return;
  }
  for (const item of listed) {
    try {
      await docker.getContainer(item.Id).remove({ force: true });
    } catch {
      /* already gone */
    }
  }
}
