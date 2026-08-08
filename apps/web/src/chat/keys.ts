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
};
