import type { FastifyInstance } from "fastify";

import { sweepUnclaimedAttachments } from "./attachment-sweep.js";
import { createMailer, loadSmtpSettings } from "./mailer.js";
import { drainOutbox, reclaimStaleLocks } from "./notification-worker.js";
import { queueDueReminders } from "./reminders.js";

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

      const result = await drainOutbox(app.db, mailer, {
        publicOrigin: app.config.PUBLIC_ORIGIN,
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
