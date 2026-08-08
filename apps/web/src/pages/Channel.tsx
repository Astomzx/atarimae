import type { ChannelMember, Message } from "@atarimae/api-schema";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api, errorMessage } from "../api.js";
import { useSession } from "../auth.js";
import { useDirectory } from "../chat/directory.js";
import {
  appendMessage,
  channelTitle,
  encodeMentions,
  firstUnreadId,
  formatDay,
  formatTime,
  isSameLocalDay,
  newestMessageId,
  parseBody,
  type MentionCandidate,
  type MessagePages,
} from "../chat/format.js";
import { chatKeys } from "../chat/keys.js";

/**
 * One conversation.
 *
 * Remounted per channel — the `key` on the route below — so nothing about the
 * previous channel can survive into this one: not the draft, not the reply
 * being written, and above all not the unread position, which would otherwise
 * draw the divider in the wrong place.
 */
export function ChannelRoute() {
  const { channelId } = useParams<{ channelId: string }>();
  if (!channelId) return null;
  return <ChannelPage key={channelId} channelId={channelId} />;
}

function ChannelPage({ channelId }: { channelId: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const directory = useDirectory();
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  const channels = useQuery({
    queryKey: chatKeys.channels(),
    queryFn: api.chat.channels,
  });

  const members = useQuery({
    queryKey: chatKeys.members(channelId),
    queryFn: () => api.chat.members(channelId),
  });

  const messages = useInfiniteQuery({
    queryKey: chatKeys.messages(channelId),
    queryFn: ({ pageParam }) => api.chat.messages(channelId, pageParam),
    initialPageParam: undefined as string | undefined,
    // "Next" means older: the query walks backwards from the newest message,
    // because that is what a conversation opens to.
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
  });

  const channel = channels.data?.items.find((item) => item.id === channelId) ?? null;

  const log = useMemo(
    () => [...(messages.data?.pages ?? [])].reverse().flatMap((page) => page.items),
    [messages.data],
  );

  /**
   * Names for rendering mentions: everybody, with the channel's own members on
   * top. A colleague who has left the channel is still named in its history,
   * and their name is the only useful thing to show there.
   */
  const displayNames = useMemo(() => {
    const names = new Map(directory);
    for (const member of members.data?.items ?? []) {
      names.set(member.userId, member.displayName);
    }
    return names;
  }, [directory, members.data]);

  /**
   * How much was unread when this channel was opened, captured once.
   *
   * Read on arrival, so the count is on its way to zero the moment the page
   * loads. Reading it live would erase the divider a heartbeat after drawing
   * it, and the reader would never find where they had got to.
   */
  const unreadOnArrival = useRef<number | null>(null);
  if (unreadOnArrival.current === null && channel !== null) {
    unreadOnArrival.current = channel.unreadCount;
  }

  const unreadFrom = firstUnreadId(log, unreadOnArrival.current ?? 0, user?.id ?? "");

  const markRead = useMutation({
    mutationFn: (messageId: string) => api.chat.markRead(channelId, messageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.channels() }),
  });

  /**
   * Moving the read position, once per newest message.
   *
   * The server refuses to move it backwards, so a phone catching up cannot
   * undo what was already read at a desktop; this only avoids sending the same
   * position repeatedly.
   */
  const lastMarked = useRef<string | null>(null);
  const newest = newestMessageId(log);
  const isMember = channel?.isMember ?? false;
  const sendReadPosition = markRead.mutate;

  useEffect(() => {
    if (!newest || !isMember) return;
    // Ids are uuidv7, so "further along" is a string comparison.
    if (lastMarked.current !== null && lastMarked.current >= newest) return;

    lastMarked.current = newest;
    sendReadPosition(newest);
  }, [newest, isMember, sendReadPosition]);

  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [newest]);

  const title = channel ? channelTitle(channel) : "会話";

  return (
    <div className="page">
      <div className="page__header">
        <Link to="/chat" className="button button--quiet" data-testid="back-to-chat">
          ← チャット
        </Link>
      </div>

      <h1 className="page__title" data-testid="channel-title">
        {title}
      </h1>
      {channel?.description && <p className="muted">{channel.description}</p>}
      {channel && (
        <p className="muted" data-testid="channel-member-count">
          {channel.memberCount} 名
        </p>
      )}

      {messages.isError && (
        <p className="alert alert--error">{errorMessage(messages.error)}</p>
      )}

      {messages.hasNextPage && (
        <p className="chat__older">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void messages.fetchNextPage()}
            disabled={messages.isFetchingNextPage}
            data-testid="load-older"
          >
            {messages.isFetchingNextPage ? "読み込み中…" : "以前のメッセージを読み込む"}
          </button>
        </p>
      )}

      <div className="chat__log" data-testid="message-log">
        {messages.isPending && <p className="muted">読み込み中…</p>}

        {messages.isSuccess && log.length === 0 && (
          <p className="muted" data-testid="no-messages">
            まだメッセージはありません。
          </p>
        )}

        {log.map((message, index) => (
          <MessageItem
            key={message.id}
            message={message}
            previous={index > 0 ? log[index - 1]! : null}
            displayNames={displayNames}
            isMine={message.authorId === user?.id}
            mentionsMe={user ? message.mentions.includes(user.id) : false}
            unreadStartsHere={message.id === unreadFrom}
            onReply={() => setReplyTo(message)}
          />
        ))}

        <div ref={bottom} />
      </div>

      {/*
       * No composer until we know this person may post. A channel that is not
       * in their list is one they cannot see at all — offering a box to type
       * in would promise something the server is about to refuse.
       */}
      {channel?.isMember && (
        <Composer
          channelId={channelId}
          members={members.data?.items ?? []}
          currentUserId={user?.id ?? ""}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
        />
      )}

      {channel !== null && !channel.isMember && <JoinNotice channelId={channelId} />}
    </div>
  );
}

