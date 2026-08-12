import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthMailToToml,
  auditAuthMailToml,
  SMTP_PASS_ENV_KEY
} from "./services/resources/supabaseAuthMail.js";

const SMTP = {
  host: "smtp.mx.cloudflare.net",
  port: 465,
  user: "api_token",
  from: "noreply@dinredaktion.dk",
  fromName: "DinRedaktion"
};

test("applyAuthMailToToml: a bare config gains every key GoTrue needs to mail", () => {
  const out = applyAuthMailToToml('project_id = "svyy"\n', "https://dinredaktion.dk", SMTP);
  assert.ok(out.includes('project_id = "svyy"'), "keeps project_id");
  assert.ok(out.includes('external_url = "https://dinredaktion.dk"'), out);
  assert.ok(out.includes('site_url = "https://dinredaktion.dk"'), out);
  assert.ok(
    out.includes('additional_redirect_urls = ["https://dinredaktion.dk", "https://dinredaktion.dk/**"]'),
    out
  );
  assert.ok(out.includes("[auth.email.smtp]"), out);
  assert.ok(out.includes('host = "smtp.mx.cloudflare.net"'), out);
  assert.ok(out.includes("port = 465"), "port stays a bare number, not a string");
  assert.ok(out.includes("enabled = true"), "booleans are unquoted");
  assert.ok(out.includes('admin_email = "noreply@dinredaktion.dk"'), out);
});

test("applyAuthMailToToml: the SMTP password is an env() reference, never a literal", () => {
  const out = applyAuthMailToToml("", "https://x.dk", SMTP);
  // The CLI rejects a literal here, and a literal would also put the relay
  // password in a file inside the project clone.
  assert.ok(out.includes(`pass = "env(${SMTP_PASS_ENV_KEY})"`), out);
});

test("applyAuthMailToToml: idempotent — re-applying changes nothing", () => {
  const once = applyAuthMailToToml('project_id = "svyy"\n', "https://dinredaktion.dk", SMTP);
  const twice = applyAuthMailToToml(once, "https://dinredaktion.dk", SMTP);
  assert.equal(twice, once);
});

test("applyAuthMailToToml: replaces stale values in place instead of duplicating them", () => {
  const before = [
    'project_id = "svyy"',
    "",
    "[api]",
    "port = 54621",
    'external_url = "http://127.0.0.1:54621"',
    "",
    "[auth]",
    'site_url = "http://localhost:3000"',
    'jwt_secret = "env(SUPABASE_AUTH_JWT_SECRET)"'
  ].join("\n");
  const out = applyAuthMailToToml(before, "https://dinredaktion.dk", SMTP);
  assert.ok(out.includes("port = 54621"), "the port block survives");
  assert.ok(out.includes('jwt_secret = "env(SUPABASE_AUTH_JWT_SECRET)"'), "jwt_secret survives");
  assert.ok(!out.includes("127.0.0.1"), out);
  assert.ok(!out.includes("localhost:3000"), out);
  assert.equal(out.match(/^\[api\]$/gm)?.length, 1, "no duplicate [api]");
  assert.equal(out.match(/^external_url =/gm)?.length, 1, "no duplicate external_url");
  assert.equal(out.match(/^site_url =/gm)?.length, 1, "no duplicate site_url");
});

test("applyAuthMailToToml: a trailing slash on the origin is not doubled into the links", () => {
  const out = applyAuthMailToToml("", "https://dinredaktion.dk/", SMTP);
  assert.ok(out.includes('site_url = "https://dinredaktion.dk"'), out);
  assert.ok(!out.includes('"https://dinredaktion.dk/"'), out);
  assert.ok(out.includes('"https://dinredaktion.dk/**"'), out);
});

test("auditAuthMailToml: the DinRedaktion failure — SMTP healthy, signup mail still never sent", () => {
  // Exactly the state that produced "I signed up and got no email": the SMTP
  // block was configured by hand, but enable_confirmations was never set, so
  // GoTrue auto-confirmed and sent nothing.
  const toml = applyAuthMailToToml('project_id = "svyy"\n', "https://dinredaktion.dk", SMTP);
  const audit = auditAuthMailToml(toml);
  assert.equal(audit.smtp_configured, true);
  assert.equal(audit.public_links, true);
  assert.equal(audit.signup_confirmation_email, false, "the silent failure this audit exists to catch");
  assert.equal(audit.warnings.length, 1);
  assert.match(audit.warnings[0] ?? "", /enable_confirmations/);
});

test("auditAuthMailToml: a fully wired stack reports clean", () => {
  const toml = `${applyAuthMailToToml("", "https://dinredaktion.dk", SMTP)}\n[auth.email]\nenable_confirmations = true\n`;
  const audit = auditAuthMailToml(toml);
  assert.deepEqual(audit.warnings, []);
  assert.equal(audit.signup_confirmation_email, true);
});

test("auditAuthMailToml: an untouched CLI default config reports all three defects", () => {
  const audit = auditAuthMailToml('project_id = "svyy"\n\n[auth]\njwt_secret = "env(X)"\n');
  assert.equal(audit.signup_confirmation_email, false);
  assert.equal(audit.smtp_configured, false);
  assert.equal(audit.public_links, false);
  assert.equal(audit.warnings.length, 3);
});

test("auditAuthMailToml: a loopback external_url does not count as public links", () => {
  const audit = auditAuthMailToml('[api]\nexternal_url = "http://127.0.0.1:54621"\n');
  assert.equal(audit.public_links, false);
  assert.ok(audit.warnings.some((w) => /external_url/.test(w)), "warns about the dead link");
});
