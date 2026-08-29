import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readStackAuthMailAudit,
  setStackEmailConfirmations
} from "./services/resources/supabaseAuthMail.js";

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
