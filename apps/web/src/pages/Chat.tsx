import type { ChannelSummary } from "@atarimae/api-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, errorMessage } from "../api.js";
import { useSession } from "../auth.js";
import { useDirectory } from "../chat/directory.js";
import { channelTitle, previewBody } from "../chat/format.js";
import { chatKeys } from "../chat/keys.js";

/**
 * Everything this person can talk in: their conversations, the channels they
 * belong to, and the public channels they could join.
 *
 * One column at every width. A desktop-only sidebar and a phone-only list would
 * be two different products, and the second one always ends up missing
 * something.
 */
export function ChatPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const directory = useDirectory();

  const channels = useQuery({
    queryKey: chatKeys.channels(),
    queryFn: api.chat.channels,
  });

  const join = useMutation({
    mutationFn: api.chat.join,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.channels() }),
  });

  const items = channels.data?.items ?? [];
  const mine = items.filter((channel) => channel.isMember || channel.canModerate);
  const discoverable = items.filter(
    (channel) => !channel.isMember && !channel.canModerate,
  );

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">チャット</h1>
      </div>

      <NewConversation
        onOpened={(channelId) => {
          void navigate(`/chat/${channelId}`);
        }}
      />

      <NewChannel
        onCreated={(channelId) => {
          void navigate(`/chat/${channelId}`);
        }}
      />

      {channels.isPending && <p className="muted">読み込み中…</p>}
      {channels.isError && (
        <p className="alert alert--error">{errorMessage(channels.error)}</p>
      )}

      {channels.isSuccess && mine.length === 0 && (
        <p className="muted" data-testid="no-channels">
          参加しているチャンネルはまだありません。
        </p>
      )}

      {mine.length > 0 && (
        <>
          <h2 className="section__title">参加中</h2>
          <ul className="list" data-testid="channel-list">
            {mine.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} directory={directory} />
            ))}
          </ul>
        </>
      )}

      {discoverable.length > 0 && (
        <>
          <h2 className="section__title">参加していない公開チャンネル</h2>
          <ul className="list" data-testid="public-channel-list">
            {discoverable.map((channel) => (
              <li key={channel.id} className="list__item">
                <div className="list__main">
                  {/*
                   * Readable before joining: a public channel you have to join
                   * to find out what is in it is not discoverable, it is a
                   * door with no window.
                   */}
                  <Link to={`/chat/${channel.id}`} className="list__title">
                    <span className="channel__hash" aria-hidden="true">
                      #
                    </span>
                    {channelTitle(channel)}
                  </Link>
                  {channel.description && (
                    <span className="list__meta">{channel.description}</span>
                  )}
                  <span className="list__meta">{channel.memberCount} 名</span>
                </div>
                <div className="list__actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => join.mutate(channel.id)}
                    disabled={join.isPending}
                    data-testid={`join-${channelTitle(channel)}`}
                  >
                    参加
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {join.isError && <p className="alert alert--error">{errorMessage(join.error)}</p>}
    </div>
  );
}

function ChannelRow({
  channel,
  directory,
}: {
  channel: ChannelSummary;
  directory: ReadonlyMap<string, string>;
}) {
  const title = channelTitle(channel);

  return (
    <li className="list__item" data-testid={`channel-row-${title}`}>
      <div className="list__main">
        <Link to={`/chat/${channel.id}`} className="list__title">
          {channel.kind === "direct" ? (
            <span className="channel__hash" aria-hidden="true">
              @
            </span>
          ) : (
            <span className="channel__hash" aria-hidden="true">
              #
            </span>
          )}
          {title}
        </Link>
        {channel.lastMessagePreview && (
          <span className="list__meta channel__preview">
            {previewBody(channel.lastMessagePreview, directory)}
          </span>
        )}
      </div>

      <div className="list__actions">
        {/*
         * A mention is louder than a count on purpose: "there are 40 new
         * messages" and "one of them is addressed to you" are different
         * questions, and only the second one interrupts a working day.
         */}
        {channel.hasMention && (
          <span className="badge badge--mention" data-testid={`mention-${title}`}>
            @あなた
          </span>
        )}
        {channel.unreadCount > 0 && (
          <span className="badge badge--unread" data-testid={`unread-${title}`}>
            {channel.unreadCount}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Starting a conversation with somebody.
 *
 * The endpoint is idempotent, so picking the same person twice reopens the one
 * conversation rather than creating a second one holding half the history.
 */
function NewConversation({ onOpened }: { onOpened: (channelId: string) => void }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const members = useQuery({
    queryKey: ["users", {}],
    queryFn: () => api.users.list(),
    enabled: open,
  });

  const openDirect = useMutation({
    mutationFn: api.chat.openDirect,
    /**
     * The list is refreshed before the conversation is opened, not after.
     *
     * The screen this navigates to finds its channel in the cached channel
     * list, and a conversation that did not exist a moment ago is not in it —
     * so it rendered with no channel at all and fell back to calling the
     * heading 会話 instead of naming the person. It corrected itself whenever
     * something else happened to refetch, which is why it looked intermittent.
     */
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.channels() });
      onOpened(result.id);
    },
  });

  const others = (members.data?.items ?? []).filter(
    (member) => member.id !== user?.id && member.disabledAt === null,
  );

  if (!open) {
    return (
      <button
        type="button"
        className="button"
        onClick={() => setOpen(true)}
        data-testid="toggle-new-conversation"
      >
        会話を始める
      </button>
    );
  }

  return (
    <section className="card">
      <h2 className="card__title">会話を始める</h2>

      {members.isPending && <p className="muted">読み込み中…</p>}

      {members.isSuccess && others.length === 0 && (
        <p className="muted">他のメンバーがいません。</p>
      )}

      <div className="chips">
        {others.map((member) => (
          <button
            key={member.id}
            type="button"
            className="chip"
            onClick={() => openDirect.mutate(member.id)}
            disabled={openDirect.isPending}
            data-testid={`start-conversation-${member.email}`}
          >
            {member.displayName}
          </button>
        ))}
      </div>

      {openDirect.isError && (
        <p className="alert alert--error alert--inline">
          {errorMessage(openDirect.error)}
        </p>
      )}

      <p className="toggle">
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setOpen(false)}
        >
          閉じる
        </button>
      </p>
    </section>
  );
}

/**
 * Anyone may create a channel.
 *
 * Restricting this to administrators is how internal tools end up with a
 * support ticket for every new project group — the server takes the same view.
 */
function NewChannel({ onCreated }: { onCreated: (channelId: string) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);

  const create = useMutation({
    mutationFn: api.chat.createChannel,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.channels() });
      setName("");
      setDescription("");
      onCreated(result.id);
    },
  });

  if (!open) {
    return (
      <p className="toggle">
        <button
          type="button"
          className="button"
          onClick={() => setOpen(true)}
          data-testid="toggle-create-channel"
        >
          チャンネルを作成
        </button>
      </p>
    );
  }

  return (
    <section className="card">
      <h2 className="card__title">チャンネルを作成</h2>

      <form
        className="form form--grid"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({
            name: name.trim(),
            kind: isPrivate ? "private" : "public",
            ...(description.trim() ? { description: description.trim() } : {}),
          });
        }}
      >
        <label className="field">
          <span className="field__label">チャンネル名</span>
          <input
            className="field__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            data-testid="new-channel-name"
          />
        </label>

        <label className="field">
          <span className="field__label">説明（任意）</span>
          <input
            className="field__input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            data-testid="new-channel-description"
          />
        </label>

        <div className="form__actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(event) => setIsPrivate(event.target.checked)}
              data-testid="new-channel-private"
            />
            非公開にする（招待されたメンバーだけが読めます）
          </label>
        </div>

        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={create.isPending || name.trim() === ""}
            data-testid="create-channel-submit"
          >
            {create.isPending ? "作成中…" : "作成"}
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setOpen(false)}
          >
            閉じる
          </button>
        </div>
      </form>

      {create.isError && (
        <p
          className="alert alert--error alert--inline"
          data-testid="create-channel-error"
        >
          {errorMessage(create.error)}
        </p>
      )}
    </section>
  );
}
