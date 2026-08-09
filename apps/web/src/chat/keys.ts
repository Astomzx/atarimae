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
};

export interface IncomingCall {
  callId: string;
  channelId: string;
  startedBy: string;
  startedByName: string;
}
