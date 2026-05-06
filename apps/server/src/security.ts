import crypto from "node:crypto";

function getSecretKey(secretKey: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(secretKey || "survhub-dev-key")
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
