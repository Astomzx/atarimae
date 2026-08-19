import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api.js";
import { decideEntry } from "./callRoom.js";
import { chatKeys, type ActiveRoom } from "./keys.js";

/**
 * Going into a call, from wherever the button was.
 *
 * Shared between the conversation and the ringing banner because both promise
 * the same thing. A banner that says 参加する and only navigates somewhere is a
 * button that lies — the person pressed it to be in the call.
 *
 * Two destinations now. The room is either framed in the conversation, when an
 * administrator has said the provider permits it, or opened in its own window
 * as it always was. The branch is here rather than in either component so both
 * behave the same way, and so the awkward part — the window has to be opened
 * before the server has answered — exists in one place.
 */

export interface EnterCallTarget {
  channelId: string;
  /** Omitted to start a new call; present to join the one already running. */
  callId?: string;
}

export function useEnterCall() {
  const queryClient = useQueryClient();

  /**
   * Asked in advance, and deliberately not `await`ed at click time.
   *
   * The window has to be opened during the gesture, so this has to be known
   * before it. Not yet loaded means "no", which opens a window — the behaviour
   * that works everywhere.
   */
  const embedding = useQuery({
    queryKey: chatKeys.callEmbedding(),
    queryFn: api.calls.embedding,
    staleTime: 5 * 60 * 1000,
  });
  const expectedFrame = embedding.data?.embeddable ?? false;

  return useMutation({
    mutationFn: async (target: EnterCallTarget) => {
      /**
       * The window is opened first, empty, and pointed at the room once the
       * server answers — unless the room is going to be framed, in which case
       * opening one at all would flash a window open and shut.
       *
       * A popup blocker only allows a new window during the gesture that asked
       * for one, and the join URL arrives a round trip later — opening it
       * afterwards is silently blocked in every browser.
       *
       * **Not `noopener`.** With that feature set, `window.open` returns null
       * by specification, and there is no handle left to point anywhere — so
       * the fallback below ran every time and took the person's own tab to the
       * meeting room, losing Atarimae. The opener is severed on the next line
       * instead, while the blank window is still same-origin.
       */
      const opened = expectedFrame ? null : window.open("", "_blank");
      if (opened) opened.opener = null;

      try {
        const result = target.callId
          ? await api.calls.join(target.callId)
          : await api.calls.start(target.channelId);

        const room: ActiveRoom = {
          callId: result.call.id,
          channelId: result.call.channelId,
          joinUrl: result.joinUrl,
          embed: result.embed,
        };

        switch (
          decideEntry({ embed: result.embed, opened: opened !== null, expectedFrame })
        ) {
          case "frame":
            // A window can exist here: the provider became embeddable between
            // the page loading and the button being pressed. Nothing is put in
            // it, so it is closed rather than left blank on screen.
            opened?.close();
            queryClient.setQueryData<ActiveRoom>(chatKeys.activeRoom(), room);
            break;

          case "window":
            opened!.location.href = result.joinUrl;
            break;

          /*
           * The other direction of the same race, and the reason this case is
           * not just a fallback: embedding was expected, so no window was
           * opened, and one cannot be opened now. The room becomes something
           * to press in the conversation.
           */
          case "link":
            queryClient.setQueryData<ActiveRoom>(chatKeys.activeRoom(), room);
            break;

          case "navigate":
            window.location.assign(result.joinUrl);
            break;
        }

        return result;
      } catch (error) {
        // Otherwise a failure leaves a blank window sitting there, which reads
        // as the call having started.
        opened?.close();
        throw error;
      }
    },
    onSuccess: async (_result, target) => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.calls(target.channelId) });
    },
  });
}
