import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthMailToToml,
  auditAuthMailToml,
  authMailTemplateBody,
  AUTH_MAIL_TEMPLATES,
  stripApiExternalUrl,
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

test("applyAuthMailToToml: never sets api.external_url (the start-breaker)", () => {
  const out = applyAuthMailToToml('project_id = "svyy"\n', "https://dinredaktion.dk", SMTP);
  assert.ok(!/^\s*external_url\s*=/m.test(out), "no external_url is written\n" + out);
});

test("applyAuthMailToToml: references a SiteURL template per user-facing type", () => {
  const out = applyAuthMailToToml("", "https://dinredaktion.dk", SMTP);
  for (const t of AUTH_MAIL_TEMPLATES) {
    assert.ok(out.includes(`[auth.email.template.${t.key}]`), `references ${t.key}\n` + out);
    assert.ok(
      out.includes(`content_path = "./supabase/templates/${t.key}.html"`),
      `content_path for ${t.key}\n` + out
    );
  }
});

test("applyAuthMailToToml: leaves an operator's own template section untouched", () => {
  const before = [
    'project_id = "svyy"',
    "",
    "[auth.email.template.confirmation]",
    'subject = "Bekræft din e-mailadresse"',
    'content_path = "./supabase/templates/da/confirmation.html"'
  ].join("\n");
  const out = applyAuthMailToToml(before, "https://dinredaktion.dk", SMTP);
  assert.ok(out.includes('subject = "Bekræft din e-mailadresse"'), "keeps the custom subject");
  assert.ok(out.includes('content_path = "./supabase/templates/da/confirmation.html"'), "keeps the custom path");
  assert.equal(out.match(/\[auth\.email\.template\.confirmation\]/g)?.length, 1, "no duplicate section");
});

test("applyAuthMailToToml: the SMTP password is an env() reference, never a literal", () => {
  const out = applyAuthMailToToml("", "https://x.dk", SMTP);
  assert.ok(out.includes(`pass = "env(${SMTP_PASS_ENV_KEY})"`), out);
});

test("applyAuthMailToToml: idempotent — re-applying changes nothing", () => {
  const once = applyAuthMailToToml('project_id = "svyy"\n', "https://dinredaktion.dk", SMTP);
  const twice = applyAuthMailToToml(once, "https://dinredaktion.dk", SMTP);
  assert.equal(twice, once);
});

test("applyAuthMailToToml: strips a stale/public external_url instead of leaving the footgun", () => {
  const before = [
    'project_id = "svyy"',
    "",
    "[api]",
    "port = 54621",
    'external_url = "https://dinredaktion.dk"',
    "",
    "[auth]",
    'site_url = "http://localhost:3000"',
    'jwt_secret = "env(SUPABASE_AUTH_JWT_SECRET)"'
  ].join("\n");
  const out = applyAuthMailToToml(before, "https://dinredaktion.dk", SMTP);
  assert.ok(out.includes("port = 54621"), "the port block survives");
  assert.ok(out.includes('jwt_secret = "env(SUPABASE_AUTH_JWT_SECRET)"'), "jwt_secret survives");
  assert.ok(!/^\s*external_url\s*=/m.test(out), "external_url is gone\n" + out);
  assert.ok(!out.includes("localhost:3000"), "loopback site_url replaced");
  assert.equal(out.match(/^\[api\]$/gm)?.length, 1, "no duplicate [api]");
});

test("stripApiExternalUrl: only removes external_url inside [api]", () => {
  const toml = [
    "[api]",
    'external_url = "https://x.dk"',
    "port = 55821",
    "",
    "[other]",
    'external_url = "keep-me"'
  ].join("\n");
  const out = stripApiExternalUrl(toml);
  assert.ok(!out.includes('external_url = "https://x.dk"'), "drops the [api] one");
  assert.ok(out.includes('external_url = "keep-me"'), "leaves an unrelated section's key");
  assert.ok(out.includes("port = 55821"), "keeps sibling keys");
});

test("applyAuthMailToToml: a trailing slash on the origin is not doubled into the links", () => {
  const out = applyAuthMailToToml("", "https://dinredaktion.dk/", SMTP);
  assert.ok(out.includes('site_url = "https://dinredaktion.dk"'), out);
  assert.ok(!out.includes('"https://dinredaktion.dk/"'), out);
  assert.ok(out.includes('"https://dinredaktion.dk/**"'), out);
});

test("authMailTemplateBody: builds the link from SiteURL, not the loopback ConfirmationURL", () => {
  for (const t of AUTH_MAIL_TEMPLATES) {
    const html = authMailTemplateBody(t);
    assert.ok(
      html.includes(`{{ .SiteURL }}/auth/v1/verify?token={{ .TokenHash }}&type=${t.verifyType}`),
      `${t.key} uses SiteURL\n` + html
    );
    assert.ok(!html.includes("ConfirmationURL"), `${t.key} does not use the loopback ConfirmationURL`);
  }
});

test("auditAuthMailToml: SMTP + SiteURL templates + site_url count as public links", () => {
  const toml = applyAuthMailToToml('project_id = "svyy"\n', "https://dinredaktion.dk", SMTP);
  const audit = auditAuthMailToml(toml);
  assert.equal(audit.smtp_configured, true);
  assert.equal(audit.public_links, true, "site_url + a confirmation template makes links public");
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

test("auditAuthMailToml: site_url public but no template is NOT enough (default template is loopback)", () => {
  const audit = auditAuthMailToml('[auth]\nsite_url = "https://x.dk"\n');
  assert.equal(audit.public_links, false, "without a SiteURL template the default link is loopback");
});

test("auditAuthMailToml: a legacy public api.external_url still counts as public links", () => {
  const audit = auditAuthMailToml('[api]\nexternal_url = "https://x.dk"\n');
  assert.equal(audit.public_links, true, "the old shape is still recognised as public");
});
