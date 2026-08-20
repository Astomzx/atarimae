import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectRealtime, type SocketLike } from "./realtime-socket.js";

/**
 * The socket's lifetime, and the one thing it must never do: leave a connection
 * open that nothing holds.
 *
 * The defect these are written against was invisible in production and only
 * happened in development, which is the worst combination — StrictMode runs
 * each effect twice, and the first socket's `close` arrived after the second
 * run had reset the "we closed it" flag they shared. The cleanup's own close
 * was read as an unexpected disconnection, a reconnect was scheduled, and
 * nothing would ever close what it opened.
 */

/** A stand-in for WebSocket that lets a test fire the events itself. */
class FakeSocket {
  readonly url: string;
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(listener);
    else this.listeners.set(type, [listener]);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Fires an event at the connection, the way a browser would. */
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let opened: FakeSocket[] = [];

/** Every socket the connection asks for, in order. */
const create = (url: string): SocketLike => {
  const socket = new FakeSocket(url);
  opened.push(socket);
  return socket as unknown as SocketLike;
};

const options = () => ({
  url: "ws://localhost/api/v1/realtime",
  onOpen: () => undefined,
  onEvent: () => undefined,
  create,
  firstRetryMs: 1_000,
  maxRetryMs: 30_000,
});

beforeEach(() => {
  opened = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connectRealtime", () => {
  it("opens one socket", () => {
    connectRealtime(options());

    expect(opened).toHaveLength(1);
    expect(opened[0]!.url).toBe("ws://localhost/api/v1/realtime");
  });

  it("reconnects when the connection drops on its own", () => {
    connectRealtime(options());

    opened[0]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_000);

    expect(opened).toHaveLength(2);
  });

  it("backs off rather than reconnecting at full speed", () => {
    connectRealtime(options());

    opened[0]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_000);
    opened[1]!.emit("close", { code: 1006 });

    // Second wait is two seconds, not one.
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(3);
  });

  it("does not reconnect after close(), even when the socket reports it late", () => {
    const connection = connectRealtime(options());

    connection.close();
    expect(opened[0]!.closed).toEqual({ code: 1000, reason: "leaving" });

    // The browser delivers `close` asynchronously, so it arrives after the
    // caller has already let go of the connection.
    opened[0]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(60_000);

    expect(opened).toHaveLength(1);
  });

  /**
   * The regression itself. Run against the previous implementation — where the
   * flag was a `useRef` shared by both runs of the effect — this ends with
   * three sockets: the second connection's, and one nobody can close.
   */
  it("survives StrictMode opening, closing and reopening around it", () => {
    const first = connectRealtime(options());
    first.close();
    const second = connectRealtime(options());

    // Only now does the first socket report the close the cleanup asked for.
    opened[0]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(60_000);

    expect(opened).toHaveLength(2);

    // And the surviving connection is still the one the caller holds.
    second.close();
    expect(opened[1]!.closed).toEqual({ code: 1000, reason: "leaving" });
  });

  it("stops for good when the server says the session is gone", () => {
    connectRealtime(options());

    // 4401: reconnecting would refuse identically, forever.
    opened[0]!.emit("close", { code: 4401 });
    vi.advanceTimersByTime(60_000);

    expect(opened).toHaveLength(1);
  });

  it("hands over parsed events and ignores frames it cannot read", () => {
    const seen: unknown[] = [];
    connectRealtime({ ...options(), onEvent: (event) => seen.push(event) });

    opened[0]!.emit("message", { data: JSON.stringify({ type: "ping" }) });
    opened[0]!.emit("message", { data: "not json" });

    expect(seen).toEqual([{ type: "ping" }]);
  });

  it("re-asks for everything on every connection, not just the first", () => {
    let opens = 0;
    connectRealtime({ ...options(), onOpen: () => opens++ });

    opened[0]!.emit("open");
    opened[0]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_000);
    opened[1]!.emit("open");

    // Whatever happened while it was down is unknown, so it is asked again.
    expect(opens).toBe(2);
  });
});
