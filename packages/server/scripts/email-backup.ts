import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import nodemailer from "nodemailer";
import { encryptBackup } from "../src/backup/encrypt.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: join(repoRoot, ".env"), quiet: true });

const source = process.argv[2] ? resolve(process.argv[2]) : "";
if (!source || !existsSync(source)) throw new Error("usage: email-backup.ts <dump-file>");

const recipient = process.env.BACKUP_EMAIL?.trim();
const recoveryKey = process.env.BACKUP_ENCRYPTION_KEY ?? "";
if (!recipient) throw new Error("BACKUP_EMAIL is not configured");
if (!recoveryKey) throw new Error("BACKUP_ENCRYPTION_KEY is not configured");

const marker = `${source}.email-sent`;
if (existsSync(marker) && process.env.BACKUP_EMAIL_FORCE !== "true") {
  console.log(`[backup] ${basename(source)} was already emailed`);
  process.exit(0);
}

const encrypted = encryptBackup(await readFile(source), recoveryKey);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth:
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
});

const stamp = basename(source).match(/\d{8}/)?.[0] ?? new Date().toISOString().slice(0, 10);
const info = await transport.sendMail({
  from: process.env.EMAIL_FROM ?? "CanvasPlanet <noreply@canvasplanet.net>",
  to: recipient,
  subject: `CanvasPlanet encrypted backup ${stamp}`,
  text:
    "Encrypted CanvasPlanet database backup attached. Keep the recovery key you received separately in a password manager. Restore instructions are in the repository README.",
  attachments: [
    {
      filename: `${basename(source)}.cpbk`,
      content: encrypted,
      contentType: "application/octet-stream",
    },
  ],
});

await writeFile(marker, `${new Date().toISOString()} ${info.messageId}\n`, { flag: "wx" });
console.log(`[backup] emailed encrypted ${basename(source)} off-box`);
