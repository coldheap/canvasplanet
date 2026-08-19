/**
 * Discord OAuth (ROADMAP.md §5.1 fast-follow) — everything reachable
 * *without* a real Discord account clicking "Authorize": the redirect to
 * Discord's own authorize screen (right client_id/redirect_uri/scope, and
 * the CSRF state cookie actually gets set), and every way the callback can
 * fail (no state, mismatched state, Discord reporting the user declined,
 * and a real-but-bogus code hitting Discord's real token endpoint and
 * getting refused).
 *
 * What this script structurally cannot cover: a real code exchange
 * succeeding, and therefore findOrCreateDiscordUser's account-linking/
 * creation logic. That needs a human to click "Authorize" on Discord's own
 * site — automatable in principle, not from an unattended script — and the
 * redirect URIs registered in Discord's developer portal in the first place
 * (see ROADMAP.md §5.1). Do that once, then exercise the full loop by hand
 * through the actual "Continue with Discord" button.
 */
import { finish } from "./finish.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://127.0.0.1:8080";
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:5173";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
const cookieValue = (cookies, name) => {
  const c = cookies.find((c) => c.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1) : null;
};

// ---- initiate: /api/auth/discord redirects to Discord's authorize screen --
const initiate = await fetch(`${BASE}/api/auth/discord`, { redirect: "manual" });
const location = initiate.headers.get("location");
const authorizeUrl = location ? new URL(location) : null;

check(
  "redirects (302) to discord.com's authorize endpoint",
  initiate.status === 302 && authorizeUrl?.origin === "https://discord.com",
  location ?? `HTTP ${initiate.status}`,
);
// This script is plain node, not tsx — it never loads .env the way env.ts
// does inside the server process, so it can only check a client_id is
// present, not compare it against the configured value.
check(
  "authorize URL carries a client_id",
  Boolean(authorizeUrl?.searchParams.get("client_id")),
  authorizeUrl?.searchParams.get("client_id"),
);
check(
  "redirect_uri points at PUBLIC_URL's callback route",
  authorizeUrl?.searchParams.get("redirect_uri") === `${PUBLIC_URL}/api/auth/discord/callback`,
  authorizeUrl?.searchParams.get("redirect_uri"),
);
check("scope requests identify + email", authorizeUrl?.searchParams.get("scope") === "identify email");

const initiateCookies = cookiesOf(initiate);
const state = authorizeUrl?.searchParams.get("state");
const stateCookie = cookieValue(initiateCookies, "cp_discord_state");
check(
  "sets a CSRF state cookie matching the query state",
  Boolean(state) && state === stateCookie,
  `query=${state} cookie=${stateCookie}`,
);

// ---- callback CSRF guards --------------------------------------------------
const noState = await fetch(`${BASE}/api/auth/discord/callback?code=x`, { redirect: "manual" });
check(
  "callback with no state at all redirects to ?discord_error=1",
  noState.status === 302 && noState.headers.get("location") === `${PUBLIC_URL}/?discord_error=1`,
  noState.headers.get("location"),
);

const mismatched = await fetch(`${BASE}/api/auth/discord/callback?code=x&state=wrong`, {
  redirect: "manual",
  headers: { cookie: `cp_discord_state=${stateCookie ?? "whatever"}` },
});
check(
  "callback with a state that doesn't match the cookie redirects to ?discord_error=1",
  mismatched.status === 302 && mismatched.headers.get("location") === `${PUBLIC_URL}/?discord_error=1`,
  mismatched.headers.get("location"),
);

const denied = await fetch(`${BASE}/api/auth/discord/callback?error=access_denied&state=${state}`, {
  redirect: "manual",
  headers: { cookie: `cp_discord_state=${state}` },
});
check(
  "Discord reporting the user declined redirects to ?discord_error=1",
  denied.status === 302 && denied.headers.get("location") === `${PUBLIC_URL}/?discord_error=1`,
  denied.headers.get("location"),
);

// ---- a real code exchange against Discord's real endpoint, with a bogus
// code — genuinely hits discord.com and gets a genuine refusal back, proving
// the failure path (not a mock of it) ----------------------------------------
if (state) {
  const bogusCode = await fetch(`${BASE}/api/auth/discord/callback?code=not-a-real-code&state=${state}`, {
    redirect: "manual",
    headers: { cookie: `cp_discord_state=${state}` },
  });
  check(
    "a bogus code is refused by Discord's real token endpoint and redirects to ?discord_error=1",
    bogusCode.status === 302 && bogusCode.headers.get("location") === `${PUBLIC_URL}/?discord_error=1`,
    bogusCode.headers.get("location"),
  );
}

finish(failures, "discord");
