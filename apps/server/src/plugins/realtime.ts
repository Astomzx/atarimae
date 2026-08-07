import type { RealtimeEvent } from "@atarimae/api-schema";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

import { hashSessionToken, SESSION_COOKIE } from "../lib/session.js";

/**
 * Realtime delivery.
 *
 * **Best-effort by design.** The socket makes the interface feel live; it is
 * never the source of truth. A client that misses an event still sees the
 * message on its next fetch, which is why reconnecting reloads rather than
 * replaying a backlog — and why nothing here needs persistence.
 *
 * Connections are held in memory, keyed by user. v1.0 is a single instance;
 * scaling out would mean a shared bus here, and nothing else would change.
 */

interface Connection {
  userId: string;
  send: (event: RealtimeEvent) => void;
  close: () => void;
}

export interface RealtimeHub {
  /** Delivers to every open connection of every current channel member. */
  publishToChannel(channelId: string, event: RealtimeEvent): Promise<void>;
  /** Drops every connection belonging to a user, e.g. when disabled. */
  disconnectUser(userId: string): void;
  connectionCount(): number;
}

declare module "fastify" {
  interface FastifyInstance {
    realtime: RealtimeHub;
  }
}

const HEARTBEAT_MS = 30_000;

export async function registerRealtime(app: FastifyInstance): Promise<void> {
  const byUser = new Map<string, Set<Connection>>();

  const add = (connection: Connection) => {
    const existing = byUser.get(connection.userId);
    if (existing) existing.add(connection);
    else byUser.set(connection.userId, new Set([connection]));
  };

  const remove = (connection: Connection) => {
    const set = byUser.get(connection.userId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) byUser.delete(connection.userId);
  };

  const hub: RealtimeHub = {
    async publishToChannel(channelId, event) {
      // Membership is re-read per publish rather than cached: somebody removed
      // from a private channel must stop receiving it immediately, not when a
      // cache happens to expire.
      const { rows } = await app.db.query<{ user_id: string }>(
        `SELECT user_id FROM channel_members
          WHERE channel_id = $1 AND left_at IS NULL`,
        [channelId],
      );

      for (const row of rows) {
        for (const connection of byUser.get(row.user_id) ?? []) {
          connection.send(event);
        }
      }
    },

    disconnectUser(userId) {
      for (const connection of byUser.get(userId) ?? []) connection.close();
      byUser.delete(userId);
    },

    connectionCount() {
      let total = 0;
      for (const set of byUser.values()) total += set.size;
      return total;
    },
  };

  app.decorate("realtime", hub);

  await app.register(websocket, {
    options: { maxPayload: 1_048_576 },
  });

  await app.register(async (scope) => {
    scope.get("/realtime", { websocket: true }, (socket, request) => {
      /**
       * Authenticated from the session cookie, resolved at connect time.
       *
       * The `onRequest` hook does not populate `request.user` for an upgrade,
       * so this repeats the lookup. Rejecting an unauthenticated socket is not
       * optional: an open socket would leak every message in every channel.
       */
      void (async () => {
        const raw = request.cookies[SESSION_COOKIE];
        if (!raw) {
          socket.close(4401, "unauthenticated");
          return;
        }

        const { rows } = await app.db.query<{ user_id: string }>(
          `SELECT s.user_id
             FROM sessions s
             JOIN users u ON u.id = s.user_id
            WHERE s.session_token_hash = $1
              AND s.revoked_at IS NULL
              AND s.expires_at > now()
              AND u.disabled_at IS NULL`,
          [hashSessionToken(raw)],
        );

        const userId = rows[0]?.user_id;
        if (!userId) {
          socket.close(4401, "unauthenticated");
          return;
        }

        const connection: Connection = {
          userId,
          send(event) {
            // readyState 1 is OPEN. Sending to a closing socket throws.
            if (socket.readyState !== 1) return;
            try {
              socket.send(JSON.stringify(event));
            } catch (error) {
              request.log.warn({ err: error }, "realtime send failed");
            }
          },
          close() {
            try {
              socket.close(1000, "server closed");
            } catch {
              // Already gone.
            }
          },
        };

        add(connection);

        // Keeps intermediaries from dropping an idle connection, and gives the
        // client something to notice when the server has gone away.
        const heartbeat = setInterval(() => {
          connection.send({ type: "ping" });
        }, HEARTBEAT_MS);
        heartbeat.unref();

        socket.on("close", () => {
          clearInterval(heartbeat);
          remove(connection);
        });

        socket.on("error", () => {
          clearInterval(heartbeat);
          remove(connection);
        });

        // The client sends nothing meaningful; everything it does goes through
        // the REST API. Ignoring inbound frames keeps the socket one-way and
        // removes a whole class of authorization mistakes.
        socket.on("message", () => undefined);
      })();
    });
  });
}
