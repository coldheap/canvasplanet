import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("CPBK1", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Binary envelope: CPBK1 | salt | IV | GCM tag | ciphertext. */
export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
  if (passphrase.length < 24) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be at least 24 characters");
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptBackup(envelope: Buffer, passphrase: string): Buffer {
  const minimumLength = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (envelope.length < minimumLength || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a CanvasPlanet encrypted backup");
  }
  let offset = MAGIC.length;
  const salt = envelope.subarray(offset, (offset += SALT_BYTES));
  const iv = envelope.subarray(offset, (offset += IV_BYTES));
  const tag = envelope.subarray(offset, (offset += TAG_BYTES));
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(offset)), decipher.final()]);
}
