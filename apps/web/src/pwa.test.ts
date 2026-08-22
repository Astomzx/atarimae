import { beforeEach, describe, expect, it, vi } from "vitest";

import { pwa, shouldRegister } from "./pwa.js";

/**
 * The parts of the service worker's app side that are decisions rather than
 * browser plumbing. Everything the worker itself does is proved end to end in
 * `e2e/tests/pwa-offline.spec.ts`, against a real browser with the network cut.
 */

describe("shouldRegister", () => {
  /**
   * A worker that pins the shell fights hot reload, and the version it pins is
   * whatever was open when it installed. The one machine where a stale service
   * worker is genuinely expensive is the one the code is being changed on.
   */
  it("stays out of development", () => {
    expect(shouldRegister("development", true)).toBe(false);
  });

  it("registers in production", () => {
    expect(shouldRegister("production", true)).toBe(true);
  });

  it("does nothing where there is no service worker to register", () => {
    expect(shouldRegister("production", false)).toBe(false);
  });
});

describe("the store", () => {
  beforeEach(() => {
    pwa.setOnline(true);
  });

  it("tells subscribers when the network goes", () => {
    const seen: boolean[] = [];
    const unsubscribe = pwa.subscribe((state) => seen.push(state.online));

    pwa.setOnline(false);
    pwa.setOnline(true);
    unsubscribe();

    expect(seen).toEqual([false, true]);
  });

  /**
   * A flaky connection fires `online` repeatedly. Notifying on every one of
   * them would re-render the whole application each time, so an unchanged
   * state is not an event.
   */
  it("says nothing when nothing changed", () => {
    const listener = vi.fn();
    const unsubscribe = pwa.subscribe(listener);

    pwa.setOnline(true);
    pwa.setOnline(true);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying once unsubscribed", () => {
    const listener = vi.fn();
    pwa.subscribe(listener)();

    pwa.setOnline(false);

    expect(listener).not.toHaveBeenCalled();
  });

  it("has nothing to install until the browser offers", async () => {
    expect(pwa.getState().canInstall).toBe(false);
    await expect(pwa.install()).resolves.toBe("unavailable");
  });

  /**
   * The browser refuses to show the same prompt twice. Keeping the event
   * around would leave a button that silently does nothing the second time.
   */
  it("spends the install prompt exactly once", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    };

    pwa.offerInstall(event as unknown as Parameters<typeof pwa.offerInstall>[0]);
    expect(pwa.getState().canInstall).toBe(true);

    await expect(pwa.install()).resolves.toBe("accepted");
    expect(pwa.getState().canInstall).toBe(false);

    await expect(pwa.install()).resolves.toBe("unavailable");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("reports a dismissal as a dismissal", async () => {
    const event = {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    };

    pwa.offerInstall(event as unknown as Parameters<typeof pwa.offerInstall>[0]);

    await expect(pwa.install()).resolves.toBe("dismissed");
  });
});
