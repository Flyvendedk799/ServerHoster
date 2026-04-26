import { z } from "zod";
import type { AppContext } from "../types.js";
import {
  ENCRYPTED_SETTINGS,
  deleteSetting,
  getSecretSetting,
  getServerPublicKey,
  getSetting,
  listMaskedSettings,
  setSecretSetting,
  setSetting
} from "../services/settings.js";
import { ensureRepoWebhook, listUserRepos, parseRepoFullName } from "../services/github.js";

const putSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string().default("")
});

const githubPatSchema = z.object({ token: z.string().min(20) });
const sshKeySchema = z.object({ path: z.string().min(1) });

export function registerSettingsRoutes(ctx: AppContext): void {
  ctx.app.get("/settings", async () => ({ settings: listMaskedSettings(ctx) }));

  ctx.app.get("/settings/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    const value = getSetting(ctx, key);
    if (value == null) return reply.code(404).send({ error: "Not found" });
    if (ENCRYPTED_SETTINGS.has(key)) {
      return reply.code(403).send({ error: "Refusing to return encrypted setting in plaintext" });
    }
    return { key, value };
  });

  ctx.app.put("/settings", async (req) => {
    const p = putSettingSchema.parse(req.body);
    if (ENCRYPTED_SETTINGS.has(p.key)) {
      setSecretSetting(ctx, p.key, p.value);
    } else {
      setSetting(ctx, p.key, p.value);
    }
    return { ok: true };
  });

  ctx.app.delete("/settings/:key", async (req) => {
    const { key } = req.params as { key: string };
    deleteSetting(ctx, key);
    return { ok: true };
  });

  // --- Convenience endpoints for Phase 3 UI --------------------------------
  ctx.app.get("/settings/github/status", async () => {
    const pat = getSecretSetting(ctx, "github_pat");
    return { configured: Boolean(pat), tokenPrefix: pat ? pat.slice(0, 4) + "…" : null };
  });

  ctx.app.post("/settings/github/pat", async (req) => {
    const p = githubPatSchema.parse(req.body);
    // Validate by hitting /user
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${p.token}`, "User-Agent": "survhub" }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub token rejected (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const user = (await res.json()) as { login?: string };
    setSecretSetting(ctx, "github_pat", p.token);
    return { ok: true, login: user.login ?? null };
  });

  ctx.app.delete("/settings/github/pat", async () => {
    deleteSetting(ctx, "github_pat");
    return { ok: true };
  });

  ctx.app.get("/settings/ssh", async () => {
    const info = getServerPublicKey(ctx);
    return {
      configuredPath: getSetting(ctx, "ssh_key_path"),
      resolvedPath: info.path,
      publicKey: info.publicKey,
      source: info.source
    };
  });

  ctx.app.put("/settings/ssh", async (req) => {
    const p = sshKeySchema.parse(req.body);
    setSetting(ctx, "ssh_key_path", p.path);
    return { ok: true };
  });

  ctx.app.delete("/settings/ssh", async () => {
    deleteSetting(ctx, "ssh_key_path");
    return { ok: true };
  });

  // --- GitHub helpers (Phase 3.3) ------------------------------------------
  ctx.app.get("/github/repos", async () => {
    const repos = await listUserRepos(ctx);
    return repos.map((r) => ({
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch,
      clone_url: r.clone_url,
      html_url: r.html_url,
      updated_at: r.updated_at
    }));
  });

  const webhookEnsureSchema = z.object({
    repoUrl: z.string().url(),
    webhookUrl: z.string().url()
  });
  ctx.app.post("/github/webhook/ensure", async (req) => {
    const p = webhookEnsureSchema.parse(req.body);
    const fullName = parseRepoFullName(p.repoUrl);
    if (!fullName) throw new Error(`Not a GitHub repo URL: ${p.repoUrl}`);
    return ensureRepoWebhook(ctx, fullName, p.webhookUrl);
  });
}
