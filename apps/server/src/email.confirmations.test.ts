import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_MAIL_TEMPLATES,
  patchStackAuthMail,
  readStackAuthMailAudit,
  setStackEmailConfirmations,
  writeDefaultAuthMailTemplates
} from "./services/resources/supabaseAuthMail.js";

const SMTP = {
  host: "smtp.mx.cloudflare.net",
  port: 465,
  user: "api_token",
  from: "noreply@x.dk",
  fromName: "X"
};

function stackDir(configToml: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-conf-"));
  fs.mkdirSync(path.join(root, "supabase"), { recursive: true });
  fs.writeFileSync(path.join(root, "supabase", "config.toml"), configToml, "utf8");
  return root;
}

test("setStackEmailConfirmations: turns the flag on, audit and file agree", () => {
  const dir = stackDir('project_id = "app"\n');
  try {
    const res = setStackEmailConfirmations(dir, true);
    assert.equal(res.changed, true);
    assert.equal(res.audit.signup_confirmation_email, true);
    const toml = fs.readFileSync(path.join(dir, "supabase", "config.toml"), "utf8");
    assert.match(toml, /\[auth\.email\]/);
    assert.match(toml, /enable_confirmations = true/);
    assert.match(toml, /project_id = "app"/); // untouched
    assert.equal(readStackAuthMailAudit(dir)?.signup_confirmation_email, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setStackEmailConfirmations: turns it back off", () => {
  const dir = stackDir('project_id = "app"\n\n[auth.email]\nenable_confirmations = true\n');
  try {
    const res = setStackEmailConfirmations(dir, false);
    assert.equal(res.changed, true);
    assert.equal(res.audit.signup_confirmation_email, false);
    assert.match(
      fs.readFileSync(path.join(dir, "supabase", "config.toml"), "utf8"),
      /enable_confirmations = false/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setStackEmailConfirmations: re-applying the same value is a no-op", () => {
  const dir = stackDir('project_id = "app"\n\n[auth.email]\nenable_confirmations = true\n');
  try {
    const res = setStackEmailConfirmations(dir, true);
    assert.equal(res.changed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setStackEmailConfirmations: leaves a configured SMTP block and other sections intact", () => {
  const dir = stackDir(
    'project_id = "app"\n\n[functions.send-mail]\nverify_jwt = false\n\n' +
      "[auth.email.smtp]\nenabled = true\nhost = \"smtp.mx.cloudflare.net\"\n"
  );
  try {
    setStackEmailConfirmations(dir, true);
    const toml = fs.readFileSync(path.join(dir, "supabase", "config.toml"), "utf8");
    assert.match(toml, /\[functions\.send-mail\]/);
    assert.match(toml, /\[auth\.email\.smtp\]/);
    assert.match(toml, /host = "smtp\.mx\.cloudflare\.net"/);
    assert.match(toml, /enable_confirmations = true/);
    const audit = readStackAuthMailAudit(dir);
    assert.equal(audit?.smtp_configured, true);
    assert.equal(audit?.signup_confirmation_email, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readStackAuthMailAudit: null when the stack has no config.toml", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-conf-none-"));
  try {
    assert.equal(readStackAuthMailAudit(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeDefaultAuthMailTemplates: writes one file per type, never overwriting", () => {
  const dir = stackDir('project_id = "app"\n');
  try {
    const first = writeDefaultAuthMailTemplates(dir);
    assert.equal(first.length, AUTH_MAIL_TEMPLATES.length, "all templates written the first time");
    for (const t of AUTH_MAIL_TEMPLATES) {
      const file = path.join(dir, "supabase", "templates", `${t.key}.html`);
      assert.ok(fs.existsSync(file), `${t.key}.html exists`);
      assert.match(fs.readFileSync(file, "utf8"), /\{\{ \.SiteURL \}\}\/auth\/v1\/verify/);
    }
    // A hand-edited template must survive a second call.
    const confirm = path.join(dir, "supabase", "templates", "confirmation.html");
    fs.writeFileSync(confirm, "<h1>mine</h1>", "utf8");
    const second = writeDefaultAuthMailTemplates(dir);
    assert.equal(second.length, 0, "nothing re-written when all files already exist");
    assert.equal(fs.readFileSync(confirm, "utf8"), "<h1>mine</h1>", "custom template untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("patchStackAuthMail: enabling email sets no external_url and writes the templates", () => {
  // The whole point of the fix: a stack that had a public external_url comes out
  // restartable (no external_url) with SiteURL templates on disk.
  const dir = stackDir('project_id = "app"\n\n[api]\nport = 55821\nexternal_url = "https://app.dk"\n');
  try {
    const res = patchStackAuthMail(dir, "https://app.dk", SMTP);
    assert.equal(res.changed, true);
    const toml = fs.readFileSync(path.join(dir, "supabase", "config.toml"), "utf8");
    assert.ok(!/^\s*external_url\s*=/m.test(toml), "external_url stripped\n" + toml);
    assert.ok(toml.includes("port = 55821"), "port block preserved");
    assert.ok(fs.existsSync(path.join(dir, "supabase", "templates", "confirmation.html")), "template written");
    assert.equal(res.audit.smtp_configured, true);
    assert.equal(res.audit.public_links, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
