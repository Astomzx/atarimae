import type { ListMessagesResponse, Message } from "@atarimae/api-schema";

/**
 * The parts of chat that are decisions rather than markup.
 *
 * Kept out of the components on purpose: mention encoding, cache merging and
 * the unread divider are the three places where chat quietly shows the wrong
 * thing — the wrong person mentioned, a message rendered twice, a divider that
 * says everything is unread. Rules that can be tested without a browser are
 * rules that stay true.
 */

/**
 * Mentions travel as `@<uuid>` in the message body.
 *
 * The server decided this, and for a good reason: display names contain spaces,
 * so matching on the name is ambiguous. The interface is what turns an id back
 * into a name in both directions.
 */
const MENTION_PATTERN =
  /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Somebody mentioned in a message who is no longer a member of the channel. */
export const UNKNOWN_MENTION_LABEL = "不明なメンバー";

export type BodySegment =
  { kind: "text"; text: string } | { kind: "mention"; userId: string; label: string };

/**
 * Splits a stored body into text and mentions, ready to render.
 *
 * An id that resolves to nobody still renders as a mention rather than as a
 * raw uuid: a member who left a channel must not turn old messages into
 * unreadable machine output.
 */
export function parseBody(
  body: string,
  displayNames: ReadonlyMap<string, string>,
): BodySegment[] {
  const segments: BodySegment[] = [];
  let index = 0;

  // A fresh regex per call: /g regexes carry lastIndex between calls, and a
  // shared one silently skips mentions in every second message.
  const pattern = new RegExp(MENTION_PATTERN.source, "gi");

  for (const match of body.matchAll(pattern)) {
    const start = match.index;
    if (start > index) segments.push({ kind: "text", text: body.slice(index, start) });

    const userId = match[1]!.toLowerCase();
    segments.push({
      kind: "mention",
      userId,
      label: displayNames.get(userId) ?? UNKNOWN_MENTION_LABEL,
    });

    index = start + match[0].length;
  }

  if (index < body.length) segments.push({ kind: "text", text: body.slice(index) });

  return segments;
}

/**
 * A mention cut in half by the server's 80-character preview.
 *
 * The preview is a substring of the body, so a mention near the end arrives as
 * a fragment that no longer looks like an id. Rendering it as typed would put
 * half a uuid in the channel list, which is the interface leaking its own
 * storage format at the reader.
 */
const TRUNCATED_MENTION = /@[0-9a-f]{8}-[0-9a-f-]*$/i;

/**
 * The one-line preview under a channel name.
 *
 * Mentions become names here too. A list that reads "A区域の担当をお願いします
 * @019fe100-ed2c-…" tells somebody scanning their channels nothing at all.
 */
export function previewBody(
  preview: string,
  displayNames: ReadonlyMap<string, string>,
): string {
  const rendered = parseBody(preview, displayNames)
    .map((segment) => (segment.kind === "text" ? segment.text : `@${segment.label}`))
    .join("");

  return rendered.replace(TRUNCATED_MENTION, "@…");
}

export interface MentionCandidate {
  userId: string;
  displayName: string;
}

export interface EncodedBody {
  /** What to send: display names replaced by the ids the server expects. */
  body: string;
  /**
   * Names that matched two different people. Nothing is encoded for these —
   * mentioning the wrong colleague silently is worse than refusing to send.
   */
  ambiguous: string[];
}

/**
 * Turns `@田中 一郎` back into `@<uuid>` before sending.
 *
 * Only people the author actually picked from the list are converted. Typing a
 * name by hand produces plain text, which is visible in the composer — the
 * alternative, guessing at a name, is how a private remark reaches somebody it
 * was not about.
 *
 * Scanned in one pass rather than by repeated replacement: a display name that
 * happens to be a substring of a uuid would otherwise be substituted a second
 * time inside an id that was just written.
 */
