import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { buildApp } from "./app.js";
import { gracefulShutdown, listeningPids } from "./services/runtime.js";
import { detectEmailConsumers } from "./services/emailConsumers.js";
import { nowIso } from "./lib/core.js";

type Ctx = Awaited<ReturnType<typeof buildApp>>;

async function authedToken(ctx: Ctx): Promise<string> {
  ctx.db.prepare("DELETE FROM sessions").run();
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dashboard_password', 'test-pass')")
    .run();
  const login = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password: "test-pass" }
  });
  return login.json().token as string;
}

function seedService(ctx: Ctx, name: string, port: number, projectId = "p-domains"): string {
  const id = nanoid();
  ctx.db
    .prepare(
      `INSERT INTO services
        (id, project_id, name, type, command, working_dir, docker_image, dockerfile, port, status,
         auto_restart, restart_count, max_restarts, start_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'process', 'node x.js', '/tmp', '', '', ?, 'stopped', 1, 0, 5, 'manual', ?, ?)`
    )
    .run(id, projectId, name, port, nowIso(), nowIso());
  return id;
}

function addProxyRoute(ctx: Ctx, serviceId: string, domain: string, port: number): void {
  ctx.db
    .prepare(
      "INSERT INTO proxy_routes (id, service_id, domain, target_port, path_prefix, created_at) VALUES (?, ?, ?, ?, '/', ?)"
    )
    .run(nanoid(), serviceId, domain, port, nowIso());
}

function addSaasDomain(ctx: Ctx, serviceId: string, hostname: string): void {
  ctx.db
    .prepare(
      `INSERT INTO saas_domains (id, service_id, hostname, status, ssl_status, mode, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'active', 'custom_hostname', ?, ?)`
    )
    .run(nanoid(), serviceId, hostname, nowIso(), nowIso());
}

async function listServices(ctx: Ctx, token: string): Promise<Array<Record<string, unknown>>> {
  const res = await ctx.app.inject({
    method: "GET",
    url: "/services",
    headers: { authorization: `Bearer ${token}` }
  });
  return res.json() as Array<Record<string, unknown>>;
}

/*
 * A domain connected through Cloudflare for SaaS lands in `saas_domains`, and
 * collectIngressRoutes() routes the tunnel from that table — but /services used
 * to derive `domain` from `proxy_routes` alone, so the service was live on its
 * domain and displayed as having none. That is the regression these cover.
 */

