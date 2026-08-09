import {
  CreateWebhookRequest,
  CreateWebhookResponse,
  errorResponses,
  ListWebhookDeliveriesResponse,
  ListWebhooksResponse,
  Uuid,
  Webhook,
  WebhookErrorCode,
  type WebhookEvent,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";

import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { AuditAction, writeAudit } from "../lib/audit.js";
import { checkOutboundUrl, type UrlRejection } from "../lib/outbound-url.js";
import { generateWebhookSecret } from "../lib/webhook-signature.js";
import { requirePersonRole } from "../plugins/auth.js";

/**
 * Managing outbound webhooks.
 *
 * Person-only, like service accounts: a webhook is somewhere data leaves the
 * organisation, so pointing one at a new address is a decision somebody makes
 * rather than work an integration does.
 */

interface WebhookRow {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEvent[];
  disabled_at: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  created_at: string;
}

function toWebhook(row: WebhookRow) {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    disabledAt: row.disabled_at,
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

const SELECT_WEBHOOK = `
  SELECT id, url, description, events, disabled_at, consecutive_failures,
         last_success_at, last_failure_at, last_error, created_at
    FROM webhooks
`;

/** Each rejection says which rule was hit, so the message can be specific. */
function urlRejection(reason: UrlRejection): [number, string, string] {
  switch (reason) {
    case "NOT_A_URL":
    case "SCHEME_NOT_ALLOWED":
      return [
        422,
        WebhookErrorCode.WEBHOOK_URL_INVALID,
        "The URL must be an http or https address.",
      ];
    case "CREDENTIALS_IN_URL":
      return [
        422,
        WebhookErrorCode.WEBHOOK_URL_HAS_CREDENTIALS,
        "The URL must not contain a username or password.",
      ];
    case "PRIVATE_ADDRESS":
      return [
        422,
        WebhookErrorCode.WEBHOOK_URL_NOT_REACHABLE,
        "The URL points at a private or loopback address.",
      ];
  }
}

export const webhookRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/webhooks",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["webhooks"],
        summary: "Configured webhooks",
        response: { 200: ListWebhooksResponse, ...errorResponses },
      },
    },
    async () => {
      const { rows } = await app.db.query<WebhookRow>(
        `${SELECT_WEBHOOK} ORDER BY created_at DESC`,
      );
      return { items: rows.map(toWebhook) };
    },
  );

  app.post(
    "/webhooks",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["webhooks"],
        summary: "Register a webhook",
        description:
          "The signing secret is in the response and nowhere else. Verify " +
          "X-Atarimae-Signature with it: `t=<unix>,v1=<hex>`, where the hex " +
          "is HMAC-SHA256 of `<t>.<body>`. Reject anything older than five " +
          "minutes — the timestamp is signed so a captured request cannot be " +
          "replayed.",
        body: CreateWebhookRequest,
        response: { 201: CreateWebhookResponse, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { url, events, description } = request.body;

      /**
       * Checked before anything is stored. A webhook URL is input the server
       * will then fetch on its own network — unchecked, it is a request forger
       * aimed at whatever that network can reach.
       */
      const checked = checkOutboundUrl(url);
      if (!checked.ok) {
        const [status, code, message] = urlRejection(checked.reason);
        throw new ApiError(status, code, message);
      }

      const secret = generateWebhookSecret();
      const encrypted = await app.secrets.encrypt(secret);

      const webhook = await withTransaction(app.db, async (client) => {
        const { rows } = await client.query<WebhookRow>(
          `INSERT INTO webhooks (url, description, secret_encrypted, events, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, url, description, events, disabled_at,
                     consecutive_failures, last_success_at, last_failure_at,
                     last_error, created_at`,
          [checked.url, description ?? null, encrypted, events, actor.id],
        );
        const row = rows[0]!;

        // The URL and the events, never the secret.
        await writeAudit(client, request, {
          action: AuditAction.WEBHOOK_CREATED,
          actorUserId: actor.id,
          resourceType: "webhook",
          resourceId: row.id,
          metadata: { url: checked.url, events },
        });

        return toWebhook(row);
      });

      return reply.status(201).send({ webhook, secret });
    },
  );

  app.post(
    "/webhooks/:webhookId/disable",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["webhooks"],
        summary: "Disable a webhook",
        params: Type.Object({ webhookId: Uuid }),
        response: { 200: Webhook, ...errorResponses },
      },
    },
    async (request) => setEnabled(request, request.params.webhookId, false),
  );

  app.post(
    "/webhooks/:webhookId/restore",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["webhooks"],
        summary: "Re-enable a webhook",
        description:
          "Also clears the failure counter, so an endpoint switched off " +
          "automatically gets a full allowance of attempts again.",
        params: Type.Object({ webhookId: Uuid }),
        response: { 200: Webhook, ...errorResponses },
      },
    },
    async (request) => setEnabled(request, request.params.webhookId, true),
  );

  // Takes the id rather than reading it off the request: the TypeBox provider
  // types each route's params individually, and a shared helper cannot name
  // one of those types without repeating the schema.
  async function setEnabled(request: FastifyRequest, webhookId: string, enable: boolean) {
    const actor = request.user!;

    return withTransaction(app.db, async (client) => {
      const { rows } = await client.query<WebhookRow>(
        `UPDATE webhooks
            SET disabled_at = ${enable ? "NULL" : "now()"}
                ${enable ? ", consecutive_failures = 0, last_error = NULL" : ""}
          WHERE id = $1
          RETURNING id, url, description, events, disabled_at,
                    consecutive_failures, last_success_at, last_failure_at,
                    last_error, created_at`,
        [webhookId],
      );

      const row = rows[0];
      if (!row) throw ApiError.notFound("Webhook not found.");

      await writeAudit(client, request, {
        action: enable ? AuditAction.WEBHOOK_RESTORED : AuditAction.WEBHOOK_DISABLED,
        actorUserId: actor.id,
        resourceType: "webhook",
        resourceId: webhookId,
      });

      return toWebhook(row);
    });
  }

  /**
   * What actually happened, per delivery.
   *
   * Without this the answer to "did it arrive" is a log file on the server,
   * which is exactly the position this product objects to being put in.
   */
  app.get(
    "/webhooks/:webhookId/deliveries",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["webhooks"],
        summary: "Recent delivery attempts",
        params: Type.Object({ webhookId: Uuid }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
        }),
        response: { 200: ListWebhookDeliveriesResponse, ...errorResponses },
      },
    },
    async (request) => {
      const { webhookId } = request.params;
      const limit = request.query.limit ?? 20;

      const { rows } = await app.db.query<{
        id: string;
        event: WebhookEvent;
        attempt_count: number;
        last_status: number | null;
        last_error: string | null;
        delivered_at: string | null;
        available_at: string;
        created_at: string;
      }>(
        `SELECT id, event, attempt_count, last_status, last_error,
                delivered_at, available_at, created_at
           FROM webhook_deliveries
          WHERE webhook_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [webhookId, limit],
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          event: row.event,
          attemptCount: row.attempt_count,
          lastStatus: row.last_status,
          lastError: row.last_error,
          deliveredAt: row.delivered_at,
          availableAt: row.available_at,
          createdAt: row.created_at,
        })),
      };
    },
  );
};
