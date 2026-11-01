import type Docker from "dockerode";
import { PassThrough } from "node:stream";
import path from "node:path";

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
    steps: Array<{ name: string; run: string }>;
    onSetupLog: (chunk: string) => void;
    onLog: (stepIndex: number, chunk: string) => void;
    onStep: (
      stepIndex: number,
      status: "running" | "passed" | "failed" | "skipped",
      exitCode: number | null
    ) => void;
    isCancelled: () => boolean;
  }): Promise<{ failedStep: number | null; cancelled: boolean; timedOut: boolean }>;
};

function dockerBindPath(hostPath: string): string {
  const resolved = path.resolve(hostPath);
  if (process.platform !== "win32") return resolved;
  const posix = resolved.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(posix);
  return drive ? `/${drive[1].toLowerCase()}${posix.slice(2)}` : posix;
}

async function pullImage(docker: Docker, image: string, onLog: (chunk: string) => void): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (error: Error | null) => (error ? reject(error) : resolve()),
      (event: { status?: string; id?: string }) => {
        if (event?.status) onLog(`${event.id ? `${event.id} ` : ""}${event.status}\n`);
      }
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

      try {
        await docker.getImage(input.image).inspect();
        noteSetup(`Using local image ${input.image}.\n`);
      } catch {
        noteSetup(`Pulling ${input.image}…\n`);
        await pullImage(docker, input.image, noteSetup);
      }
      if (Date.now() > deadline) return { failedStep: null, cancelled: false, timedOut: true };
      if (input.isCancelled()) return { failedStep: null, cancelled: true, timedOut: false };

      const name = `survhub-ci-${input.runId.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}`;
      try {
        await docker.getContainer(name).remove({ force: true });
      } catch {
        /* no previous container with this name */
      }

      const memory = Math.max(128, input.memoryMb) * 1024 * 1024;
      const container = await docker.createContainer({
        name,
        Image: input.image,
        // Replace the image entrypoint so `sleep` is actually pid 1.
        Entrypoint: ["sleep", "86400"],
        WorkingDir: "/workspace",
        Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
        Labels: { "survhub.ci": "1", "survhub.ci.run": input.runId },
        HostConfig: {
          Memory: memory,
          MemorySwap: memory,
          NanoCpus: Math.round(Math.min(4, Math.max(0.25, input.cpus)) * 1e9),
          PidsLimit: 512,
          Privileged: false,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          NetworkMode: "bridge",
          Binds: [`${dockerBindPath(input.workspace)}:/workspace:rw`],
          ExtraHosts: ["host.docker.internal:host-gateway"],
          AutoRemove: false,
          Init: true
        }
      });

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
        } else if (input.isCancelled()) {
          cancelled = true;
          void stop();
        }
      }, 1000);

      try {
        await container.start();
        for (let index = 0; index < input.steps.length; index += 1) {
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
          const exec = await container.exec({
            Cmd: ["sh", "-c", step.run],
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: "/workspace"
          });
          const stream = await exec.start({ hijack: true, stdin: false });
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
          const info = await exec.inspect();
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
      } finally {
        clearInterval(watch);
        try {
          await container.remove({ force: true });
        } catch {
          /* already gone */
        }
      }
    }
  };
}

export async function removeCiContainers(docker: Docker): Promise<void> {
  let listed: Array<{ Id: string }> = [];
  try {
    listed = (await docker.listContainers({
      all: true,
      filters: { label: ["survhub.ci=1"] }
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
