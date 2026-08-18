import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AVATAR_MAX_UPLOAD_BYTES, normalizeAvatar } from "../avatars/image.js";
import { pool } from "../db/pool.js";
import { players } from "../players/store.js";
import { getAuthUser, getUserDTO } from "./auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPLOAD_WINDOW_MS = 60 * 60_000;
const UPLOADS_PER_WINDOW = 10;
const uploads = new Map<number, { count: number; startedAt: number }>();

function uploadLimited(userId: number): boolean {
  const now = Date.now();
  const current = uploads.get(userId);
  if (!current || now - current.startedAt >= UPLOAD_WINDOW_MS) {
    uploads.set(userId, { count: 1, startedAt: now });
    return false;
  }
  current.count += 1;
  return current.count > UPLOADS_PER_WINDOW;
}

export function registerAvatarRoutes(app: FastifyInstance): void {
  app.get<{ Params: { userId: string; revision: string } }>(
    "/avatars/:userId/:revision.webp",
    async (req, reply) => {
      const userId = Number(req.params.userId);
      const revision = req.params.revision;
      if (!Number.isSafeInteger(userId) || userId < 1 || !UUID_PATTERN.test(revision)) {
        return reply.code(404).send();
      }
      const { rows } = await pool.query<{ image: Buffer }>(
        `SELECT image FROM user_avatars WHERE user_id = $1 AND revision = $2`,
        [userId, revision],
      );
      const image = rows[0]?.image;
      if (!image) return reply.code(404).send();
      return reply
        .type("image/webp")
        .header("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable")
        .header("ETag", `"avatar-${revision}"`)
        .send(image);
    },
  );

  app.post("/api/auth/avatar", async (req, reply) => {
    const user = await getAuthUser(req);
    if (!user) return reply.code(404).send();
    if (uploadLimited(user.id)) {
      return reply.code(429).send({ error: "too many profile picture changes, try again later" });
    }

    let input: Buffer;
    try {
      const part = await req.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: AVATAR_MAX_UPLOAD_BYTES } });
      if (!part) return reply.code(400).send({ error: "choose an image to upload" });
      if (part.fieldname !== "avatar") {
        part.file.resume();
        return reply.code(400).send({ error: "the image field must be named avatar" });
      }
      input = await part.toBuffer();
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send({ error: "profile picture must be 2 MB or smaller" });
      }
      return reply.code(400).send({ error: "could not read that profile picture" });
    }

    let image: Buffer;
    try {
      image = await normalizeAvatar(input);
    } catch (err) {
      req.log.info({ err }, "profile picture upload rejected");
      const known = err instanceof Error &&
        (err.message === "profile picture must be a JPEG, PNG, or WebP image" ||
          err.message === "animated profile pictures are not supported");
      return reply.code(400).send({
        error: known ? (err as Error).message : "could not process that profile picture",
      });
    }

    const revision = randomUUID();
    await pool.query(
      `INSERT INTO user_avatars (user_id, revision, image)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET revision = EXCLUDED.revision, image = EXCLUDED.image, updated_at = now()`,
      [user.id, revision, image],
    );
    players.setAvatar(user.id, revision);
    return reply.send({ user: await getUserDTO(user.id, user.email, user.displayName) });
  });

  app.delete("/api/auth/avatar", async (req, reply) => {
    const user = await getAuthUser(req);
    if (!user) return reply.code(404).send();
    await pool.query(`DELETE FROM user_avatars WHERE user_id = $1`, [user.id]);
    players.setAvatar(user.id, null);
    return reply.send({ user: await getUserDTO(user.id, user.email, user.displayName) });
  });
}
