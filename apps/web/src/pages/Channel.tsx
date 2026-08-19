import type {
  ChannelMember,
  Message,
  UploadAttachmentResponse,
} from "@atarimae/api-schema";
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
  formatBytes,
  formatDay,
  formatTime,
  isSameLocalDay,
  newestMessageId,
  parseBody,
  type MentionCandidate,
  type MessagePages,
} from "../chat/format.js";
import { CALL_FRAME_ALLOW } from "../chat/callRoom.js";
import { chatKeys, type ActiveRoom } from "../chat/keys.js";
import { useEnterCall } from "../chat/useEnterCall.js";

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

      {channel?.isMember && <CallPanel channelId={channelId} />}

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

/**
 * 通話 — a call in this conversation.
 *
 * Atarimae is still not carrying the audio. The room is either a window of its
 * own or a frame here, and which one is the administrator's answer about their
 * provider — nothing about this changes what Atarimae holds. A frame is not an
 * SDK: no third-party script runs on this origin, which is why `script-src`
 * did not have to move to allow it.
 */
function CallPanel({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [error, setError] = useState<string | null>(null);

  const calls = useQuery({
    queryKey: chatKeys.calls(channelId),
    queryFn: () => api.calls.inChannel(channelId),
  });

  /**
   * The room this person is in, when it is shown here rather than in a window.
   *
   * Written by the enter-call hook — which the banner at the top of every
   * screen also uses — and never fetched, the same arrangement as the ringing
   * call itself.
   */
  const { data: room } = useQuery<ActiveRoom | null>({
    queryKey: chatKeys.activeRoom(),
    queryFn: () => null,
    enabled: false,
    initialData: null,
  });

  const live = calls.data?.items.find((call) => call.endedAt === null) ?? null;
  const past = (calls.data?.items ?? []).filter((call) => call.endedAt !== null);

  /**
   * Whether this person is on the call right now.
   *
   * Without a way to leave, the last participant never leaves — and since one
   * channel may hold only one live call, the conversation is stuck showing
   * 通話中 with nobody in it and no way to start another.
   */
  const onTheCall =
    live?.participants.some((p) => p.userId === user?.id && p.leftAt === null) ?? false;

  /**
   * Shown only for the call that is actually running here.
   *
   * Both halves matter. Without the channel check a room started in another
   * conversation would appear in this one; without the live check the frame
   * would sit there after everybody left, which is a meeting room that looks
   * open and is not.
   */
  const activeRoom =
    room && live && room.callId === live.id && room.channelId === channelId ? room : null;

  const closeRoom = () =>
    queryClient.setQueryData<ActiveRoom | null>(chatKeys.activeRoom(), null);

  /**
   * The one framing failure a browser will actually tell you about.
   *
   * `Content-Security-Policy` travels with the document, so a page loaded
   * before an administrator marked the provider embeddable is still enforcing
   * the old `frame-src` — the server says yes, this browser refuses, and the
   * panel is blank. That refusal fires `securitypolicyviolation`, unlike the
   * provider's own `X-Frame-Options`, which fires nothing at all.
   *
   * So the detectable half is handled: the room falls back to a link, and the
   * person gets something that works instead of a rectangle that does not.
   */
  useEffect(() => {
    if (!activeRoom?.embed) return;

    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (!event.violatedDirective.startsWith("frame-src")) return;
      queryClient.setQueryData<ActiveRoom>(chatKeys.activeRoom(), {
        ...activeRoom,
        embed: false,
      });
    };

    document.addEventListener("securitypolicyviolation", onViolation);
    return () => document.removeEventListener("securitypolicyviolation", onViolation);
  }, [activeRoom, queryClient]);

  const leave = useMutation({
    mutationFn: (callId: string) => api.calls.leave(callId),
    onSuccess: async () => {
      closeRoom();
      await queryClient.invalidateQueries({ queryKey: chatKeys.calls(channelId) });
    },
  });

  const enter = useEnterCall();

  const go = (callId?: string) => {
    setError(null);
    enter.mutate(
      { channelId, ...(callId ? { callId } : {}) },
      { onError: (failure) => setError(errorMessage(failure)) },
    );
  };

  return (
    <section className="call-panel">
      {live ? (
        <div className="call-panel__live" data-testid="live-call">
          <span className="call-panel__label">
            通話中 ・ {live.participants.filter((p) => p.leftAt === null).length} 名
          </span>
          <button
            type="button"
            className="button button--primary"
            onClick={() => go(live.id)}
            disabled={enter.isPending}
            data-testid="join-call"
          >
            {onTheCall ? "通話に戻る" : "通話に参加"}
          </button>
          {onTheCall && (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => leave.mutate(live.id)}
              disabled={leave.isPending}
              data-testid="leave-call"
            >
              退出
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="button"
          onClick={() => go()}
          disabled={enter.isPending}
          data-testid="start-call"
        >
          {enter.isPending ? "接続中…" : "通話を開始"}
        </button>
      )}

      {error && (
        <p className="alert alert--error alert--inline" data-testid="call-error">
          {error}
        </p>
      )}

      {/*
       * The room, in the conversation.
       *
       * `allow` is not decoration: the response header delegates camera and
       * microphone to the provider's origin, and this is the frame asking for
       * what was delegated. One without the other is a meeting room that loads
       * and cannot hear anybody.
       */}
      {activeRoom?.embed && (
        <div className="call-room" data-testid="call-room">
          <iframe
            className="call-room__frame"
            src={activeRoom.joinUrl}
            allow={CALL_FRAME_ALLOW}
            title="通話"
            data-testid="call-frame"
          />
          <p className="call-room__note muted">
            {/*
             * Whose page this is, said plainly. The media belongs to the
             * provider, and a frame is exactly the place somebody could stop
             * being able to tell.
             */}
            通話画面は {hostOf(activeRoom.joinUrl)} のものです。
            {/*
             * A browser gives no way to know whether the provider refused to
             * be framed, so an empty panel is possible and has to have an exit.
             */}
            <a
              className="call-room__out"
              href={activeRoom.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="open-call-window"
            >
              別の窓で開く
            </a>
          </p>
          <p className="call-room__note muted">
            会話を移動すると、この画面は閉じます。通話に戻ることはできます。
          </p>
        </div>
      )}

      {/*
       * Embedding was expected and the server said no — the provider was
       * changed or stopped while this page was open. There is no window handle
       * left and one cannot be opened without a fresh press, so the room is
       * offered as something to press rather than by taking this tab there.
       */}
      {activeRoom && !activeRoom.embed && (
        <p className="alert alert--inline" data-testid="call-link">
          <a href={activeRoom.joinUrl} target="_blank" rel="noopener noreferrer">
            通話の画面を開く
          </a>
        </p>
      )}

      {/*
       * The history. Who joined is the difference between a call that happened
       * and one that rang out, and that is the thing anybody wants to know
       * afterwards.
       */}
      {past.length > 0 && (
        <ul className="list list--flush" data-testid="call-history">
          {past.slice(0, 5).map((call) => (
            <li key={call.id} className="list__item">
              <div className="list__main">
                <span className="list__meta">
                  {formatTime(call.startedAt)} ・{" "}
                  {call.participants.length > 1
                    ? `${call.participants.length} 名が参加`
                    : "応答なし"}
                  {call.endedAt && ` ・ ${callDuration(call.startedAt, call.endedAt)}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The provider's host, for saying whose page is in the frame.
 *
 * Falls back to nothing rather than throwing: a malformed join URL is the
 * provider's problem, and it must not take the whole conversation down with it.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "通話サービス";
  }
}

function callDuration(startedAt: string, endedAt: string): string {
  const seconds = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
  );

  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分`;
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

        {message.attachments.length > 0 && (
          <ul className="chat__attachments" data-testid="message-attachments">
            {message.attachments.map((attachment) => (
              <li key={attachment.id} className="chat__attachment">
                {attachment.inline ? (
                  /*
                   * Only formats whose bytes the server verified are shown
                   * this way, and SVG is not one of them — it is not accepted
                   * at all, because an image that can carry script is not an
                   * image.
                   */
                  <a href={attachment.url} target="_blank" rel="noreferrer">
                    <img
                      className="chat__image"
                      src={attachment.url}
                      alt={attachment.name}
                      loading="lazy"
                    />
                  </a>
                ) : null}
                <a
                  className="chat__attachment-link"
                  href={attachment.url}
                  download={attachment.name}
                  data-testid="attachment-link"
                >
                  {attachment.name}
                  <span className="chat__attachment-size">
                    {formatBytes(attachment.byteSize)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
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
  const [attached, setAttached] = useState<UploadAttachmentResponse[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * The file starts moving as soon as it is chosen, rather than when the
   * message is sent. A file that is too large or of a kind that cannot be
   * attached is refused while there is still something to do about it — not
   * after the message has been written.
   */
  const uploadFile = useMutation({
    mutationFn: (file: File) => api.chat.uploadAttachment(channelId, file),
    onSuccess: (attachment) => setAttached((current) => [...current, attachment]),
  });

  const sendMessage = useMutation({
    mutationFn: (body: string) =>
      api.chat.sendMessage(channelId, {
        body,
        ...(replyTo ? { replyToId: replyTo.id } : {}),
        ...(attached.length > 0 ? { attachmentIds: attached.map((a) => a.id) } : {}),
      }),
    onSuccess: async (message) => {
      setText("");
      setPicked([]);
      setAttached([]);
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
    // A file with no words is still a message worth sending, but the server
    // requires a body — so an attachment alone carries its own filename.
    const body = trimmed === "" && attached.length > 0 ? attached[0]!.name : trimmed;
    if (body === "") return;

    const encoded = encodeMentions(body, picked);

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

        <div className="field">
          <span className="field__label">ファイルを添付</span>
          <input
            ref={fileInput}
            type="file"
            className="field__input"
            multiple
            disabled={uploadFile.isPending}
            onChange={(event) => {
              // Uploaded one at a time so a rejected file names itself rather
              // than failing a batch with no indication of which one.
              for (const file of event.target.files ?? []) uploadFile.mutate(file);
              // Cleared so choosing the same file twice still fires.
              if (fileInput.current) fileInput.current.value = "";
            }}
            data-testid="attach-file"
          />
          <span className="field__hint">
            1つあたり25MBまで。PDF・画像・Office 文書・CSV などに対応しています。
          </span>
        </div>

        {uploadFile.isPending && (
          <p className="muted" data-testid="uploading">
            アップロード中…
          </p>
        )}

        {attached.length > 0 && (
          <ul className="chat__pending" data-testid="pending-attachments">
            {attached.map((attachment) => (
              <li key={attachment.id} className="chat__pending-item">
                <span className="chat__pending-name">{attachment.name}</span>
                <span className="chat__attachment-size">
                  {formatBytes(attachment.byteSize)}
                </span>
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() =>
                    setAttached((current) =>
                      current.filter((a) => a.id !== attachment.id),
                    )
                  }
                  data-testid={`remove-attachment-${attachment.name}`}
                >
                  取り消す
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={
              sendMessage.isPending ||
              uploadFile.isPending ||
              (text.trim() === "" && attached.length === 0)
            }
            data-testid="send-message"
          >
            {sendMessage.isPending ? "送信中…" : "送信"}
          </button>
        </div>
      </form>

      {uploadFile.isError && (
        <p className="alert alert--error alert--inline" data-testid="upload-error">
          {errorMessage(uploadFile.error)}
        </p>
      )}

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