test("GET /services: a saas_domains-only service reports its domain", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, "saas-only", 4101);
    addSaasDomain(ctx, id, "alarent.example");

    const row = (await listServices(ctx, token)).find((s) => s.id === id);
    assert.ok(row, "service should be listed");
    assert.equal(row.domain, "alarent.example");
    assert.equal(row.domains, "alarent.example");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("GET /services/:id: a saas_domains-only service reports its domain", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, "saas-only-detail", 4102);
    addSaasDomain(ctx, id, "detail.example");

    const res = await ctx.app.inject({
      method: "GET",
      url: `/services/${id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.json().domain, "detail.example");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("GET /services: a hostname in BOTH tables is listed once", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, "both-tables", 4103);
    addProxyRoute(ctx, id, "double.example", 4103);
    addSaasDomain(ctx, id, "double.example");

    const row = (await listServices(ctx, token)).find((s) => s.id === id);
    assert.equal(row?.domain, "double.example");
    // UNION, not UNION ALL: the same hostname recorded twice is still one entry.
    assert.equal(row?.domains, "double.example");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("GET /services: a wildcard never becomes the primary domain", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, "wildcard", 4104);
    addSaasDomain(ctx, id, "*.tenants.example");
    addSaasDomain(ctx, id, "tenants.example");

    const row = (await listServices(ctx, token)).find((s) => s.id === id);
    // "*.tenants.example" sorts first alphabetically; it must still lose.
    assert.equal(row?.domain, "tenants.example");
    assert.ok(String(row?.domains).includes("*.tenants.example"), "wildcard still listed");
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("GET /services: www is still ranked below the apex", async () => {
  const ctx = await buildApp();
  try {
    const token = await authedToken(ctx);
    const id = seedService(ctx, "apex-and-www", 4105);
    addProxyRoute(ctx, id, "www.apex.example", 4105);
    addSaasDomain(ctx, id, "apex.example");

    const row = (await listServices(ctx, token)).find((s) => s.id === id);
    assert.equal(row?.domain, "apex.example");
  } finally {
    await gracefulShutdown(ctx);
  }
});

/*
 * listeningPids() backs the EADDRINUSE recovery in freeServicePort(). It used to
 * ask lsof alone and swallow a non-zero exit as "port is free" — and on the host
 * this runs on, lsof reports nothing for the app processes the control plane
 * spawns while ss reports them fine. A port that is demonstrably bound must
 * never come back as unoccupied.
 */
test("listeningPids: reports a port this process is actually listening on", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX-only lookup");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const { pids, occupied } = await listeningPids(port);
    assert.equal(occupied, true, "a bound port must never read as free");
    assert.ok(pids.includes(process.pid), `expected pid ${process.pid} in ${JSON.stringify(pids)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("listeningPids: an unbound port is reported free", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX-only lookup");
  // Bind then release, so the port is known-unused rather than merely guessed.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const { occupied } = await listeningPids(port);
  assert.equal(occupied, false);
});

/*
 * detectEmailConsumers(): "Enable email" injected SMTP_* into a project whose
 * repo has no mail code at all, reported success, and left the operator chasing
 * the relay. These pin the three answers it can give.
 */
function seedCheckout(ctx: Ctx, serviceId: string, files: Record<string, string>): void {
  const root = path.join(ctx.config.projectsDir, serviceId);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

test("detectEmailConsumers: finds an env read in a monorepo sibling package", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, "reads-env", 4201, "p-email-yes");
    // working_dir is apps/web; the mail code is in apps/api — scanning only the
    // service's working_dir would report a confident, wrong "no".
    ctx.db
      .prepare("UPDATE services SET working_dir = ? WHERE id = ?")
      .run(path.join(ctx.config.projectsDir, id, "apps/web"), id);
    seedCheckout(ctx, id, {
      "apps/web/page.tsx": "export const Page = () => null;\n",
      "apps/api/src/mailer.ts": "const host = process.env.SMTP_HOST;\nexport { host };\n"
    });

    const [row] = detectEmailConsumers(ctx, "p-email-yes");
    assert.equal(row?.consumes, true);
    assert.match(String(row?.evidence), /mailer\.ts reads SMTP_HOST/);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("detectEmailConsumers: a mail library in a manifest counts as evidence", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, "has-lib", 4202, "p-email-lib");
    seedCheckout(ctx, id, {
      "package.json": JSON.stringify({ dependencies: { nodemailer: "^6.9.0" } })
    });

    const [row] = detectEmailConsumers(ctx, "p-email-lib");
    assert.equal(row?.consumes, true);
    assert.match(String(row?.evidence), /depends on nodemailer/);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("detectEmailConsumers: a repo with no mail path reports false", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, "no-mail", 4203, "p-email-no");
    seedCheckout(ctx, id, {
      "package.json": JSON.stringify({ dependencies: { next: "15.5.0" } }),
      "src/auth.service.ts": "export function register() { return { ok: true }; }\n",
      // A mention in prose or an example file must not count as a consumer.
      "README.md": "Set SMTP_HOST to enable email.\n",
      ".env.example": "SMTP_HOST=\n"
    });

    const [row] = detectEmailConsumers(ctx, "p-email-no");
    assert.equal(row?.consumes, false);
    assert.equal(row?.evidence, null);
    assert.equal(row?.unscannable, undefined);
  } finally {
    await gracefulShutdown(ctx);
  }
});

test("detectEmailConsumers: an undeployed service is unscannable, not a false 'no'", async () => {
  const ctx = await buildApp();
  try {
    const id = seedService(ctx, "never-deployed", 4204, "p-email-none");
    ctx.db.prepare("UPDATE services SET working_dir = NULL WHERE id = ?").run(id);

    const [row] = detectEmailConsumers(ctx, "p-email-none");
    assert.equal(row?.consumes, false);
    assert.ok(row?.unscannable, "should say it could not be checked");
  } finally {
    await gracefulShutdown(ctx);
  }
});
