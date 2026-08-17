import type { FastifyInstance } from "fastify";

import { sweepUnclaimedAttachments } from "./attachment-sweep.js";
import { endAbandonedCalls } from "./call-sweep.js";
import { createMailer, loadSmtpSettings } from "./mailer.js";
import { drainOutbox, reclaimStaleLocks } from "./notification-worker.js";
import { createPushSender, loadVapidKeys, type PushSender } from "./push.js";
import { queueDueReminders } from "./reminders.js";
import { deliverPendingWebhooks, reclaimStaleWebhookLocks } from "./webhooks.js";

/**
 * Background delivery.
 *
 * v1.0 runs a single server instance, so this lives in-process rather than
 * needing a separate worker deployment. The outbox claim uses SKIP LOCKED, so
 * running several instances later requires no change here.
 */

const DRAIN_INTERVAL_MS = 30_000;
const RECLAIM_INTERVAL_MS = 300_000;

export function startNotificationWorker(app: FastifyInstance): () => void {
  let running = false;
  let stopped = false;

  /*
   * Loaded once and kept, because the keypair is stable and reading it costs a
   * decrypt. Not loaded at startup, though: the first tick may be the first
   * time the database is reachable, and a worker that gave up on push because
   * PostgreSQL was slow to accept connections would stay without push until
   * somebody restarted it.
   */
  let push: PushSender | undefined;

  const pushSender = async (): Promise<PushSender | undefined> => {
    if (push) return push;
    try {
      const keys = await loadVapidKeys(app.db, app.secrets, app.config.PUBLIC_ORIGIN);
      push = createPushSender(keys);
      return push;
    } catch (error) {
      // Email must still go out. Push being unavailable is a degraded service,
      // not a reason to stop draining the queue.
      app.log.error({ err: error }, "could not load VAPID keys; push is disabled");
      return undefined;
    }
  };

  const tick = async () => {
    // Skip rather than queue: a slow SMTP server must not build a backlog of
    // overlapping drains.
    if (running || stopped) return;
    running = true;

    try {
      // Queue before draining, so a reminder that becomes due is sent in the
      // same pass rather than waiting for the next one.
      const reminders = await queueDueReminders(app.db);
      if (reminders > 0) {
        app.log.info({ reminders }, "queued deadline reminders");
      }

      const settings = await loadSmtpSettings(app.db);
      const mailer = createMailer(settings, app.secrets);

      const sender = await pushSender();

      const result = await drainOutbox(app.db, mailer, {
        publicOrigin: app.config.PUBLIC_ORIGIN,
        ...(sender ? { push: sender } : {}),
      });

      if (result.claimed > 0) {
        app.log.info({ ...result }, "notification outbox drained");
      }

      // A queue that stops draining is the one failure the outbox cannot fix
      // by itself, so it is logged loudly rather than left to be noticed.
      if (result.failed > 0 && !settings) {
        app.log.warn(
          { failed: result.failed },
          "notifications are queued but SMTP is not configured",
        );
      }

      // Same pass, same reasoning: a webhook queued in a committed transaction
      // describes something that definitely happened, so it is retried until
      // it lands rather than dropped when an endpoint is briefly down.
      const webhooks = await deliverPendingWebhooks(app.db, app.secrets);
      if (webhooks.claimed > 0) {
        app.log.info({ ...webhooks }, "webhook deliveries attempted");
      }
    } catch (error) {
      app.log.error({ err: error }, "notification worker tick failed");
    } finally {
      running = false;
    }
  };

  const reclaim = async () => {
    if (stopped) return;
    try {
      const released = await reclaimStaleLocks(app.db);
      if (released > 0) {
        app.log.warn({ released }, "released outbox rows locked by a dead worker");
      }
    } catch (error) {
      app.log.error({ err: error }, "failed to reclaim stale outbox locks");
    }

    // Files picked and then thought better of. Left alone they accumulate for
    // the life of the deployment, which is the sort of leak that is discovered
    // when a disk fills up.
    try {
      const swept = await sweepUnclaimedAttachments(app.db, app.attachments);
      if (swept.removed > 0 || swept.failed > 0) {
        app.log.info({ ...swept }, "swept unclaimed attachments");
      }
    } catch (error) {
      app.log.error({ err: error }, "failed to sweep unclaimed attachments");
    }

    // A closed laptop is not somebody leaving a call. Without this the channel
    // shows 通話中 forever and can never start another.
    try {
      const ended = await endAbandonedCalls(app.db);
      if (ended > 0) app.log.info({ ended }, "ended abandoned calls");
    } catch (error) {
      app.log.error({ err: error }, "failed to end abandoned calls");
    }

    // A worker that died mid-delivery leaves rows locked forever, and the
    // queue stops moving with nothing in it marked as failed.
    try {
      const released = await reclaimStaleWebhookLocks(app.db);
      if (released > 0) {
        app.log.warn({ released }, "released webhook deliveries locked by a dead worker");
      }
    } catch (error) {
      app.log.error({ err: error }, "failed to reclaim stale webhook locks");
    }
  };

  const drainTimer = setInterval(() => void tick(), DRAIN_INTERVAL_MS);
  const reclaimTimer = setInterval(() => void reclaim(), RECLAIM_INTERVAL_MS);

  // Do not hold the process open on shutdown.
  drainTimer.unref();
  reclaimTimer.unref();

  // One pass at startup, so a restart delivers anything queued while down.
  void tick();

  return () => {
    stopped = true;
    clearInterval(drainTimer);
    clearInterval(reclaimTimer);
  };
}
