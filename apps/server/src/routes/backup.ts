import { errorResponses, UserErrorCode } from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { ApiError } from "../errors.js";
import { AuditAction, writeAuditBestEffort } from "../lib/audit.js";
import { verifyPassword } from "../lib/password.js";
import { requirePersonRole } from "../plugins/auth.js";
import { buildExport } from "../services/backup-export.js";

/**
 * Downloading the whole archive over HTTP.
 *
 * `backup.md` refused this, and the refusal was right about the thing it was
 * worried about: this is one request that carries away every password hash,
 * every message and every attachment. One authorisation mistake, one stolen
 * Owner session, and the organisation is gone in a single call. Shell access
 * to the host was the barrier, and this removes it.
 *
 * It is built because an operator who cannot open a terminal was, in practice,
 * an operator with no backups at all — and "the feature exists but nobody can
 * use it" is the same as not having one. That is a real cost too, and it was
 * the one being paid.
 *
 * So it exists, and it is made as narrow as the threat allows:
 *
 *   - **Owner only.** Not admin. The role that can grant Owner is the role
 *     that can already do anything; no new capability is handed to anyone else.
 *   - **People only.** An API token cannot call this at all. A leaked
 *     integration token must not become the whole database.
 *   - **The password, again, now.** This is the important one. A stolen session
 *     cookie is the realistic attack, and re-authenticating means the cookie
 *     alone is not enough.
 *   - **Audited, including the refusals.** Somebody with an Owner session but
 *     not the password is somebody who took that session.
 *   - **Its own rate limit.** Argon2 on every attempt, and a full dump on
 *     every success.
 *
 * What none of that fixes: an Owner who *is* hostile, or one whose password is
 * also taken. Against those this endpoint is exactly as bad as it looks, which
 * is why `security.md` says so plainly rather than listing the mitigations and
 * calling it safe.
 */

const RefusalReason = {
  WRONG_PASSWORD: "wrong_password",
  NO_PASSWORD: "no_password_set",
} as const;

export const backupRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    "/backup/export",
    {
      /*
       * `requirePersonRole`, so an API token is refused before the handler
       * runs. A token has no password to re-enter, so there is no way to
       * satisfy the check below — refusing early makes that explicit rather
       * than leaving a confusing 401 about credentials a token never had.
       */
      preHandler: requirePersonRole("owner"),
      config: {
        // Argon2 on every attempt, a full pg_dump on every success.
        rateLimit: { max: 5, timeWindow: "1 hour" },
      },
      schema: {
        tags: ["settings"],
        summary: "Download a full backup",
        description:
          "Owner only, and the password must be given again. Returns the same " +
          "archive `pnpm backup` writes: database, attachments and manifest, " +
          "checked for consistency before anything is sent.",
        body: Type.Object({
          password: Type.String({ minLength: 1, maxLength: 512 }),
        }),
        response: {
          200: Type.Unknown(),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;

      const { rows } = await app.db.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [user.id],
      );
      const hash = rows[0]?.password_hash;

      const refuse = async (reason: string): Promise<never> => {
        await writeAuditBestEffort(app.db, request, {
          actorUserId: user.id,
          action: AuditAction.BACKUP_EXPORT_REFUSED,
          outcome: "denied",
          metadata: { reason },
        });
        throw new ApiError(
          401,
          UserErrorCode.INVALID_CREDENTIALS,
          "Password is incorrect.",
        );
      };

      if (!hash) await refuse(RefusalReason.NO_PASSWORD);
      if (!(await verifyPassword(hash!, request.body.password))) {
        await refuse(RefusalReason.WRONG_PASSWORD);
      }

      /*
       * Built in full before a byte is sent. The archive is only worth having
       * if the database and the attachments agree, and that cannot be checked
       * halfway through a stream — a truncated download that looks like a
       * backup is the failure this whole feature was refused over.
       */
      const archive = await buildExport(app);

      await writeAuditBestEffort(app.db, request, {
        actorUserId: user.id,
        action: AuditAction.BACKUP_EXPORTED,
        metadata: {
          bytes: archive.bytes.length,
          attachments: archive.attachmentCount,
        },
      });

      return (
        reply
          .header("content-type", "application/gzip")
          .header("content-length", String(archive.bytes.length))
          .header("content-disposition", `attachment; filename="${archive.filename}"`)
          // Never anywhere but this response.
          .header("cache-control", "no-store")
          .send(Buffer.from(archive.bytes))
      );
    },
  );
};
