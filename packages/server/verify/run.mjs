/**
 * Smoke tests against a RUNNING server and a REAL Postgres.
 *
 *   pnpm verify          (server must already be up on :8080)
 *
 * These cover the parts of the definition of done that unit tests
 * structurally cannot: the paint transaction under real concurrency, the
 * tile pyramid, and WebSocket fan-out. Vitest covers the pure logic; this
 * covers the wiring between it.
 *
 * Not a substitute for the k6 runs — those measure behaviour under load,
 * these only prove correctness once.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = ["tiles.mjs", "realtime.mjs", "economy.mjs", "geo.mjs", "timelapse.mjs", "templates.mjs", "features.mjs", "embed.mjs", "admin.mjs", "alliances.mjs", "export.mjs", "accounts.mjs", "discord.mjs", "streaks.mjs", "deletion.mjs"];

const res = await fetch("http://127.0.0.1:8080/api/health").catch(() => null);
if (!res?.ok) {
  console.error("Server is not responding on :8080. Start it with `pnpm dev` first.");
  process.exit(1);
}

let failed = 0;
for (const script of scripts) {
  console.log(`\n=== ${script} ${"=".repeat(Math.max(0, 60 - script.length))}`);
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [join(here, script)], { stdio: "inherit" }).on("close", resolve);
  });
  if (code !== 0) failed++;
}

console.log(`\n${failed === 0 ? "all verify scripts passed" : `${failed} script(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
