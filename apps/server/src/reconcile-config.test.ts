import test from "node:test";
import assert from "node:assert/strict";
import { reconciledConfigToml } from "./services/resources/reconcileConfig.js";

const SMTP = {
  host: "smtp.mx.cloudflare.net",
  port: 465,
  user: "api_token",
  from: "noreply@app.dk",
  fromName: "App"
};

test("reconcile re-materialises the port block and JWT secret a git reset stripped", () => {
  const { toml, applied } = reconciledConfigToml('project_id = "app"\n', {
    portOffset: 1500,
    email: null
  });
  assert.ok(applied.some((a) => /ports \+1500/.test(a)), applied.join());
  assert.ok(applied.includes("jwt secret"), applied.join());
  assert.match(toml, /port = 55821/, "api port carries the +1500 offset");
  assert.match(toml, /jwt_secret = "env\(SUPABASE_AUTH_JWT_SECRET\)"/);
  assert.match(toml, /project_id = "app"/, "committed content preserved");
});

test("reconcile is a no-op on a checkout that already carries the managed config", () => {
  const first = reconciledConfigToml('project_id = "app"\n', { portOffset: 1500, email: null });
  const second = reconciledConfigToml(first.toml, { portOffset: 1500, email: null });
  assert.deepEqual(second.applied, [], "nothing re-applied");
  assert.equal(second.toml, first.toml, "byte-identical");
});

test("reconcile without email writes no SMTP block or templates (never a dead-link config)", () => {
  const { toml } = reconciledConfigToml('project_id = "app"\n', { portOffset: 0, email: null });
  assert.ok(!toml.includes("[auth.email.smtp]"), "no SMTP block");
  assert.ok(!/\[auth\.email\.template\./.test(toml), "no templates");
  assert.match(toml, /jwt_secret = "env\(SUPABASE_AUTH_JWT_SECRET\)"/, "but JWT is always managed");
});

test("reconcile with email applies SMTP + SiteURL templates and never sets external_url", () => {
  const { toml, applied } = reconciledConfigToml('project_id = "app"\n\n[api]\nport = 54321\n', {
    portOffset: 0,
    email: { origin: "https://app.dk", smtp: SMTP, confirmations: false }
  });
  assert.ok(applied.includes("email + templates"), applied.join());
  assert.ok(toml.includes("[auth.email.smtp]"), "SMTP block present");
  assert.ok(toml.includes('site_url = "https://app.dk"'), "public site_url");
  assert.ok(toml.includes("[auth.email.template.confirmation]"), "confirmation template referenced");
  assert.ok(!/^\s*external_url\s*=/m.test(toml), "the footgun is never written\n" + toml);
});

test("reconcile carries the stored confirmations preference back", () => {
  const on = reconciledConfigToml("", {
    portOffset: 0,
    email: { origin: "https://app.dk", smtp: SMTP, confirmations: true }
  });
  assert.match(on.toml, /enable_confirmations = true/, "confirmations re-applied when stored on");

  const off = reconciledConfigToml("", {
    portOffset: 0,
    email: { origin: "https://app.dk", smtp: SMTP, confirmations: false }
  });
  assert.ok(!/enable_confirmations = true/.test(off.toml), "left off when the stored preference is off");
});
