/**
 * The application's side of the service worker.
 *
 * Two things a person actually notices, and one they must not be lied to
 * about:
 *
 *   - the app can be installed, and says so once the browser agrees
 *   - a new version is waiting, and reloading is a button rather than folklore
 *   - the network is gone, said plainly, because everything that matters here
 *     goes to the server and nothing is served from a cache pretending to be
 *     current
 */

/**
 * Registration is deliberately skipped in development.
 *
 * A worker that caches the shell fights Vite's hot reload, and the version it
 * pins is whatever was open when it installed. The one place a stale service
 * worker is genuinely expensive is the machine of the person changing the code.
 */
export function shouldRegister(mode: string, hasServiceWorker: boolean): boolean {
  return hasServiceWorker && mode === "production";
}

export interface PwaState {
  /** The browser has offered an install prompt and it has not been used. */
  canInstall: boolean;
  /** A new build is downloaded and waiting for the tab to be released. */
  updateReady: boolean;
  online: boolean;
}

type Listener = (state: PwaState) => void;

/**
 * A tiny store rather than a context.
 *
 * The events that drive this arrive on `window`, outside React, and at most
 * one component renders them. A provider wrapping the whole tree would be
 * ceremony for a three-field object.
 */
class PwaStore {
  private state: PwaState = {
    canInstall: false,
    updateReady: false,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
  };

  private listeners = new Set<Listener>();

  /**
   * Held so the install button has something to call. The event may only be
   * used once, and only from a user gesture.
   */
  private installPrompt: BeforeInstallPromptEvent | null = null;

  getState = (): PwaState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<PwaState>): void {
    // Same object when nothing changed, so useSyncExternalStore does not
    // re-render on every online event a flaky connection produces.
    const next = { ...this.state, ...patch };
    if (
      next.canInstall === this.state.canInstall &&
      next.updateReady === this.state.updateReady &&
      next.online === this.state.online
    ) {
      return;
    }

    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  setOnline(online: boolean): void {
    this.set({ online });
  }

  /**
   * What the API client actually observed.
   *
   * `navigator.onLine` is not good enough to base this banner on. It means
   * "there is a network interface", not "the server answers" — a laptop on a
   * café wifi that needs a login reports online, and Chromium under an
   * emulated offline profile reports online while every request fails.
   *
   * The claim on screen is that things cannot be sent right now, so the
   * evidence for it is a request that could not be sent.
   */
  reportReachable(reachable: boolean): void {
    this.set({ online: reachable });
  }

  setUpdateReady(): void {
    this.set({ updateReady: true });
  }

  offerInstall(event: BeforeInstallPromptEvent): void {
    this.installPrompt = event;
    this.set({ canInstall: true });
  }

  async install(): Promise<"accepted" | "dismissed" | "unavailable"> {
    const prompt = this.installPrompt;
    if (!prompt) return "unavailable";

    // Spent either way: the browser refuses to show the same event twice, so
    // keeping it would leave a button that silently does nothing.
    this.installPrompt = null;
    this.set({ canInstall: false });

    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    return outcome;
  }
}

export const pwa = new PwaStore();

/** Not in lib.dom yet, and Chrome-only. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function initialisePwa(mode: string): void {
  if (typeof window === "undefined") return;

  window.addEventListener("online", () => pwa.setOnline(true));
  window.addEventListener("offline", () => pwa.setOnline(false));

  window.addEventListener("beforeinstallprompt", (event) => {
    // Otherwise Chrome shows its own bar, at its own moment, in English.
    event.preventDefault();
    pwa.offerInstall(event as BeforeInstallPromptEvent);
  });

  if (!shouldRegister(mode, "serviceWorker" in navigator)) return;

  void navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((registration) => {
      // Already waiting when the page loaded — a previous visit downloaded it.
      if (registration.waiting) pwa.setUpdateReady();

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;

        installing.addEventListener("statechange", () => {
          // `controller` is null on the very first install. Announcing "a new
          // version is ready" to somebody who just arrived would be nonsense.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            pwa.setUpdateReady();
          }
        });
      });
    })
    .catch((error: unknown) => {
      // A failed registration costs the offline shell and nothing else, so it
      // must never take the application down with it.
      console.warn("service worker registration failed", error);
    });
}

/**
 * Takes the update: tells the waiting worker to activate, then reloads once it
 * has taken over.
 *
 * The reload is driven by `controllerchange` rather than fired immediately —
 * reloading first would just load the old assets again from the old worker.
 */
export function applyUpdate(): void {
  if (!("serviceWorker" in navigator)) {
    window.location.reload();
    return;
  }

  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // The event can fire more than once; a reload loop is worse than a stale
    // tab.
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  void navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration?.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  });
}
