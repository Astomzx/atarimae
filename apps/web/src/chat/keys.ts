/**
 * Query keys for chat, in one place.
 *
 * The realtime hook writes into caches that the pages own. A key spelled
 * slightly differently in two files means the socket updates a cache nothing
 * renders — the interface then looks stale until it is reloaded, which is the
 * hardest kind of bug to notice while developing with one browser tab open.
 */
export const chatKeys = {
  all: ["chat"] as const,
  channels: () => ["chat", "channels"] as const,
  members: (channelId: string) => ["chat", "members", channelId] as const,
  messages: (channelId: string) => ["chat", "messages", channelId] as const,
  calls: (channelId: string) => ["chat", "calls", channelId] as const,
  /**
   * The call ringing right now, wherever in the app you happen to be.
   *
   * Kept in the query cache rather than in a context so the socket hook can
   * write it without every screen having to be wrapped in a provider. It is
   * not server state and is never fetched — only set by an event and cleared
   * by another.
   */
  incomingCall: () => ["chat", "incoming-call"] as const,
  /** Whether calls are framed here. Server state, and it changes rarely. */
  callEmbedding: () => ["chat", "call-embedding"] as const,
  /**
   * The room this person is in right now, when it is shown inside Atarimae.
   *
   * In the cache rather than in the panel's own state because the banner at the
   * top of every screen can start a call, and the frame appears in the
   * conversation — two components, one fact. Like `incomingCall` it is never
   * fetched.
   */
  activeRoom: () => ["chat", "active-room"] as const,
};

export interface IncomingCall {
  callId: string;
  channelId: string;
  startedBy: string;
  startedByName: string;
}

/**
 * A room to show, and how.
 *
 * `embed: false` is the reconciliation case — the client expected to frame it
 * and the server said no, so there is a URL and no window to put it in. The
 * interface offers it as a link rather than pretending.
 */
export interface ActiveRoom {
  callId: string;
  channelId: string;
  joinUrl: string;
  embed: boolean;
}
