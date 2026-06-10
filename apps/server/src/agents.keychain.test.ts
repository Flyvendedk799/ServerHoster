import test from "node:test";
import assert from "node:assert/strict";
import { darwinKeychainBootstrap, keychainPasswordForProfile } from "./services/agents.js";

test("keychain password is deterministic per profile and never the secret key", () => {
  const a1 = keychainPasswordForProfile("server-secret", "profile-a");
  const a2 = keychainPasswordForProfile("server-secret", "profile-a");
  const b = keychainPasswordForProfile("server-secret", "profile-b");
  const other = keychainPasswordForProfile("other-secret", "profile-a");

  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.notEqual(a1, other);
  assert.notEqual(a1, "server-secret");
  assert.match(a1, /^[0-9a-f]{64}$/);
});

test("darwin keychain bootstrap creates, defaults, and unlocks the profile keychain", () => {
  const script = darwinKeychainBootstrap();

  // The password must come from the session env, never be inlined.
  assert.ok(script.includes('"$SURVHUB_AGENT_KEYCHAIN_PASSWORD"'));
  assert.ok(script.includes("security create-keychain"));
  assert.ok(script.includes("security default-keychain"));
  assert.ok(script.includes("security unlock-keychain"));
  // Keychain lives inside the (HOME-isolated) agent home.
  assert.ok(script.includes("$HOME/Library/Keychains/login.keychain-db"));
  // Steps chain with `;` so a bootstrap hiccup surfaces in the provider
  // command instead of silently aborting the session.
  assert.ok(!script.includes("&&"));
});