export function encodeMentions(
  text: string,
  picked: readonly MentionCandidate[],
): EncodedBody {
  const byName = new Map<string, string | null>();
  for (const candidate of picked) {
    // Null marks a name two people share: it stays literal text and is
    // reported, rather than resolving to whichever of them was picked first.
    if (byName.has(candidate.displayName)) {
      const existing = byName.get(candidate.displayName);
      if (existing !== candidate.userId) byName.set(candidate.displayName, null);
    } else {
      byName.set(candidate.displayName, candidate.userId);
    }
  }

  // Longest first, so "@田中 一郎" is not truncated to "@田中".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);

  const ambiguous = new Set<string>();
  let body = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "@") {
      body += text[index];
      index += 1;
      continue;
    }

    const name = names.find((candidate) => text.startsWith(candidate, index + 1));
    if (name === undefined) {
      body += "@";
      index += 1;
      continue;
    }

    const userId = byName.get(name);
    if (userId === null || userId === undefined) {
      ambiguous.add(name);
      body += `@${name}`;
    } else {
      body += `@${userId}`;
    }
    index += 1 + name.length;
  }

  return { body, ambiguous: [...ambiguous] };
}

export interface MessagePages {
  pages: ListMessagesResponse[];
  pageParams: unknown[];
}

/**
 * Adds a message that arrived over the socket to the loaded pages.
 *
 * Deduplicated by id, because the author receives their own message twice: once
 * as the response to the POST, once as the realtime event they are a recipient
 * of. Returning the same object when nothing changed also keeps React from
 * re-rendering the whole log on every echo.
 *
 * Page 0 is the newest page — the query walks backwards through history — so a
 * new message belongs at the end of it.
 */
export function appendMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  if (!data) return data;

  const known = data.pages.some((page) =>
    page.items.some((item) => item.id === message.id),
  );
  if (known) return data;

  const [first, ...rest] = data.pages;
  if (!first) return { ...data, pages: [{ items: [message], nextBefore: null }] };

  return {
    ...data,
    pages: [{ ...first, items: [...first.items, message] }, ...rest],
  };
}

/**
 * Where the "ここから未読" line goes.
 *
 * Derived from the unread count the channel list reported when the channel was
 * opened, counting backwards over messages written by other people — the same
 * definition the server uses, which is what keeps the divider and the badge
 * from disagreeing.
 *
 * Returns null when there is nothing unread, or when the unread messages are
 * older than anything loaded: a divider pinned to the top of a half-loaded log
 * would claim the whole conversation is new.
 */
export function firstUnreadId(
  messages: readonly Message[],
  unreadCount: number,
  myUserId: string,
): string | null {
  if (unreadCount <= 0) return null;

  let remaining = unreadCount;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.authorId === myUserId) continue;

    remaining -= 1;
    if (remaining === 0) return message.id;
  }

  return null;
}

/** Ids are uuidv7, so the newest is also the greatest. */
export function newestMessageId(messages: readonly Message[]): string | null {
  let newest: string | null = null;
  for (const message of messages) {
    if (newest === null || message.id > newest) newest = message.id;
  }
  return newest;
}

/**
 * What to call a channel in a list or a heading.
 *
 * Conversations have no name of their own; they are named after the other
 * person. A conversation whose counterpart has been anonymised still needs a
 * label, so there is a fallback rather than an empty heading.
 */
export function channelTitle(channel: {
  kind: string;
  name: string | null;
  counterpartName: string | null;
}): string {
  if (channel.kind === "direct") return channel.counterpartName ?? "会話";
  return channel.name ?? "会話";
}

/**
 * A file size somebody can judge at a glance.
 *
 * Binary units, because the 25 MiB ceiling is a binary number and a file the
 * server refuses should not be displayed as "26.2 MB" next to a limit of "25
 * MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

const TIME_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDay(iso: string): string {
  return DAY_FORMAT.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}

/** Compared in local time: a day divider follows the reader's calendar. */
export function isSameLocalDay(a: string, b: string): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
