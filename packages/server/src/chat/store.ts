import type { ChatMessageDTO } from "@worldcanvas/shared";
import { pool, tx, type Client } from "../db/pool.js";
import { censorChatMessage, CHAT_COOLDOWN_MS, CHAT_MAX_LENGTH, CHAT_PAGE_SIZE } from "./filter.js";

interface MessageRow {
  id: number;
  user_id: number;
  display_name: string;
  avatar_revision: string | null;
  display_body: string;
  created_at: Date;
  deleted_at: Date | null;
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

let avatarsAvailable: boolean | null = null;

/** Chat can land independently of the currently uncommitted avatar feature.
 * Use avatars when that table exists, and cleanly fall back to initials when
 * it does not, so this feature's Git commit remains deployable on its own. */
async function messageSelect(client: Pick<Client, "query"> = pool): Promise<string> {
  if (avatarsAvailable === null) {
    const { rows } = await client.query<{ available: boolean }>(
      `SELECT to_regclass('public.user_avatars') IS NOT NULL AS available`,
    );
    avatarsAvailable = rows[0]?.available ?? false;
  }
  return avatarsAvailable
    ? `SELECT m.id, m.user_id, u.display_name,
              a.revision::text AS avatar_revision,
              m.display_body, m.created_at, m.deleted_at
         FROM chat_messages m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN user_avatars a ON a.user_id = m.user_id`
    : `SELECT m.id, m.user_id, u.display_name,
              NULL::text AS avatar_revision,
              m.display_body, m.created_at, m.deleted_at
         FROM chat_messages m
         JOIN users u ON u.id = m.user_id`;
}

function toDTO(row: MessageRow): ChatMessageDTO {
  return {
    id: row.id,
    userId: row.user_id,
    // Account names predate chat and are not globally profanity-gated. Keep
    // one abusive name from bypassing the chat filter in every message row.
    displayName: censorChatMessage(row.display_name),
    avatarRevision: row.avatar_revision,
    body: row.deleted_at ? null : row.display_body,
    createdAt: row.created_at.toISOString(),
    deleted: row.deleted_at !== null,
  };
}

export function normalizeChatBody(value: unknown): string {
  if (typeof value !== "string") throw new ChatError("message must be text", 400);
  const body = value.trim();
  const length = [...body].length;
  if (length === 0) throw new ChatError("message cannot be empty", 400);
  if (length > CHAT_MAX_LENGTH) {
    throw new ChatError(`message must be ${CHAT_MAX_LENGTH} characters or fewer`, 400);
  }
  return body;
}

export async function listMessages(before?: number): Promise<{ messages: ChatMessageDTO[]; hasMore: boolean }> {
  const select = await messageSelect();
  const params: unknown[] = [CHAT_PAGE_SIZE + 1];
  const beforeClause = before === undefined ? "" : "WHERE m.id < $2";
  if (before !== undefined) params.push(before);
  const { rows } = await pool.query<MessageRow>(
    `SELECT * FROM (
       ${select}
       ${beforeClause}
       ORDER BY m.id DESC LIMIT $1
     ) recent ORDER BY id`,
    params,
  );
  const hasMore = rows.length > CHAT_PAGE_SIZE;
  if (hasMore) rows.shift();
  return { messages: rows.map(toDTO), hasMore };
}

export async function getMessage(id: number, client: Pick<Client, "query"> = pool): Promise<ChatMessageDTO | null> {
  const select = await messageSelect(client);
  const { rows } = await client.query<MessageRow>(`${select} WHERE m.id = $1`, [id]);
  return rows[0] ? toDTO(rows[0]) : null;
}

export async function createMessage(
  user: { id: number; displayName: string },
  value: unknown,
): Promise<ChatMessageDTO> {
  const original = normalizeChatBody(value);
  const display = censorChatMessage(original);

  return tx(async (client) => {
    // Serialises simultaneous sends from multiple tabs for this user. The
    // product choice is a 100ms cooldown; enforcing it in the transaction
    // keeps concurrent requests from both slipping through.
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [user.id]);

    const { rows: mutes } = await client.query<{ until_at: Date | null }>(
      `SELECT until_at FROM chat_mutes
        WHERE user_id = $1 AND revoked_at IS NULL
          AND (until_at IS NULL OR until_at > now())
        ORDER BY id DESC LIMIT 1`,
      [user.id],
    );
    const mute = mutes[0];
    if (mute) {
      const suffix = mute.until_at ? ` until ${mute.until_at.toISOString()}` : " permanently";
      throw new ChatError(`you are muted from chat${suffix}`, 403);
    }

    const { rows: recent } = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM chat_messages WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [user.id],
    );
    const elapsed = recent[0] ? Date.now() - recent[0].created_at.getTime() : CHAT_COOLDOWN_MS;
    if (elapsed < CHAT_COOLDOWN_MS) {
      throw new ChatError("slow down", 429, CHAT_COOLDOWN_MS - elapsed);
    }

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO chat_messages (user_id, original_body, display_body)
       VALUES ($1, $2, $3) RETURNING id`,
      [user.id, original, display],
    );
    const message = await getMessage(rows[0]!.id, client);
    if (!message) throw new Error("inserted chat message disappeared");
    return message;
  });
}
