import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEV_SECRET_KEY,
  usingDefaultSecretKey,
  encryptSecret,
  decryptSecret
} from "./security.js";
import { ensureLocalImagePresent, shouldRestoreServiceOnBoot } from "./services/runtime.js";

test("usingDefaultSecretKey: true only when no real key is configured", () => {
  assert.equal(usingDefaultSecretKey(""), true);
  assert.equal(usingDefaultSecretKey(undefined), true);
  assert.equal(usingDefaultSecretKey(null), true);
  assert.equal(usingDefaultSecretKey("a-real-strong-key"), false);
});

test("secrets encrypted under a real key are NOT readable with the default dev key", () => {
  const real = "real-strong-secret-key-value";
  const blob = encryptSecret("super-secret-token", real);
  assert.equal(decryptSecret(blob, real), "super-secret-token");
  // Decrypting with the wrong (default) key fails closed: decryptSecret returns
  // the input blob unchanged rather than the plaintext.
  assert.equal(decryptSecret(blob, DEFAULT_DEV_SECRET_KEY), blob);
  assert.equal(decryptSecret(blob, ""), blob);
});

test("ensureLocalImagePresent: throws an actionable error when a local build image is missing", async () => {
  const docker = {
    getImage: () => ({
      inspect: async () => {
        throw new Error("(HTTP code 404) no such image");
      }
    })
  };
  await assert.rejects(
    () => ensureLocalImagePresent(docker, "survhub-build-myservice:latest"),
    /missing locally.*Redeploy/s
  );
});

test("ensureLocalImagePresent: passes when the local build image exists", async () => {
  const docker = { getImage: () => ({ inspect: async () => ({ Id: "sha256:abc" }) }) };
  await assert.doesNotReject(() => ensureLocalImagePresent(docker, "survhub-build-myservice:latest"));
});

test("ensureLocalImagePresent: skips registry images (handled by the pull path)", async () => {
  let inspected = false;
  const docker = {
    getImage: () => ({
      inspect: async () => {
        inspected = true;
        return {};
      }
    })
  };
  await assert.doesNotReject(() => ensureLocalImagePresent(docker, "postgres:16"));
  assert.equal(inspected, false, "registry images must not be inspected here");
});

test("shouldRestoreServiceOnBoot: restores services running at a graceful shutdown, even if manual", () => {
  assert.equal(shouldRestoreServiceOnBoot({ startMode: "manual", wasRunningAtShutdown: true }), true);
  assert.equal(shouldRestoreServiceOnBoot({ startMode: "auto", wasRunningAtShutdown: true }), true);
});

test("shouldRestoreServiceOnBoot: otherwise honors start_mode only", () => {
  assert.equal(shouldRestoreServiceOnBoot({ startMode: "auto", wasRunningAtShutdown: false }), true);
  // Not in the shutdown marker + manual → stays down (deliberate stop, or a
  // crash that we don't relaunch blindly).
  assert.equal(shouldRestoreServiceOnBoot({ startMode: "manual", wasRunningAtShutdown: false }), false);
  assert.equal(shouldRestoreServiceOnBoot({ startMode: undefined, wasRunningAtShutdown: false }), false);
});
