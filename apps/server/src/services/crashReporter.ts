import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppContext } from "../types.js";

/**
 * Opt-in crash reporter. On `uncaughtException` or `unhandledRejection`,
 * writes a full stack trace to `<dataRoot>/crash-<timestamp>.log` so users
 * can recover context after a crash. We never send anything off-host.
 *
 * Disable with `LOCALSURV_NO_CRASH_LOG=1` or by toggling the
 * `crash_reporter.enabled` setting to "0".
 */

function isEnabled(ctx: AppContext): boolean {
  if (process.env.LOCALSURV_NO_CRASH_LOG === "1") return false;
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'crash_reporter.enabled'").get() as
    | { value?: string }
    | undefined;
  // Opt-in default. Set to "1" to enable.
  return row?.value === "1";
}

function crashDir(ctx: AppContext): string {
  const dir = ctx.config.dataRoot ?? path.join(os.homedir(), ".survhub");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeStringify(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`;
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

function writeCrashLog(ctx: AppContext, kind: string, err: unknown): void {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(crashDir(ctx), `crash-${ts}.log`);
    const body = [
      `# LocalSURV crash report`,
      `# kind: ${kind}`,
      `# time: ${new Date().toISOString()}`,
      `# pid:  ${process.pid}`,
      `# node: ${process.version}`,
      `# os:   ${os.platform()} ${os.release()} (${os.arch()})`,
      ``,
      safeStringify(err),
      ``
    ].join("\n");
    fs.writeFileSync(filePath, body, { mode: 0o600 });
    ctx.app.log?.error?.({ filePath }, "crash_log_written");
  } catch (writeErr) {
    // We're already in a crash; suppress secondary failures.
    // eslint-disable-next-line no-console
    console.error("crash_reporter write failed:", writeErr);
  }
}

export function registerCrashReporter(ctx: AppContext): () => void {
  if (!isEnabled(ctx)) return () => undefined;
  const onException = (err: Error): void => writeCrashLog(ctx, "uncaughtException", err);
  const onRejection = (reason: unknown): void => writeCrashLog(ctx, "unhandledRejection", reason);
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.removeListener("uncaughtException", onException);
    process.removeListener("unhandledRejection", onRejection);
  };
}
