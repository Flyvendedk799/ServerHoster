import test from "node:test";
import assert from "node:assert/strict";
import { resolveEmailBranding } from "./services/emailBranding.js";

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