function JoinNotice({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();

  const join = useMutation({
    mutationFn: () => api.chat.join(channelId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.channels() }),
  });

  return (
    <section className="card" data-testid="join-notice">
      <p className="muted card__lead">
        このチャンネルは読むことができますが、投稿するには参加が必要です。
      </p>
      <button
        type="button"
        className="button button--primary"
        onClick={() => join.mutate()}
        disabled={join.isPending}
        data-testid="join-channel"
      >
        {join.isPending ? "参加中…" : "参加する"}
      </button>
      {join.isError && (
        <p className="alert alert--error alert--inline">{errorMessage(join.error)}</p>
      )}
    </section>
  );
}

function MessageItem({
  message,
  previous,
  displayNames,
  isMine,
  mentionsMe,
  unreadStartsHere,
  onReply,
}: {
  message: Message;
  previous: Message | null;
  displayNames: ReadonlyMap<string, string>;
  isMine: boolean;
  mentionsMe: boolean;
  unreadStartsHere: boolean;
  onReply: () => void;
}) {
  const newDay =
    previous === null || !isSameLocalDay(previous.createdAt, message.createdAt);

  return (
    <>
      {newDay && (
        <p className="chat__day" data-testid="day-divider">
          {formatDay(message.createdAt)}
        </p>
      )}

      {unreadStartsHere && (
        <p className="chat__unread-line" data-testid="unread-divider">
          ここから未読
        </p>
      )}

      <article
        className={`chat__message${isMine ? " chat__message--mine" : ""}${
          mentionsMe ? " chat__message--mentions-me" : ""
        }`}
        data-testid="message"
      >
        <header className="chat__meta">
          <span className="chat__author">{message.authorName}</span>
          <span className="chat__time">{formatTime(message.createdAt)}</span>
          <button
            type="button"
            className="chat__reply-button"
            onClick={onReply}
            data-testid="reply-to-message"
          >
            返信
          </button>
        </header>

        {message.replyToPreview !== null && (
          <p className="chat__quote" data-testid="reply-quote">
            {message.replyToPreview}
          </p>
        )}

        <p className="chat__body" data-testid="message-body">
          {parseBody(message.body, displayNames).map((segment, index) =>
            segment.kind === "text" ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <span key={index} className="chat__mention" data-testid="mention">
                @{segment.label}
              </span>
            ),
          )}
        </p>
      </article>
    </>
  );
}

