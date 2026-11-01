import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import {
  assertValidToml,
  removeTomlKey,
  setTomlValues,
  tomlDefinesTable,
  tomlError
} from "./services/resources/tomlEdit.js";
import { reconciledConfigToml } from "./services/resources/reconcileConfig.js";
import { applyAuthMailToToml, mergedRedirectUrls } from "./services/resources/supabaseAuthMail.js";

/**
 * Structure-aware config.toml edits. The 2026-11-01 Awaire incident: the old
 * line-oriented rewriter replaced only the first line of a multi-line
 * `additional_redirect_urls` array, leaving its elements and `]` dangling, and
 * the Supabase CLI refused the whole file — no `supabase start`, no migrations.
 */

// Awaire's committed supabase/config.toml (trimmed to the shapes that matter):
// comments, a multi-line array with a trailing comma, a commented-out
// [auth.email.smtp] block, and no newline at the end of the file.
const AWAIRE_CONFIG = [
  'project_id = "ywggdfrhochcbmkvgtrq"',
  "",
  "[functions.ai-interactive]",
  "verify_jwt = true",
  "",
  "# --- Local self-hosted (ServerHoster) Supabase host ports ---",
  "[api]",
  "port = 54521",
  "",
  "[db]",
  "port = 54522",
  "shadow_port = 54520",
  "",
  "[db.pooler]",
  "port = 54529",
  "",
  "[studio]",
  "enabled = false",
  "",
  "[auth]",
  "# Never drop this line.",
  'jwt_secret = "env(SUPABASE_AUTH_JWT_SECRET)"',
  "",
  "# Where GoTrue sends users after email links.",
  'site_url = "http://localhost:8080"',
  "additional_redirect_urls = [",
  '  "http://localhost:8080/reset-password",',
  '  "http://localhost:8080/invite",',
  '  "http://localhost:8080/invite/**",',
  '  "https://app.awaire.dk/reset-password",',
  '  "https://app.awaire.dk/invite/**",',
  "]",
  "",
  "# Auth mail. Uncomment and supply credentials via the environment:",
  "#",
  "# [auth.email.smtp]",
  "# enabled = true",
  '# sender_name = "Awaire"'
].join("\n");

const SMTP = {
  host: "smtp.mx.cloudflare.net",
  port: 465,
  user: "api_token",
  from: "noreply@awaire.dk",
  fromName: "Awaire"
};

const EMAIL = { origin: "https://awaire.dk", smtp: SMTP, confirmations: true };

