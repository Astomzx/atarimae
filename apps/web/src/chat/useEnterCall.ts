import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../api.js";
import { chatKeys } from "./keys.js";

/**
 * Going into a call, from wherever the button was.
 *
 * Shared between the conversation and the ringing banner because both promise
 * the same thing. A banner that says 参加する and only navigates somewhere is a
 * button that lies — the person pressed it to be in the call.
 */

export interface EnterCallTarget {
  channelId: string;
  /** Omitted to start a new call; present to join the one already running. */
  callId?: string;
}

export function useEnterCall() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (target: EnterCallTarget) => {
      /**
       * The window is opened first, empty, and pointed at the room once the
       * server answers.
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
      const opened = window.open("", "_blank");
      if (opened) opened.opener = null;

      try {
        const result = target.callId
          ? await api.calls.join(target.callId)
          : await api.calls.start(target.channelId);

        if (opened) opened.location.href = result.joinUrl;
        else window.location.assign(result.joinUrl);

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
