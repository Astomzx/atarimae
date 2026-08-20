import type { RealtimeEvent } from "@atarimae/api-schema";

/**
 * The socket's lifetime, with no React in it.
 *
 * Separated from the hook because the bug this replaces was a lifetime bug, not
 * a React one, and it could not be tested through a hook without a browser.
 *
 * What went wrong: "did we close this on purpose?" lived in a `useRef`, which
 * is shared across every run of the effect. React's StrictMode runs an effect,
 * cleans it up, and runs it again — and the first socket's `close` event
 * arrives after the second run has already reset the flag to false. The
 * cleanup's own `close()` was therefore read as an unexpected disconnection and
 * scheduled a reconnect, on a connection whose cleanup had already happened.
 * Nothing would ever close the socket that reconnect opened. Every mount leaked
 * one, and each leaked socket kept its own reconnect loop for the life of the
 * page.
 *
 * Here the flag is a local of `connectRealtime`, so it belongs to one
 * connection and cannot be reached by another. Two overlapping connections are
 * now simply two connections, each closing only itself.
 */

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** The server closes with this when the session cookie is gone or invalid. */
const UNAUTHENTICATED = 4401;

/**
 * Only what this file touches, so a test can hand over a stand-in without a
 * browser. `Pick` rather than a hand-written shape: a real `WebSocket` is then
 * assignable with no cast, and the cast lives in the test where the fake is.
 */
export type SocketLike = Pick<WebSocket, "close" | "addEventListener">;

export interface RealtimeConnection {
  /** Closes the socket and stops reconnecting. Safe to call more than once. */
  close(): void;
}

export interface ConnectRealtimeOptions {
  url: string;
  /** Called on every successful connection, including reconnections. */
  onOpen: () => void;
  onEvent: (event: RealtimeEvent) => void;
  /** Injected by tests; defaults to a real WebSocket. */
  create?: (url: string) => SocketLike;
  firstRetryMs?: number;
  maxRetryMs?: number;
}

export function connectRealtime(options: ConnectRealtimeOptions): RealtimeConnection {
  const create = options.create ?? ((url: string) => new WebSocket(url));
  const firstRetryMs = options.firstRetryMs ?? FIRST_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? MAX_RETRY_MS;

  /**
   * This connection's own. Not a ref, not module state: the whole defect was
   * one connection reading a flag another had written.
   */
  let closedByUs = false;

  let socket: SocketLike | null = null;
  let retryDelay = firstRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    // A timer that fired between `close()` clearing it and the callback
    // running would otherwise open a socket nobody holds.
    if (closedByUs) return;

    socket = create(options.url);

    socket.addEventListener("open", () => {
      retryDelay = firstRetryMs;

      // Whatever happened while the socket was down is unknown, so the question
      // is asked again rather than assumed unchanged.
      options.onOpen();
    });

    socket.addEventListener("message", (event) => {
      let parsed: RealtimeEvent;
      try {
        parsed = JSON.parse(String(event.data)) as RealtimeEvent;
      } catch {
        // A frame we cannot read is not worth breaking the connection over.
        return;
      }

      options.onEvent(parsed);
    });

    socket.addEventListener("close", (event) => {
      if (closedByUs) return;

      /**
       * An unauthenticated socket will be refused again immediately, and again
       * after that. Reconnecting in a loop would hammer the server for as long
       * as the tab is open; the session query will notice and send this person
       * to the login screen.
       */
      if (event.code === UNAUTHENTICATED) return;

      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, maxRetryMs);
    });

    // `close` fires after `error`, so the retry is scheduled there only.
    socket.addEventListener("error", () => undefined);
  };

  connect();

  return {
    close() {
      closedByUs = true;
      clearTimeout(retryTimer);
      socket?.close(1000, "leaving");
    },
  };
}
