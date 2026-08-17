import { api } from "./api.js";

/**
 * Turning push on for this browser, on this device.
 *
 * The interesting part is not the subscribe call — it is being honest about
 * the five different things "notifications are off" can mean, because the
 * remedy is different for each and a single "有効にできませんでした" would
 * leave somebody clicking a button that will never work.
 *
 * Permission is asked for only when somebody presses the button. A prompt on
 * page load is how people learn to click 拒否 without reading, and a denied
 * permission cannot be asked for again from the page — it has to be undone in
 * browser settings, which most people will not find.
 */

export type PushState =
  /** No service worker or no PushManager — an old browser, or iOS in Safari. */
  | { kind: "unsupported" }
  /** The server has no VAPID keypair, so nothing could be sent. */
  | { kind: "unavailable" }
  /** Refused, and the page cannot ask again. Browser settings only. */
  | { kind: "denied" }
  /** Never asked. The button is worth showing. */
  | { kind: "available" }
  /** On, for this device. */
  | { kind: "subscribed" };

export function isSupported(scope: {
  serviceWorker?: unknown;
  PushManager?: unknown;
  Notification?: unknown;
}): boolean {
  return (
    Boolean(scope.serviceWorker) &&
    Boolean(scope.PushManager) &&
    Boolean(scope.Notification)
  );
}

/**
 * The VAPID key, as `PushManager.subscribe` wants it.
 *
 * Base64url in, `Uint8Array` out. Browsers will accept a base64 *string* for
 * `applicationServerKey` in some versions and reject it in others, and the
 * padding differs between base64 and base64url — which produces a subscription
 * that looks fine and that the server can never encrypt to. Converting here,
 * with a test, is cheaper than diagnosing that.
 */
export function decodeVapidKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);

  /*
   * The ArrayBuffer is allocated explicitly rather than left to
   * `new Uint8Array(length)`. `applicationServerKey` wants a `BufferSource`,
   * and the inferred `Uint8Array<ArrayBufferLike>` is not one — ArrayBufferLike
   * admits a SharedArrayBuffer, which that API refuses.
   */
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `PushSubscription.getKey` returns an ArrayBuffer; the API wants base64url. */
export function encodeKey(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Works out which of the five states this browser is in.
 *
 * Separated from the DOM calls so the mapping can be tested: the difference
 * between "never asked" and "refused" decides whether a button is shown at
 * all, and getting it backwards shows people a control that cannot work.
 */
export function stateFrom(input: {
  supported: boolean;
  permission: NotificationPermission;
  hasServerKey: boolean;
  hasSubscription: boolean;
}): PushState {
  if (!input.supported) return { kind: "unsupported" };
  if (!input.hasServerKey) return { kind: "unavailable" };
  if (input.permission === "denied") return { kind: "denied" };
  if (input.permission === "granted" && input.hasSubscription) {
    return { kind: "subscribed" };
  }
  return { kind: "available" };
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** Reads the current state without asking for anything. */
export async function currentState(): Promise<PushState> {
  const supported = isSupported({
    serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    PushManager: typeof PushManager !== "undefined" ? PushManager : undefined,
    Notification: typeof Notification !== "undefined" ? Notification : undefined,
  });
  if (!supported) return { kind: "unsupported" };

  const { publicKey } = await api.push.publicKey();
  const existing = await (await registration())?.pushManager.getSubscription();

  return stateFrom({
    supported: true,
    permission: Notification.permission,
    hasServerKey: Boolean(publicKey),
    hasSubscription: Boolean(existing),
  });
}

/**
 * Asks, subscribes, and tells the server — in that order.
 *
 * The server is told last on purpose. A subscription recorded server-side that
 * the browser then failed to create is a row the worker will push to forever
 * and nobody will ever see.
 */
export async function enablePush(): Promise<PushState> {
  const { publicKey } = await api.push.publicKey();
  if (!publicKey) return { kind: "unavailable" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? { kind: "denied" } : { kind: "available" };
  }

  const reg = await registration();
  if (!reg) return { kind: "unsupported" };

  const subscription = await reg.pushManager.subscribe({
    // Required by every browser: a push that shows nothing is not allowed.
    userVisibleOnly: true,
    applicationServerKey: decodeVapidKey(publicKey),
  });

  await api.push.subscribe({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: encodeKey(subscription.getKey("p256dh")),
      auth: encodeKey(subscription.getKey("auth")),
    },
  });

  return { kind: "subscribed" };
}

/**
 * Off here, and off on the server.
 *
 * The browser subscription is dropped first and the server told afterwards; if
 * the second call fails the worst case is a push the browser silently discards,
 * rather than a device that keeps buzzing because the local half is gone.
 */
export async function disablePush(): Promise<PushState> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  if (!subscription) return { kind: "available" };

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.push.unsubscribe(endpoint);

  return { kind: "available" };
}
