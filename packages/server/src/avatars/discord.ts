/**
 * Importing a new Discord account's picture as its Worldcanvas avatar.
 *
 * The image is pulled through the same normalizeAvatar pipeline an upload
 * goes through and stored in `user_avatars` like any other, so nothing
 * downstream (the leaderboard tuple, /avatars/:id/:revision.webp, the admin
 * remove button) needs to know where it came from. Linking straight to
 * Discord's CDN would have been less code and worse: every viewer's browser
 * would hit discord.com for it, and the URL breaks the moment the player
 * changes their picture there.
 *
 * This runs once, at account creation only — after that the stored avatar is
 * the player's own to change, and a later login must not overwrite what they
 * uploaded (or deliberately removed).
 */

import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { AVATAR_SIZE, normalizeAvatar } from "./image.js";

/** Discord avatar hashes are 32 hex chars, with an `a_` prefix when the
 *  avatar is animated. Validated rather than trusted because the value is
 *  interpolated into a URL we then fetch. */
const AVATAR_HASH_PATTERN = /^(a_)?[0-9a-f]{32}$/i;

const FETCH_TIMEOUT_MS = 5_000;

/** Well under normalizeAvatar's own ceiling: at ?size=256 the CDN returns a
 *  few tens of KB, so anything past this is not the image we asked for. */
const MAX_BYTES = 512 * 1024;

/**
 * Requesting `.png` gets a still frame even for an `a_` animated avatar,
 * which is what normalizeAvatar accepts anyway. `size` is served by the CDN
 * itself, so the bytes crossing the wire are already the size we want.
 */
export function discordAvatarUrl(discordId: string, avatarHash: string): string {
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=${AVATAR_SIZE}`;
}

/**
 * Null for every "no picture to import" case: the account never set one (a
 * null hash means Discord serves a generated default, and the app's own
 * initial-letter fallback is the better version of that), the hash is
 * malformed, or the fetch/decode failed. Callers treat all of them the same
 * way — a missing avatar is not a reason to fail a login.
 */
export async function fetchDiscordAvatar(
  discordId: string,
  avatarHash: string | null | undefined,
): Promise<Buffer | null> {
  if (!avatarHash || !AVATAR_HASH_PATTERN.test(avatarHash)) return null;

  const res = await fetch(discordAvatarUrl(discordId, avatarHash), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`discord avatar fetch failed: HTTP ${res.status}`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`discord avatar too large: ${declared} bytes`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > MAX_BYTES) {
    throw new Error(`discord avatar too large: ${body.byteLength} bytes`);
  }

  return normalizeAvatar(body);
}

/**
 * Store the imported picture and hand back its revision, or null if there
 * was nothing to import. Never throws: an avatar is cosmetic and this sits
 * in the middle of account creation, so a CDN hiccup leaves the player with
 * the default picture rather than a failed sign-in.
 */
export async function importDiscordAvatar(
  userId: number,
  discordId: string,
  avatarHash: string | null | undefined,
): Promise<string | null> {
  try {
    const image = await fetchDiscordAvatar(discordId, avatarHash);
    if (!image) return null;

    const revision = randomUUID();
    await pool.query(
      `INSERT INTO user_avatars (user_id, revision, image)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, revision, image],
    );
    return revision;
  } catch (err) {
    console.warn(`[avatars] discord avatar import failed for user ${userId}`, err);
    return null;
  }
}
