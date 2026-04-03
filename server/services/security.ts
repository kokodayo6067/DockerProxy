import crypto from "crypto";
import { CONFIG } from "../utils/config";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

type EncryptedPayload = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

function deriveKey(secret: string) {
  return crypto.createHash("sha256").update(secret).digest().subarray(0, KEY_LENGTH);
}

function getMasterSecret() {
  return String(CONFIG.APP_MASTER_KEY || "").trim();
}

export function hasMasterKey() {
  return getMasterSecret().length > 0;
}

export function encryptSecret(value: string): EncryptedPayload {
  const secret = getMasterSecret();
  if (!secret) {
    throw new Error("未配置 APP_MASTER_KEY，无法安全保存敏感凭据");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: 1,
  };
}

export function decryptSecret(payload: EncryptedPayload) {
  const secret = getMasterSecret();
  if (!secret) {
    throw new Error("未配置 APP_MASTER_KEY，无法解密敏感凭据");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret),
    Buffer.from(payload.iv, "base64"),
    { authTagLength: AUTH_TAG_LENGTH }
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf-8");
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
  return `scrypt:${salt.toString("base64")}:${key.toString("base64")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, saltBase64, keyBase64] = String(storedHash).split(":");
  if (algorithm !== "scrypt" || !saltBase64 || !keyBase64) return false;
  const salt = Buffer.from(saltBase64, "base64");
  const expectedKey = Buffer.from(keyBase64, "base64");
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expectedKey.length, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
  return crypto.timingSafeEqual(expectedKey, derivedKey);
}
