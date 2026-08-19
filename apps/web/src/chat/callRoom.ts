/**
 * Where a call room is put once the server has answered.
 *
 * Pulled out of the hook and kept pure because it is four cases and three of
 * them are the awkward ones. The decision cannot be made after the round trip
 * alone: a popup blocker only allows `window.open` during the gesture that
 * asked for one, so the client has to *guess* beforehand whether it will need
 * a window, and then reconcile the guess with what the server says.
 */

export interface EntryInput {
  /** What the server said: may this URL be framed on this origin right now. */
  embed: boolean;
  /** Whether a blank window was opened during the click. */
  opened: boolean;
  /**
   * Whether the client expected to frame, and therefore deliberately opened no
   * window. When this is true and `embed` is false, the guess was wrong.
   */
  expectedFrame: boolean;
}

export type Entry =
  /** Show it in the conversation. */
  | "frame"
  /** Point the window that was opened during the click at the room. */
  | "window"
  /**
   * Offer a link and let the person press it.
   *
   * The reconciliation case: the client expected to frame, so there is no
   * window handle, and opening one now is silently blocked in every browser.
   * The alternative would be taking this tab to the meeting room, which loses
   * Atarimae — so the person is given something to press instead.
   */
  | "link"
  /**
   * This tab goes to the room.
   *
   * Only when a window was wanted and refused. Losing the page is bad; a
   * button that did nothing at all is worse, and this is the pre-existing
   * behaviour for a blocked popup.
   */
  | "navigate";

export function decideEntry(input: EntryInput): Entry {
  if (input.embed) return "frame";
  if (input.opened) return "window";
  return input.expectedFrame ? "link" : "navigate";
}

/**
 * What the frame is allowed to use.
 *
 * Both halves are required and they are set in different places: the
 * `Permissions-Policy` header delegates camera and microphone to the
 * provider's origin, and this attribute is the frame asking for what was
 * delegated. With the header and without this, the room loads and cannot hear
 * anybody — the failure with nothing on screen to explain it.
 */
export const CALL_FRAME_ALLOW = "camera; microphone; display-capture; fullscreen";
