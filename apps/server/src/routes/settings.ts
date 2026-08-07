import {
  errorResponses,
  NotificationQueueStatus,
  SettingsErrorCode,
  SmtpSettingsResponse,
  SmtpTestResponse,
  UpdateSmtpSettingsRequest,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import { ApiError } from "../errors.js";
import { AuditAction, writeAudit } from "../lib/audit.js";
import { withTransaction } from "../db.js";
import {
  createMailer,
  loadSmtpSettings,
  SMTP_SETTINGS_KEY,
  verifySmtp,
  type SmtpSettings,
} from "../services/mailer.js";
import { requireRole } from "../plugins/auth.js";

export const settingsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/settings/smtp",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["settings"],
        summary: "Current SMTP configuration",
        description:
          "The password is never returned — only whether one is stored. There " +
          "is no endpoint that reveals it.",
        response: { 200: SmtpSettingsResponse, ...errorResponses },
      },
    },
    async () => {
      const { rows } = await app.db.query<{ value: SmtpSettings; updated_at: string }>(
        "SELECT value, updated_at FROM system_settings WHERE key = $1",
        [SMTP_SETTINGS_KEY],
      );

      const row = rows[0];
      if (!row) {
        return {
          configured: false,
          host: null,
          port: null,
          secure: false,
          username: null,
          hasPassword: false,
          fromAddress: null,
          fromName: null,
          updatedAt: null,
        };
      }

      return {
        configured: true,
        host: row.value.host,
        port: row.value.port,
        secure: row.value.secure,
        username: row.value.username,
        hasPassword: row.value.passwordCiphertext !== null,
        fromAddress: row.value.fromAddress,
        fromName: row.value.fromName,
        updatedAt: row.updated_at,
      };
    },
  );

  app.put(
    "/settings/smtp",
    {
      preHandler: requireRole("owner"),
      schema: {
        tags: ["settings"],
        summary: "Configure SMTP",
        description:
          "Owner only: this credential lets the deployment send mail as the " +
          "organisation. Omitting `password` keeps the stored one; sending " +
          "null clears it.",
        body: UpdateSmtpSettingsRequest,
        response: { 200: SmtpSettingsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { host, port, secure, username, password, fromAddress, fromName } =
        request.body;

      const stored = await withTransaction(app.db, async (client) => {
        const { rows: existing } = await client.query<{ value: SmtpSettings }>(
          "SELECT value FROM system_settings WHERE key = $1 FOR UPDATE",
          [SMTP_SETTINGS_KEY],
        );

        // Encrypted, not hashed: this password has to be replayed to the SMTP
        // server, so it cannot be a one-way digest.
        let ciphertext: string | null = existing[0]?.value.passwordCiphertext ?? null;
        if (password !== undefined) {
          ciphertext = password === null ? null : await app.secrets.encrypt(password);
        }

        const value: SmtpSettings = {
          host,
          port,
          secure,
          username: username ?? null,
          passwordCiphertext: ciphertext,
          fromAddress,
          fromName,
        };

        await client.query(
          `INSERT INTO system_settings (key, value, updated_by)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()`,
          [SMTP_SETTINGS_KEY, JSON.stringify(value), actor.id],
        );

        await writeAudit(client, request, {
          action: AuditAction.SMTP_CONFIGURED,
          actorUserId: actor.id,
          resourceType: "system_settings",
          // Host and sender are recorded; the credential never is.
          metadata: {
            host,
            port,
            secure,
            fromAddress,
            passwordChanged: password !== undefined,
          },
        });

        return value;
      });

      return {
        configured: true,
        host: stored.host,
        port: stored.port,
        secure: stored.secure,
        username: stored.username,
        hasPassword: stored.passwordCiphertext !== null,
        fromAddress: stored.fromAddress,
        fromName: stored.fromName,
        updatedAt: new Date().toISOString(),
      };
    },
  );

  app.post(
    "/settings/smtp/test",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["settings"],
        summary: "Verify the SMTP connection",
        description:
          "Connects and authenticates without sending anything. Returns the " +
          "raw SMTP error on failure, because a useful diagnostic matters more " +
          "here than a tidy message.",
        response: { 200: SmtpTestResponse, ...errorResponses },
      },
    },
    async () => {
      const settings = await loadSmtpSettings(app.db);
      if (!settings) {
        throw new ApiError(
          422,
          SettingsErrorCode.SMTP_NOT_CONFIGURED,
          "SMTP has not been configured yet.",
        );
      }

      try {
        await verifySmtp(settings, app.secrets);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  /**
   * Operational visibility. A queue that has quietly stopped draining is the
   * one failure mode the outbox cannot fix by itself, so it must be visible
   * rather than requiring somebody to think of checking.
   */
  app.get(
    "/settings/notification-queue",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["settings"],
        summary: "Notification queue status",
        response: { 200: NotificationQueueStatus, ...errorResponses },
      },
    },
    async () => {
      const { rows } = await app.db.query<{
        pending: string;
        failed: string;
        abandoned: string;
        oldest_pending_at: string | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE processed_at IS NULL AND attempt_count < 10) AS pending,
           count(*) FILTER (WHERE processed_at IS NULL AND attempt_count > 0
                              AND attempt_count < 10) AS failed,
           count(*) FILTER (WHERE processed_at IS NULL AND attempt_count >= 10) AS abandoned,
           min(created_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending_at
         FROM notification_outbox`,
      );

      const row = rows[0]!;
      return {
        pending: Number(row.pending),
        failed: Number(row.failed),
        abandoned: Number(row.abandoned),
        oldestPendingAt: row.oldest_pending_at,
      };
    },
  );

  /** Exposed so an administrator can push the queue without waiting. */
  app.post(
    "/settings/notification-queue/drain",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["settings"],
        summary: "Process the notification queue now",
        response: { 200: NotificationQueueStatus, ...errorResponses },
      },
    },
    async () => {
      const settings = await loadSmtpSettings(app.db);
      const mailer = createMailer(settings, app.secrets);
      const { drainOutbox } = await import("../services/notification-worker.js");

      await drainOutbox(app.db, mailer, {
        publicOrigin: app.config.PUBLIC_ORIGIN,
      });

      const { rows } = await app.db.query<{
        pending: string;
        failed: string;
        abandoned: string;
        oldest_pending_at: string | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE processed_at IS NULL AND attempt_count < 10) AS pending,
           count(*) FILTER (WHERE processed_at IS NULL AND attempt_count > 0
                              AND attempt_count < 10) AS failed,
           count(*) FILTER (WHERE processed_at IS NULL AND attempt_count >= 10) AS abandoned,
           min(created_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending_at
         FROM notification_outbox`,
      );

      const row = rows[0]!;
      return {
        pending: Number(row.pending),
        failed: Number(row.failed),
        abandoned: Number(row.abandoned),
        oldestPendingAt: row.oldest_pending_at,
      };
    },
  );
};
