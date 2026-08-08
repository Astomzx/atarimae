import type { Message } from "@atarimae/api-schema";
import { describe, expect, it } from "vitest";

import {
  appendMessage,
  channelTitle,
  encodeMentions,
  firstUnreadId,
  isSameLocalDay,
  newestMessageId,
  parseBody,
  previewBody,
  UNKNOWN_MENTION_LABEL,
  type MessagePages,
} from "./format.js";

const TANAKA = "018f4c1e-0000-7000-8000-000000000001";
const SATO = "018f4c1e-0000-7000-8000-000000000002";
const ME = "018f4c1e-0000-7000-8000-00000000000f";

const NAMES = new Map([
  [TANAKA, "田中 一郎"],
  [SATO, "佐藤 花子"],
]);

function message(id: string, authorId: string, body = "本文"): Message {
  return {
    id,
    channelId: "018f4c1e-0000-7000-8000-0000000000aa",
    authorId,
    authorName: NAMES.get(authorId) ?? "私",
    body,
    replyToId: null,
    replyToPreview: null,
    mentions: [],
    attachments: [],
    createdAt: "2026-08-08T09:00:00.000Z",
  };
}

/** Ids sort as strings the way uuidv7 sorts in time; only the tail varies. */
function messageId(sequence: number): string {
  return `018f4c1e-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

describe("parseBody", () => {
  it("renders a mention as the person's name, not as a uuid", () => {
    const segments = parseBody(`@${TANAKA} おはようございます`, NAMES);

    expect(segments).toEqual([
      { kind: "mention", userId: TANAKA, label: "田中 一郎" },
      { kind: "text", text: " おはようございます" },
    ]);
  });

  it("keeps text on both sides of a mention", () => {
    expect(parseBody(`朝礼は @${SATO} が担当です`, NAMES)).toEqual([
      { kind: "text", text: "朝礼は " },
      { kind: "mention", userId: SATO, label: "佐藤 花子" },
      { kind: "text", text: " が担当です" },
    ]);
  });

  /**
   * A member who has left the channel is still mentioned in the history. The
   * message has to stay readable — a raw uuid in the middle of a sentence is
   * the interface admitting it lost track of somebody.
   */
  it("labels a mention of somebody no longer in the channel", () => {
    const segments = parseBody(`@${TANAKA} よろしく`, new Map());

    expect(segments[0]).toEqual({
      kind: "mention",
      userId: TANAKA,
      label: UNKNOWN_MENTION_LABEL,
    });
  });

  /**
   * A /g regex keeps its lastIndex between calls. Sharing one across messages
   * makes every second message render its mention as plain text — a defect
   * that only appears once there is more than one message on screen.
   */
  it("finds the mention in every message, not every second one", () => {
    const body = `@${TANAKA} 確認お願いします`;

    for (let round = 0; round < 3; round += 1) {
      expect(parseBody(body, NAMES)[0]).toMatchObject({ kind: "mention" });
    }
  });

  it("finds several mentions in one message", () => {
    const segments = parseBody(`@${TANAKA} と @${SATO}`, NAMES);

    expect(segments.filter((s) => s.kind === "mention")).toHaveLength(2);
  });

  it("leaves an ordinary @ alone", () => {
    expect(parseBody("メールは name@example.test です", NAMES)).toEqual([
      { kind: "text", text: "メールは name@example.test です" },
    ]);
  });
});

describe("previewBody", () => {
  it("shows a name in the channel list, not an id", () => {
    expect(previewBody(`A区域の担当をお願いします @${TANAKA}`, NAMES)).toBe(
      "A区域の担当をお願いします @田中 一郎",
    );
  });

  /**
   * The preview is the first 80 characters of the body, so a mention near the
   * end arrives as a fragment. Half a uuid in the channel list is the
   * interface showing the reader its own storage format.
   */
  it("hides a mention the preview cut in half", () => {
    expect(previewBody("担当は @019fe100-ed2c-7d7f-af7", NAMES)).toBe("担当は @…");
  });

  it("leaves an address at the end of a preview alone", () => {
    expect(previewBody("連絡先は name@example.test", NAMES)).toBe(
      "連絡先は name@example.test",
    );
  });

  it("passes an ordinary preview through unchanged", () => {
    expect(previewBody("明日は8時30分から朝礼です。", NAMES)).toBe(
      "明日は8時30分から朝礼です。",
    );
  });
});

describe("encodeMentions", () => {
  const picked = [
    { userId: TANAKA, displayName: "田中 一郎" },
    { userId: SATO, displayName: "佐藤 花子" },
  ];

  it("sends the id the server resolves, not the name", () => {
    expect(encodeMentions("@田中 一郎 おはようございます", picked)).toEqual({
      body: `@${TANAKA} おはようございます`,
      ambiguous: [],
    });
  });

  /**
   * "@田中" is a prefix of "@田中 一郎". Matching the shorter name first would
   * mention the right person and leave "一郎" stranded in the text — or mention
   * the wrong one entirely once two names share a prefix.
   */
  it("prefers the longest matching name", () => {
    const both = [
      { userId: SATO, displayName: "田中" },
      { userId: TANAKA, displayName: "田中 一郎" },
    ];

    expect(encodeMentions("@田中 一郎 へ", both).body).toBe(`@${TANAKA} へ`);
  });

  it("converts every occurrence", () => {
    const { body } = encodeMentions("@田中 一郎 と @佐藤 花子", picked);

    expect(body).toBe(`@${TANAKA} と @${SATO}`);
  });

  /**
   * The whole point of the picker: a name typed by hand is not a mention. It
   * stays visible as typed rather than notifying somebody the author never
   * chose.
   */
  it("leaves a name nobody picked as plain text", () => {
    expect(encodeMentions("@田中 一郎 へ", []).body).toBe("@田中 一郎 へ");
  });

  /**
   * Two colleagues with the same display name. Guessing which one was meant is
   * how a message reaches the wrong person, so nothing is encoded and the
   * composer is told to say so.
   */
  it("refuses to guess when two people share a display name", () => {
    const twins = [
      { userId: TANAKA, displayName: "田中" },
      { userId: SATO, displayName: "田中" },
    ];

    expect(encodeMentions("@田中 へ", twins)).toEqual({
      body: "@田中 へ",
      ambiguous: ["田中"],
    });
  });

  it("treats the same person picked twice as unambiguous", () => {
    const twice = [
      { userId: TANAKA, displayName: "田中 一郎" },
      { userId: TANAKA, displayName: "田中 一郎" },
    ];

    expect(encodeMentions("@田中 一郎", twice)).toEqual({
      body: `@${TANAKA}`,
      ambiguous: [],
    });
  });

  it("leaves an ordinary @ alone", () => {
    expect(encodeMentions("name@example.test", picked).body).toBe("name@example.test");
  });

  /**
   * A display name that is a fragment of a uuid would be substituted a second
   * time inside the id just written, if encoding worked by repeated
   * replacement rather than a single pass.
   */
  it("does not rewrite the id it just wrote", () => {
    const awkward = [{ userId: TANAKA, displayName: "018f4c1e" }];

    expect(encodeMentions("@018f4c1e さん", awkward).body).toBe(`@${TANAKA} さん`);
  });
});

describe("appendMessage", () => {
  const pages: MessagePages = {
    pages: [
      {
        items: [message(messageId(3), SATO), message(messageId(4), ME)],
        nextBefore: null,
      },
      {
        items: [message(messageId(1), SATO), message(messageId(2), ME)],
        nextBefore: null,
      },
    ],
    pageParams: [undefined, messageId(3)],
  };

  it("adds a new message to the end of the newest page", () => {
    const next = appendMessage(pages, message(messageId(5), SATO))!;

    expect(next.pages[0]!.items.map((m) => m.id)).toEqual([
      messageId(3),
      messageId(4),
      messageId(5),
    ]);
    // Older pages are untouched.
    expect(next.pages[1]).toBe(pages.pages[1]);
  });

  /**
   * The author is a member of the channel, so their own message comes back
   * over the socket as well as in the response to the POST. Without a check on
   * the id, every message you send appears twice in your own window.
   */
  it("ignores a message that is already loaded", () => {
    expect(appendMessage(pages, message(messageId(4), ME))).toBe(pages);
  });

  it("finds a duplicate in an older page too", () => {
    expect(appendMessage(pages, message(messageId(1), SATO))).toBe(pages);
  });

  /** Nothing loaded yet: the query will fetch it, and will fetch it once. */
  it("leaves an empty cache alone", () => {
    expect(appendMessage(undefined, message(messageId(5), SATO))).toBeUndefined();
  });
});

describe("firstUnreadId", () => {
  const log = [
    message(messageId(1), SATO),
    message(messageId(2), ME),
    message(messageId(3), SATO),
    message(messageId(4), SATO),
  ];

  it("marks the first of the unread messages", () => {
    expect(firstUnreadId(log, 2, ME)).toBe(messageId(3));
  });

  /** Your own messages were never unread to you — the server agrees. */
  it("does not count what I wrote myself", () => {
    expect(firstUnreadId([...log, message(messageId(5), ME)], 2, ME)).toBe(messageId(3));
  });

  it("shows no divider when everything has been read", () => {
    expect(firstUnreadId(log, 0, ME)).toBeNull();
  });

  /**
   * More unread than loaded: the unread ones are further back than this page.
   * A divider at the top would claim the whole visible conversation is new.
   */
  it("shows no divider when the unread messages are not loaded", () => {
    expect(firstUnreadId(log, 9, ME)).toBeNull();
  });
});

describe("newestMessageId", () => {
  it("is the greatest id, because uuidv7 sorts in time", () => {
    expect(
      newestMessageId([
        message(messageId(2), SATO),
        message(messageId(9), ME),
        message(messageId(4), SATO),
      ]),
    ).toBe(messageId(9));
  });

  it("is null for an empty channel", () => {
    expect(newestMessageId([])).toBeNull();
  });
});

describe("channelTitle", () => {
  it("names a conversation after the other person", () => {
    expect(
      channelTitle({ kind: "direct", name: null, counterpartName: "田中 一郎" }),
    ).toBe("田中 一郎");
  });

  it("uses the channel name for a channel", () => {
    expect(channelTitle({ kind: "public", name: "営業", counterpartName: null })).toBe(
      "営業",
    );
  });

  it("still has a heading when the counterpart has no name left", () => {
    expect(channelTitle({ kind: "direct", name: null, counterpartName: null })).toBe(
      "会話",
    );
  });
});

describe("isSameLocalDay", () => {
  it("groups two times on the same local day", () => {
    expect(
      isSameLocalDay(
        new Date(2026, 7, 8, 1, 0).toISOString(),
        new Date(2026, 7, 8, 23, 0).toISOString(),
      ),
    ).toBe(true);
  });

  it("separates two local days", () => {
    expect(
      isSameLocalDay(
        new Date(2026, 7, 8, 23, 0).toISOString(),
        new Date(2026, 7, 9, 0, 30).toISOString(),
      ),
    ).toBe(false);
  });
});
