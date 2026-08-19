import { describe, expect, it } from "vitest";

import { CALL_FRAME_ALLOW, decideEntry } from "./callRoom.js";

/**
 * Four cases, and the two that matter are the ones where the client's guess was
 * wrong. It has to decide whether to open a window *before* the server answers,
 * because a popup blocker only allows one during the gesture that asked for it.
 */
describe("where a call room goes", () => {
  it("frames it when the server says the browser will accept that", () => {
    expect(decideEntry({ embed: true, opened: false, expectedFrame: true })).toBe(
      "frame",
    );
  });

  it("points the window that was opened during the click", () => {
    expect(decideEntry({ embed: false, opened: true, expectedFrame: false })).toBe(
      "window",
    );
  });

  /**
   * The provider was made embeddable after this page loaded, so a window was
   * opened for a room that is going to be framed. Framing still wins; the
   * window is closed rather than left blank, which would read as the call
   * having started somewhere else.
   */
  it("still frames it when a window was opened as well", () => {
    expect(decideEntry({ embed: true, opened: true, expectedFrame: false })).toBe(
      "frame",
    );
  });

  /**
   * The other direction of the same race, and the one with no good options: the
   * client expected to frame, so there is no window handle, and opening one now
   * is silently blocked. A link the person can press beats taking their own tab
   * to the meeting room and losing Atarimae.
   */
  it("offers a link when framing was expected and refused", () => {
    expect(decideEntry({ embed: false, opened: false, expectedFrame: true })).toBe(
      "link",
    );
  });

  /** A blocked popup, which is the behaviour that existed before frames did. */
  it("goes there in this tab when a window was wanted and refused", () => {
    expect(decideEntry({ embed: false, opened: false, expectedFrame: false })).toBe(
      "navigate",
    );
  });
});

/**
 * The header delegates camera and microphone to the provider's origin; this
 * attribute is the frame asking for what was delegated. With one and not the
 * other, the room loads and cannot hear anybody — and nothing on screen says so.
 */
describe("what the frame is allowed to use", () => {
  it("asks for the two things a call cannot happen without", () => {
    expect(CALL_FRAME_ALLOW).toContain("camera");
    expect(CALL_FRAME_ALLOW).toContain("microphone");
  });
});