function Composer({
  channelId,
  members,
  currentUserId,
  replyTo,
  onClearReply,
}: {
  channelId: string;
  members: readonly ChannelMember[];
  currentUserId: string;
  replyTo: Message | null;
  onClearReply: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);

  const sendMessage = useMutation({
    mutationFn: (body: string) =>
      api.chat.sendMessage(channelId, {
        body,
        ...(replyTo ? { replyToId: replyTo.id } : {}),
      }),
    onSuccess: async (message) => {
      setText("");
      setPicked([]);
      onClearReply();

      // The socket delivers this message to its author as well, and
      // `appendMessage` deduplicates by id — so writing it here is what makes
      // a sent message appear at once even with the socket down.
      queryClient.setQueryData<MessagePages>(chatKeys.messages(channelId), (data) =>
        appendMessage(data, message),
      );
      await queryClient.invalidateQueries({ queryKey: chatKeys.channels() });
    },
  });

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;

    const encoded = encodeMentions(trimmed, picked);

    /**
     * Two colleagues with the same display name. Sending would mention one of
     * them and it would not be visible which — so it is refused, out loud,
     * rather than resolved by guessing.
     */
    if (encoded.ambiguous.length > 0) {
      setAmbiguous(encoded.ambiguous);
      return;
    }

    setAmbiguous([]);
    sendMessage.mutate(encoded.body);
  };

  const mentionable = members.filter((member) => member.userId !== currentUserId);

  return (
    <section className="chat__composer">
      {replyTo && (
        <p className="chat__replying" data-testid="replying-to">
          <span className="chat__replying-label">返信先</span>
          <span className="chat__replying-body">{replyTo.body.slice(0, 60)}</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={onClearReply}
            data-testid="cancel-reply"
          >
            取り消す
          </button>
        </p>
      )}

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span className="field__label">メッセージ</span>
          <textarea
            className="field__input field__input--multiline"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter inserts a newline at every width — a phone keyboard has
              // no other way to write a second line. Ctrl+Enter sends.
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
            maxLength={10_000}
            rows={3}
            data-testid="message-input"
          />
        </label>

        {mentionable.length > 0 && (
          <div className="field">
            <span className="field__label">メンバーを指名（@）</span>
            <div className="chips">
              {mentionable.map((member) => (
                <button
                  key={member.userId}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setText((current) =>
                      `${current.trimEnd()} @${member.displayName} `.trimStart(),
                    );
                    setPicked((current) =>
                      current.some((c) => c.userId === member.userId)
                        ? current
                        : [
                            ...current,
                            { userId: member.userId, displayName: member.displayName },
                          ],
                    );
                  }}
                  data-testid={`mention-${member.displayName}`}
                >
                  {member.displayName}
                </button>
              ))}
            </div>
            <span className="field__hint">
              一覧から選んだ名前だけが通知されます。手入力した名前はそのままの文字になります。
            </span>
          </div>
        )}

        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={sendMessage.isPending || text.trim() === ""}
            data-testid="send-message"
          >
            {sendMessage.isPending ? "送信中…" : "送信"}
          </button>
        </div>
      </form>

      {ambiguous.length > 0 && (
        <p className="alert alert--error alert--inline" data-testid="ambiguous-mention">
          「{ambiguous.join("」「")}
          」という名前のメンバーが複数います。どちらを指名したのか判断できないため、送信していません。
        </p>
      )}

      {sendMessage.isError && (
        <p className="alert alert--error alert--inline" data-testid="send-error">
          {errorMessage(sendMessage.error)}
        </p>
      )}
    </section>
  );
}
