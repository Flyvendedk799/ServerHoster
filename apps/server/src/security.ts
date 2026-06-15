import crypto from "node:crypto";

/**
 * Fallback key used when SURVHUB_SECRET_KEY is unset/empty. It is a PUBLIC,
 * well-known constant — anything encrypted under it (secrets at rest) is not
 * actually protected. The server logs a loud warning at boot in that case (see
 * warnIfDefaultSecretKey); production must set a real SURVHUB_SECRET_KEY.
 */
export const DEFAULT_DEV_SECRET_KEY = "survhub-dev-key";

/** True when no real secret key is configured and the insecure default is in effect. */
export function usingDefaultSecretKey(secretKey: string | undefined | null): boolean {
  return !secretKey;
}

function getSecretKey(secretKey: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(secretKey || DEFAULT_DEV_SECRET_KEY)
    .digest();
}

export function encryptSecret(value: string, secretKey: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSecretKey(secretKey), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(value: string, secretKey: string): string {
  const parts = value.split(":");
  if (parts.length !== 3) {
    return value;
  }
  try {
    const [ivHex, tagHex, encryptedHex] = parts;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getSecretKey(secretKey),
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return value;
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}