test("the Awaire config: reapplying ports + email yields valid TOML that keeps the app's redirects", () => {
  assert.equal(tomlError(AWAIRE_CONFIG), null, "fixture itself is valid");
  const { toml, applied } = reconciledConfigToml(AWAIRE_CONFIG, { portOffset: 200, email: EMAIL });
  assert.equal(tomlError(toml), null, `result must parse:\n${toml}`);
  assert.ok(applied.includes("email + templates"), applied.join());
  assert.ok(toml.endsWith("\n"), "output ends with a newline");

  const doc = parse(toml) as Record<string, any>;
  assert.equal(doc.auth.site_url, "https://awaire.dk");
  assert.deepEqual(doc.auth.additional_redirect_urls, [
    "http://localhost:8080/reset-password",
    "http://localhost:8080/invite",
    "http://localhost:8080/invite/**",
    "https://app.awaire.dk/reset-password",
    "https://app.awaire.dk/invite/**",
    "https://awaire.dk",
    "https://awaire.dk/**"
  ]);
  assert.equal(doc.auth.jwt_secret, "env(SUPABASE_AUTH_JWT_SECRET)");
  assert.equal(doc.auth.email.smtp.sender_name, "Awaire");
  assert.equal(doc.auth.email.smtp.port, 465);
  assert.equal(doc.auth.email.enable_confirmations, true);
  assert.equal(doc.auth.email.template.recovery.content_path, "./supabase/templates/recovery.html");
  assert.equal(doc.api.port, 54521);
  assert.equal(doc.db.shadow_port, 54520);
  // Untouched content survives byte for byte.
  assert.ok(toml.includes("# Never drop this line."));
  assert.ok(toml.includes("# [auth.email.smtp]"), "commented-out block stays a comment");
  assert.ok(toml.includes("[functions.ai-interactive]\nverify_jwt = true"));
  // No dangling element of the old array.
  assert.equal(toml.match(/http:\/\/localhost:8080\/invite"/g)?.length, 1);
});

test("the Awaire config: reapplying twice is a no-op (idempotent)", () => {
  const once = reconciledConfigToml(AWAIRE_CONFIG, { portOffset: 200, email: EMAIL }).toml;
  const twice = reconciledConfigToml(once, { portOffset: 200, email: EMAIL });
  assert.equal(twice.toml, once);
  assert.deepEqual(twice.applied, []);
});

test("CRLF files stay CRLF, including every inserted line", () => {
  const crlf = AWAIRE_CONFIG.replace(/\n/g, "\r\n");
  const { toml } = reconciledConfigToml(crlf, { portOffset: 200, email: EMAIL });
  assert.equal(tomlError(toml), null, toml);
  assert.ok(!/[^\r]\n/.test(toml), "no bare LF was introduced");
  assert.ok(toml.endsWith("\r\n"));
  const again = reconciledConfigToml(toml, { portOffset: 200, email: EMAIL });
  assert.equal(again.toml, toml);
});

test("setTomlValues replaces a multi-line value whole, comments and trailing comment included", () => {
  const toml = [
    "[auth]",
    "additional_redirect_urls = [ # app routes",
    '  "a", # first',
    '  "b",',
    "] # end of list",
    'site_url = "x"',
    ""
  ].join("\n");
  const out = setTomlValues(toml, [{ section: "auth", key: "additional_redirect_urls", value: ["c"] }]);
  assert.equal(tomlError(out), null, out);
  assert.equal(out, '[auth]\nadditional_redirect_urls = ["c"] # end of list\nsite_url = "x"\n');
});

test("setTomlValues replaces an inline table and a multi-line string whole", () => {
  const toml = [
    "[edge_runtime]",
    'secrets = { A = "1", B = "]" }',
    'policy = """',
    "line one",
    'with a " quote and a ] bracket',
    '"""',
    "enabled = true",
    ""
  ].join("\n");
  const out = setTomlValues(toml, [
    { section: "edge_runtime", key: "secrets", value: { raw: '{ A = "2" }' } },
    { section: "edge_runtime", key: "policy", value: "per_worker" }
  ]);
  assert.equal(tomlError(out), null, out);
  const doc = parse(out) as Record<string, any>;
  assert.deepEqual({ ...doc.edge_runtime.secrets }, { A: "2" });
  assert.equal(doc.edge_runtime.policy, "per_worker");
  assert.equal(doc.edge_runtime.enabled, true);
});

test("setTomlValues: a header with a comment or spaces is still the same table", () => {
  const toml = '[ auth ]  # GoTrue\nsite_url = "x"\n';
  const out = setTomlValues(toml, [{ section: "auth", key: "site_url", value: "https://a.dk" }]);
  assert.equal(out, '[ auth ]  # GoTrue\nsite_url = "https://a.dk"\n');
});

test("setTomlValues: a table defined through dotted keys gets a dotted key, not a second header", () => {
  const toml = '[auth]\nemail.smtp.host = "old"\n';
  const out = setTomlValues(toml, [
    { section: "auth.email.smtp", key: "host", value: "new" },
    { section: "auth.email.smtp", key: "port", value: 465 }
  ]);
  assert.equal(tomlError(out), null, out);
  const doc = parse(out) as Record<string, any>;
  assert.deepEqual({ ...doc.auth.email.smtp }, { host: "new", port: 465 });
  assert.ok(!out.includes("[auth.email.smtp]"));
  assert.ok(tomlDefinesTable(toml, "auth.email.smtp"));
});

test("setTomlValues: a new key lands after the table's last key, above the next table's comment", () => {
  const toml = "[db]\nport = 1\n\n# pooler\n[db.pooler]\nport = 2\n";
  const out = setTomlValues(toml, [{ section: "db", key: "shadow_port", value: 3 }]);
  assert.equal(out, "[db]\nport = 1\nshadow_port = 3\n\n# pooler\n[db.pooler]\nport = 2\n");
});

test("setTomlValues: appending to a file without a trailing newline keeps both tables valid", () => {
  const out = setTomlValues('project_id = "x"', [{ section: "api", key: "port", value: 54421 }]);
  assert.equal(out, 'project_id = "x"\n\n[api]\nport = 54421\n');
  assert.equal(setTomlValues(out, [{ section: "api", key: "port", value: 54421 }]), out);
});

test("setTomlValues leaves an unchanged document byte-identical", () => {
  const toml = "[api]\nport = 54421"; // no trailing newline, already correct
  assert.equal(setTomlValues(toml, [{ section: "api", key: "port", value: 54421 }]), toml);
});

test("[[array tables]] are never mistaken for the table being edited", () => {
  const toml = '[[auth.hook]]\nuri = "a"\n';
  const out = setTomlValues(toml, [{ section: "auth", key: "site_url", value: "s" }]);
  assert.equal(tomlError(out), null, out);
  assert.ok(out.includes('[[auth.hook]]\nuri = "a"'));
});

test("removeTomlKey drops a multi-line value entirely", () => {
  const toml = '[api]\nexternal_url = [\n  "x",\n]\nport = 1\n';
  assert.equal(removeTomlKey(toml, "api", "external_url"), "[api]\nport = 1\n");
  assert.equal(removeTomlKey(toml, "db", "external_url"), toml, "other tables untouched");
});

test("assertValidToml names the problem instead of letting an invalid file be written", () => {
  const broken = 'additional_redirect_urls = ["https://a.dk"]\n  "http://localhost:8080/invite",\n]\n';
  assert.notEqual(tomlError(broken), null);
  assert.throws(() => assertValidToml(broken, "supabase/config.toml"), /not be valid TOML/);
});

test("mergedRedirectUrls keeps the app's own entries and adds the origin once", () => {
  const toml = '[auth]\nadditional_redirect_urls = ["https://app.a.dk/reset", "https://a.dk"]\n';
  assert.deepEqual(mergedRedirectUrls(toml, "https://a.dk"), [
    "https://app.a.dk/reset",
    "https://a.dk",
    "https://a.dk/**"
  ]);
  assert.deepEqual(mergedRedirectUrls("", "https://a.dk"), ["https://a.dk", "https://a.dk/**"]);
});

test("applyAuthMailToToml on a file whose [auth.email] comes first appends valid subtables", () => {
  const toml = "[auth.email]\nenable_signup = true\n";
  const out = applyAuthMailToToml(toml, "https://a.dk", SMTP);
  assert.equal(tomlError(out), null, out);
  const doc = parse(out) as Record<string, any>;
  assert.equal(doc.auth.email.enable_signup, true);
  assert.equal(doc.auth.email.smtp.host, SMTP.host);
});
