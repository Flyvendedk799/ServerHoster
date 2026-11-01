import test from "node:test";
import assert from "node:assert/strict";
import { isInheritedDefaultFromName, resolveEmailBranding } from "./services/emailBranding.js";

test("resolveEmailBranding: explicit from + fromName win", () => {
  const b = resolveEmailBranding({
    from: "shop@app.dk",
    fromName: "Shop",
    existingFrom: "old@app.dk",
    existingFromName: "Old",
    defaultFrom: "noreply@host.dk",
    defaultFromName: "Host"
  });
  assert.deepEqual(b, { from: "shop@app.dk", fromName: "Shop" });
});

test("resolveEmailBranding: empty explicit fromName clears the display name", () => {
  const b = resolveEmailBranding({
    from: "shop@app.dk",
    fromName: "  ",
    existingFromName: "Shop",
    defaultFromName: "Host"
  });
  assert.equal(b.fromName, "");
  assert.equal(b.from, "shop@app.dk");
});

test("resolveEmailBranding: omitting fromName preserves existing project branding", () => {
  // The old Email-tab Update only sent `from` — falling through to the global
  // default would wipe a custom per-app From name on every save.
  const b = resolveEmailBranding({
    from: "shop@app.dk",
    existingFrom: "shop@app.dk",
    existingFromName: "Shop Support",
    defaultFrom: "noreply@host.dk",
    defaultFromName: "Host Default"
  });
  assert.deepEqual(b, { from: "shop@app.dk", fromName: "Shop Support" });
});

test("resolveEmailBranding: new enable seeds from global defaults", () => {
  const b = resolveEmailBranding({
    defaultFrom: "noreply@host.dk",
    defaultFromName: "Host Default"
  });
  assert.deepEqual(b, { from: "noreply@host.dk", fromName: "Host Default" });
});

test("resolveEmailBranding: empty explicit from falls back to existing then default", () => {
  const withExisting = resolveEmailBranding({
    from: "",
    existingFrom: "shop@app.dk",
    defaultFrom: "noreply@host.dk"
  });
  assert.equal(withExisting.from, "shop@app.dk");

  const withDefault = resolveEmailBranding({
    from: "   ",
    defaultFrom: "noreply@host.dk"
  });
  assert.equal(withDefault.from, "noreply@host.dk");
});

test("resolveEmailBranding: trims whitespace on explicit values", () => {
  const b = resolveEmailBranding({
    from: "  a@b.dk  ",
    fromName: "  App  "
  });
  assert.deepEqual(b, { from: "a@b.dk", fromName: "App" });
});

test("resolveEmailBranding: a new enable takes the app's own name, not another app's brand", () => {
  const b = resolveEmailBranding({
    existingFrom: "noreply@awaire.dk",
    defaultFrom: "noreply@mymetaview.com",
    defaultFromName: "MetaView",
    projectName: "Awaire"
  });
  assert.deepEqual(b, { from: "noreply@awaire.dk", fromName: "Awaire" });
});

test("resolveEmailBranding: the global name copied onto an app with its own domain is ignored", () => {
  // The live Awaire row: SMTP_FROM noreply@awaire.dk, SMTP_FROM_NAME "MetaView"
  // (seeded from the global default at enable time) — GoTrue mailed as MetaView.
  const b = resolveEmailBranding({
    existingFrom: "noreply@awaire.dk",
    existingFromName: "MetaView",
    defaultFrom: "noreply@mymetaview.com",
    defaultFromName: "MetaView",
    projectName: "Awaire"
  });
  assert.equal(b.fromName, "Awaire");
});

test("resolveEmailBranding: a stored name on the default's own domain is kept", () => {
  const b = resolveEmailBranding({
    existingFrom: "noreply@mymetaview.com",
    existingFromName: "MetaView",
    defaultFrom: "noreply@mymetaview.com",
    defaultFromName: "MetaView",
    projectName: "MyMetaView"
  });
  assert.equal(b.fromName, "MetaView");
});

test("isInheritedDefaultFromName only flags the default name on a different domain", () => {
  const base = { defaultFrom: "noreply@host.dk", defaultFromName: "Host" };
  assert.equal(isInheritedDefaultFromName({ ...base, fromName: "Host", from: "noreply@app.dk" }), true);
  assert.equal(isInheritedDefaultFromName({ ...base, fromName: "App", from: "noreply@app.dk" }), false);
  assert.equal(isInheritedDefaultFromName({ ...base, fromName: "Host", from: "other@host.dk" }), false);
  assert.equal(isInheritedDefaultFromName({ ...base, fromName: "Host", from: "" }), false);
});
