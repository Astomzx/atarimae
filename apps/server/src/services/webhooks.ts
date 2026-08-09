import { randomUUID } from "node:crypto";

import type { WebhookEvent } from "@atarimae/api-schema";
import type { SecretStore } from "@atarimae/secret-store";

import type { Database, DatabaseClient } from "../db.js";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  signatureHeader,
  SIGNATURE_HEADER,
} from "../lib/webhook-signature.js";

/**
 * Outbound webhooks.
 *
 * A transactional outbox, exactly like notifications and for the same reason:
 * `enqueue` writes its rows inside the transaction that performs the change,
 * so by the time the worker sees one, the thing it describes definitely
 * happened. The worker's job is to make delivery eventually happen too, never
 * to decide whether it should.
 *
 * Failure is therefore retry, not discard. An endpoint being down delays a
 * delivery; it must not lose it.
 */

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** Attempt 1 waits a minute, attempt 6 and beyond an hour. */
function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 3600);
}

/**
 * Beyond this a delivery stops being retried.
 *
 * Ten attempts with this backoff is roughly six hours. An endpoint that has
 * been unreachable that long is not coming back inside the window where this
 * event still means anything, and retrying forever would let one broken
 * receiver fill the table.
 */
const MAX_ATTEMPTS = 10;

/** After this many consecutive failures the endpoint itself is switched off. */
const FAILURES_BEFORE_DISABLE = 20;

/**
 * A slow endpoint must not hold a worker pass open. Ten seconds is generous
 * for something that should be acknowledging and queueing.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface EnqueueOptions {
  /** Present for tests, which need to observe rows without a worker running. */
  availableAt?: string;
}

/**
 * Queues one event for every webhook subscribed to it.
 *
 * Called inside the caller's transaction. A webhook row per subscriber rather
 * than one shared row: otherwise a single slow endpoint delays the others, and
 * one permanent failure abandons the delivery for all of them.
 */
export async function enqueueWebhookEvent(
  client: DatabaseClient,
  event: WebhookEvent,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<number> {
  const body = {
    event,
    // The receiver dedupes on this: retries reuse the delivery row, so the id
    // is stable across every attempt of the same event.
    occurredAt: new Date().toISOString(),
    data: payload,
  };

  const { rowCount } = await client.query(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload, available_at)
     SELECT w.id, $1, $2::jsonb, COALESCE($3::timestamptz, now())
       FROM webhooks w
      WHERE w.disabled_at IS NULL
        AND $1 = ANY(w.events)`,
    [event, JSON.stringify(body), options.availableAt ?? null],
  );

  return rowCount ?? 0;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload: unknown;
  attempt_count: number;
  url: string;
  secret_encrypted: string;
}

export interface DeliverResult {
  claimed: number;
  delivered: number;
  failed: number;
}

async function claim(db: Database, batchSize: number): Promise<DeliveryRow[]> {
  const { rows } = await db.query<DeliveryRow>(
    `UPDATE webhook_deliveries d
        SET locked_at = now(), locked_by = $1, attempt_count = d.attempt_count + 1
       FROM webhooks w
      WHERE w.id = d.webhook_id
        AND d.id IN (
          SELECT id FROM webhook_deliveries
           WHERE delivered_at IS NULL
             AND locked_at IS NULL
             AND available_at <= now()
             AND attempt_count < $3
           ORDER BY available_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
      RETURNING d.id, d.webhook_id, d.event, d.payload, d.attempt_count,
                w.url, w.secret_encrypted`,
    [WORKER_ID, batchSize, MAX_ATTEMPTS],
  );

  return rows;
}

/**
 * Sends one delivery.
 *
 * Any 2xx is success. Everything else — including a 3xx, because a webhook
 * receiver that redirects is a receiver that has not been configured — is a
 * failure and will be retried.
 */
async function send(
  row: DeliveryRow,
  secret: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number }> {
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signatureHeader(secret, timestamp, body),
        [EVENT_HEADER]: row.event,
        [DELIVERY_HEADER]: row.id,
        "user-agent": "Atarimae-Webhook/1.0",
      },
      body,
      signal: controller.signal,
      // A receiver that redirects has not been configured; following one would
      // also send the signature somewhere the administrator never named.
      redirect: "manual",
    });

    return { status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export interface DeliverOptions {
  batchSize?: number;
  /** Injected by tests. Nothing in production passes this. */
  fetchImpl?: typeof fetch;
}

export async function deliverPendingWebhooks(
  db: Database,
  secrets: SecretStore,
  options: DeliverOptions = {},
): Promise<DeliverResult> {
  const rows = await claim(db, options.batchSize ?? 20);
  const fetchImpl = options.fetchImpl ?? fetch;

  let delivered = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const secret = await secrets.decrypt(row.secret_encrypted);
      const { status } = await send(row, secret, fetchImpl);

      if (status >= 200 && status < 300) {
        await markDelivered(db, row, status);
        delivered += 1;
      } else {
        await markFailed(db, row, status, `Endpoint returned ${status}`);
        failed += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markFailed(db, row, null, message);
      failed += 1;
    }
  }

  return { claimed: rows.length, delivered, failed };
}

async function markDelivered(
  db: Database,
  row: DeliveryRow,
  status: number,
): Promise<void> {
  await db.query(
    `UPDATE webhook_deliveries
        SET delivered_at = now(), locked_at = NULL, locked_by = NULL,
            last_status = $2, last_error = NULL
      WHERE id = $1`,
    [row.id, status],
  );

  // The failure counter resets on any success, so an endpoint that is merely
  // flaky is never switched off — only one that is consistently gone.
  await db.query(
    `UPDATE webhooks
        SET consecutive_failures = 0, last_success_at = now(), last_error = NULL
      WHERE id = $1`,
    [row.webhook_id],
  );
}

async function markFailed(
  db: Database,
  row: DeliveryRow,
  status: number | null,
  message: string,
): Promise<void> {
  await db.query(
    `UPDATE webhook_deliveries
        SET locked_at = NULL, locked_by = NULL,
            available_at = now() + make_interval(secs => $2),
            last_status = $3, last_error = $4
      WHERE id = $1`,
    [row.id, backoffSeconds(row.attempt_count), status, message.slice(0, 500)],
  );

  /**
   * An endpoint that has failed this many times in a row is switched off.
   *
   * Not silently: `disabled_at` and `last_error` are both on the webhook, and
   * the interface shows them. The alternative is a queue that grows forever
   * against a receiver that was decommissioned months ago.
   */
  await db.query(
    `UPDATE webhooks
        SET consecutive_failures = consecutive_failures + 1,
            last_failure_at = now(),
            last_error = $2,
            disabled_at = CASE
              WHEN consecutive_failures + 1 >= $3 THEN now()
              ELSE disabled_at
            END
      WHERE id = $1`,
    [row.webhook_id, message.slice(0, 500), FAILURES_BEFORE_DISABLE],
  );
}

/**
 * Releases deliveries locked by a worker that died mid-flight.
 *
 * Without this a crash strands rows as locked forever, and the queue quietly
 * stops moving with nothing in it marked as failed.
 */
export async function reclaimStaleWebhookLocks(db: Database): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE webhook_deliveries
        SET locked_at = NULL, locked_by = NULL
      WHERE delivered_at IS NULL
        AND locked_at IS NOT NULL
        AND locked_at < now() - interval '5 minutes'`,
  );

  return rowCount ?? 0;
}
