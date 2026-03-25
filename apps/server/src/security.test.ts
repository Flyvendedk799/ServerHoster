import test from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret, maskSecret } from "./security.js";

test("secret encryption round-trip", () => {
  const raw = "my-super-secret-value";
  const key = "unit-test-key";
  const encrypted = encryptSecret(raw, key);
  assert.notEqual(encrypted, raw);
  assert.equal(decryptSecret(encrypted, key), raw);
});

test("secret masking keeps edges", () => {
  const masked = maskSecret("abcdefgh");
  assert.equal(masked, "ab****gh");
});
