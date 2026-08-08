import type { RealtimeEvent } from "@atarimae/api-schema";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { appendMessage, type MessagePages } from "./format.js";
import { chatKeys } from "./keys.js";

/**
 * The socket that makes chat feel live.
 *
 * Best-effort, exactly as the server describes it: the socket is not the source
 * of truth. Anything missed while disconnected is picked up by refetching on
 * reconnect, which is why nothing here replays a backlog — and why a failure to
 * connect at all degrades to an ordinary, polling-free app rather than to a
 * broken one.
 */

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** The server closes with this when the session cookie is gone or invalid. */
const UNAUTHENTICATED = 4401;

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/realtime`;
}

export function useRealtime(): void {
  const queryClient = useQueryClient();

  // Kept in a ref so the effect below runs once per mount: re-running it on
  // every render would open and close a socket per keystroke.
  const closedByUs = useRef(false);

  useEffect(() => {
    closedByUs.current = false;

    let socket: WebSocket | null = null;
    let retryDelay = FIRST_RETRY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      socket = new WebSocket(socketUrl());

      socket.addEventListener("open", () => {
        retryDelay = FIRST_RETRY_MS;

        // Whatever happened while the socket was down is unknown, so the
        // question is asked again rather than assumed unchanged.
        void queryClient.invalidateQueries({ queryKey: chatKeys.all });
      });

      socket.addEventListener("message", (event) => {
        let parsed: RealtimeEvent;
        try {
          parsed = JSON.parse(String(event.data)) as RealtimeEvent;
        } catch {
          // A frame we cannot read is not worth breaking the connection over.
          return;
        }

        handle(parsed);
      });

      socket.addEventListener("close", (event) => {
        if (closedByUs.current) return;

        /**
         * An unauthenticated socket will be refused again immediately, and
         * again after that. Reconnecting in a loop would hammer the server for
         * as long as the tab is open; the session query will notice and send
         * this person to the login screen.
         */
        if (event.code === UNAUTHENTICATED) return;

        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      });

      // `close` fires after `error`, so the retry is scheduled there only.
      socket.addEventListener("error", () => undefined);
    };

    const handle = (event: RealtimeEvent) => {
      if (event.type === "ping") return;

      if (event.type === "message.created") {
        /**
         * Merged into the loaded pages rather than refetched: an infinite query
         * refetches every page it holds, so invalidating on each arrival turns
         * a busy channel into a full reload of its history per message.
         *
         * A channel that is not open has no cache to merge into, and picks the
         * message up when it is next opened.
         */
        queryClient.setQueryData<MessagePages>(
          chatKeys.messages(event.channelId),
          (data) => appendMessage(data, event.message),
        );

        // Unread counts, previews and ordering all live in the channel list.
        void queryClient.invalidateQueries({ queryKey: chatKeys.channels() });
        return;
      }

      if (event.type === "channel.read") {
        void queryClient.invalidateQueries({ queryKey: chatKeys.channels() });
      }
    };

    connect();

    return () => {
      closedByUs.current = true;
      clearTimeout(retryTimer);
      socket?.close(1000, "leaving");
    };
  }, [queryClient]);
}
