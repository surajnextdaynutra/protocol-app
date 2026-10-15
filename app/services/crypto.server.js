import crypto from "node:crypto";

/* AES-256-GCM for data at rest (banking details). The key is derived from
   the ENCRYPTION_KEY env var; without one the app refuses to store banking
   data rather than write it in plain text. */

let key = null;
function getKey() {
  if (key) return key;
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      "ENCRYPTION_KEY is not set (min 16 characters) - banking details cannot be stored.",
    );
  }
  key = crypto.scryptSync(secret, "protocol-rx/banking/v1", 32);
  return key;
}

/** JSON-serialisable value -> "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return ["v1", iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptJson(blob) {
  if (!blob) return null;
  const [version, iv, tag, data] = String(blob).split(".");
  if (version !== "v1") throw new Error("Unknown encryption version");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8"));
}
