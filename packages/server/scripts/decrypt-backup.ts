import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { decryptBackup } from "../src/backup/encrypt.js";

loadDotenv({ path: resolve(".env"), quiet: true });

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  throw new Error("usage: decrypt-backup.ts <encrypted.cpbk> <restored.sql.gz>");
}
const key = process.env.BACKUP_ENCRYPTION_KEY ?? "";
if (!key) throw new Error("BACKUP_ENCRYPTION_KEY is not configured");
await writeFile(resolve(output), decryptBackup(await readFile(resolve(input)), key), { flag: "wx" });
console.log(`[backup] decrypted backup to ${resolve(output)}`);
