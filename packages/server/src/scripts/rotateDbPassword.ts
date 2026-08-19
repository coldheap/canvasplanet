import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const envPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
const nextPath = `${envPath}.rotate-new-${process.pid}`;
const previousPath = `${envPath}.rotate-previous-${process.pid}`;

function replaceEnvValue(source: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (!line.test(source)) {
    return `${source.replace(/\s*$/, "")}\n${key}=${value}\n`;
  }
  return source.replace(line, `${key}=${value}`);
}

async function alterCurrentRolePassword(client: Client, password: string): Promise<void> {
  const result = await client.query<{ statement: string }>(
    "SELECT format('ALTER ROLE %I PASSWORD %L', current_user, $1::text) AS statement",
    [password],
  );
  const statement = result.rows[0]?.statement;
  if (!statement) throw new Error("PostgreSQL did not return a role alteration statement");
  await client.query(statement);
}

async function restoreEnvFile(): Promise<void> {
  await unlink(envPath).catch(() => undefined);
  await rename(previousPath, envPath);
  await unlink(nextPath).catch(() => undefined);
}

async function main(): Promise<void> {
  const originalEnv = await readFile(envPath, "utf8").catch(() => undefined);
  if (originalEnv === undefined) {
    throw new Error(`Unable to read ${envPath}`);
  }

  const match = originalEnv.match(/^DATABASE_URL=(.*)$/m);
  if (!match?.[1]) {
    throw new Error("DATABASE_URL is missing from the repository .env file");
  }

  const currentUrl = new URL(match[1].trim().replace(/^(['"])(.*)\1$/, "$2"));
  if (currentUrl.protocol !== "postgres:" && currentUrl.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }

  const oldPassword = decodeURIComponent(currentUrl.password);
  const newPassword = randomBytes(32).toString("hex");
  const nextUrl = new URL(currentUrl);
  nextUrl.password = newPassword;

  let updatedEnv = replaceEnvValue(originalEnv, "DATABASE_URL", nextUrl.toString());
  updatedEnv = replaceEnvValue(updatedEnv, "POSTGRES_PASSWORD", newPassword);

  const currentClient = new Client({ connectionString: currentUrl.toString() });
  await currentClient.connect();

  let envReplaced = false;
  let passwordChanged = false;
  try {
    const envStats = await stat(envPath);
    await writeFile(nextPath, updatedEnv, { encoding: "utf8", flag: "wx", mode: envStats.mode });
    await chmod(nextPath, envStats.mode);

    await alterCurrentRolePassword(currentClient, newPassword);
    passwordChanged = true;

    await rename(envPath, previousPath);
    try {
      await rename(nextPath, envPath);
      envReplaced = true;
    } catch (error) {
      await rename(previousPath, envPath);
      throw error;
    }

    const validationClient = new Client({ connectionString: nextUrl.toString() });
    try {
      await validationClient.connect();
      const result = await validationClient.query<{ current_user: string; current_database: string }>(
        "SELECT current_user, current_database() AS current_database",
      );
      const identity = result.rows[0];
      if (!identity) throw new Error("PostgreSQL credential validation returned no identity");
      console.log(
        `[credentials] rotated and validated for role ${identity.current_user} on database ${identity.current_database}`,
      );
      console.log("[credentials] generated a 256-bit password; the value was not printed");
    } finally {
      await validationClient.end().catch(() => undefined);
    }

    await unlink(previousPath);
  } catch (error) {
    if (passwordChanged) {
      await alterCurrentRolePassword(currentClient, oldPassword).catch((rollbackError) => {
        console.error("[credentials] CRITICAL: database password rollback failed", rollbackError);
      });
    }
    if (envReplaced) {
      await restoreEnvFile().catch((rollbackError) => {
        console.error("[credentials] CRITICAL: .env rollback failed", rollbackError);
      });
    } else {
      await unlink(nextPath).catch(() => undefined);
    }
    throw error;
  } finally {
    await currentClient.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("[credentials] rotation failed", error);
  process.exitCode = 1;
});
