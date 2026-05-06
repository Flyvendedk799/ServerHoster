import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { AppContext } from "../types.js";
import { decryptSecret, encryptSecret, maskSecret } from "../security.js";

/**
 * Settings keys that are stored encrypted at rest. Reads through
 * getSecretSetting transparently decrypt; reads through getPublicSetting
 * return them masked. Plain settings go through getSetting directly.
 */
export const ENCRYPTED_SETTINGS = new Set<string>([
  "github_pat",
  "cloudflare_api_token",
  "cloudflare_tunnel_token",
  "cloudflare_account_id"
]);

export function getSetting(ctx: AppContext, key: string): string | null {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(ctx: AppContext, key: string, value: string): void {
  ctx.db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .run(key, value, value);
}

export function deleteSetting(ctx: AppContext, key: string): void {
  ctx.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function getSecretSetting(ctx: AppContext, key: string): string | null {
  const stored = getSetting(ctx, key);
  if (!stored) return null;
  try {
    return decryptSecret(stored, ctx.config.secretKey);
  } catch {
    return null;
  }
}

export function setSecretSetting(ctx: AppContext, key: string, value: string): void {
  setSetting(ctx, key, encryptSecret(value, ctx.config.secretKey));
}

/** List all settings with encrypted values masked (never leaks plaintext secrets). */
export function listMaskedSettings(ctx: AppContext): Array<{ key: string; value: string; secret: boolean }> {
  const rows = ctx.db.prepare("SELECT key, value FROM settings ORDER BY key ASC").all() as Array<{
    key: string;
    value: string;
  }>;
  return rows.map((r) => {
    const secret = ENCRYPTED_SETTINGS.has(r.key);
    if (!secret) return { key: r.key, value: r.value, secret: false };
    try {
      return { key: r.key, value: maskSecret(decryptSecret(r.value, ctx.config.secretKey)), secret: true };
    } catch {
      return { key: r.key, value: "(unreadable — wrong SURVHUB_SECRET_KEY?)", secret: true };
    }
  });
}

/**
 * Inject a stored GitHub PAT into an HTTPS git URL so simple-git can auth
 * against private repos. Leaves SSH URLs untouched.
 */
export function injectGitCredentials(ctx: AppContext, repoUrl: string): string {
  const pat = getSecretSetting(ctx, "github_pat");
  if (!pat) return repoUrl;
  if (!/^https?:\/\//i.test(repoUrl)) return repoUrl;
  try {
    const url = new URL(repoUrl);
    // Only inject for github.com (avoid leaking to other hosts).
    if (!/github\.com$/i.test(url.hostname)) return repoUrl;
    url.username = "x-access-token";
    url.password = pat;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Build env for child_process / simple-git so that an SSH key path (if set)
 * is used when cloning SSH URLs, and git never prompts interactively.
 */
export function buildGitEnv(ctx: AppContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const sshKeyPath = getSetting(ctx, "ssh_key_path");
  if (sshKeyPath && fs.existsSync(sshKeyPath)) {
    env.GIT_SSH_COMMAND = `ssh -i "${sshKeyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  }
  return env;
}

/** Resolve the server's public SSH key so users can add it as a GitHub deploy key. */
export function getServerPublicKey(ctx: AppContext): {
  path: string | null;
  publicKey: string | null;
  source: string;
} {
  const configured = getSetting(ctx, "ssh_key_path");
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  const home = os.homedir();
  for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
    candidates.push(path.join(home, ".ssh", name));
  }
  for (const priv of candidates) {
    const pub = `${priv}.pub`;
    if (fs.existsSync(pub)) {
      try {
        return { path: priv, publicKey: fs.readFileSync(pub, "utf8").trim(), source: "file" };
      } catch {
        continue;
      }
    }
    if (fs.existsSync(priv)) {
      // Private key exists but no .pub sibling — attempt ssh-keygen -y.
      try {
        const out = execSync(`ssh-keygen -y -f "${priv}"`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        });
        return { path: priv, publicKey: out.trim(), source: "derived" };
      } catch {
        continue;
      }
    }
  }
  return { path: null, publicKey: null, source: "none" };
}
