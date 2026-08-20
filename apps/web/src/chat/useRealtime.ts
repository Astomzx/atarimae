import type { RealtimeEvent } from "@atarimae/api-schema";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { appendMessage, type MessagePages } from "./format.js";
import { chatKeys, type IncomingCall } from "./keys.js";
import { connectRealtime } from "./realtime-socket.js";

/**
 * The socket that makes chat feel live.
 *
 * Best-effort, exactly as the server describes it: the socket is not the source
 * of truth. Anything missed while disconnected is picked up by refetching on
 * reconnect, which is why nothing here replays a backlog — and why a failure to
 * connect at all degrades to an ordinary, polling-free app rather than to a
 * broken one.
 *
 * The connection's lifetime lives in `realtime-socket.ts`, deliberately outside
 * React: keeping "did we close this on purpose?" in a `useRef` meant it was
 * shared between two runs of the effect, and StrictMode leaked a socket per
 * mount because of it.
 */

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/realtime`;
}

export function useRealtime(myUserId: string | null): void {
  const queryClient = useQueryClient();

  // In a ref so the socket, which is opened once, does not capture a stale
  // identity inside its event handlers.
  const currentUserId = useRef(myUserId);
  currentUserId.current = myUserId;

  useEffect(() => {
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
        return;
      }

      if (event.type === "call.started") {
        void queryClient.invalidateQueries({
          queryKey: chatKeys.calls(event.channelId),
        });

        /**
         * The ring. Somebody is waiting for an answer right now, so this is
         * set wherever in the app the reader happens to be — a call you only
         * find out about by opening the right conversation is not a call.
         *
         * Your own call does not ring at you: the person who pressed the
         * button already knows.
         */
        if (event.startedBy !== currentUserId.current) {
          queryClient.setQueryData<IncomingCall>(chatKeys.incomingCall(), {
            callId: event.callId,
            channelId: event.channelId,
            startedBy: event.startedBy,
            startedByName: event.startedByName,
          });
        }
        return;
      }

      if (event.type === "call.ended") {
        void queryClient.invalidateQueries({
          queryKey: chatKeys.calls(event.channelId),
        });

        // Stop ringing for a call that is already over.
        queryClient.setQueryData<IncomingCall | null>(
          chatKeys.incomingCall(),
          (current) => (current?.callId === event.callId ? null : (current ?? null)),
        );
      }
    };

    const connection = connectRealtime({
      url: socketUrl(),
      onOpen: () => {
        // Whatever happened while the socket was down is unknown, so the
        // question is asked again rather than assumed unchanged.
        void queryClient.invalidateQueries({ queryKey: chatKeys.all });
      },
      onEvent: handle,
    });

    return () => {
      connection.close();
    };
  }, [queryClient]);
}
