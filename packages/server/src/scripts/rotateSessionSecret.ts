import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
const nextPath = `${envPath}.rotate-session-new-${process.pid}`;
const previousPath = `${envPath}.rotate-session-previous-${process.pid}`;

async function main(): Promise<void> {
  const originalEnv = await readFile(envPath, "utf8");
  if (!/^SESSION_SECRET=.*$/m.test(originalEnv)) {
    throw new Error("SESSION_SECRET is missing from the repository .env file");
  }

  const newSecret = randomBytes(32).toString("hex");
  const updatedEnv = originalEnv.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${newSecret}`);
  const envStats = await stat(envPath);

  await writeFile(nextPath, updatedEnv, { encoding: "utf8", flag: "wx", mode: envStats.mode });
  await chmod(nextPath, envStats.mode);
  await rename(envPath, previousPath);
  try {
    await rename(nextPath, envPath);
  } catch (error) {
    await rename(previousPath, envPath);
    await unlink(nextPath).catch(() => undefined);
    throw error;
  }

  await unlink(previousPath);
  console.log("[credentials] replaced SESSION_SECRET with a 256-bit value; the value was not printed");
  console.log("[credentials] existing signed sessions will be invalid after the API restarts");
}

main().catch((error) => {
  console.error("[credentials] session-secret rotation failed", error);
  process.exitCode = 1;
});
