import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { api, errorMessage } from "../api.js";

const STATUS_LABEL = {
  draft: "下書き",
  published: "公開中",
  archived: "アーカイブ",
} as const;

export function AnnouncementsPage() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);

  const announcements = useQuery({
    queryKey: ["announcements"],
    queryFn: api.announcements.list,
  });

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">公告</h1>
        <button
          type="button"
          className="button button--primary"
          onClick={() => setFormOpen((open) => !open)}
          data-testid="toggle-create-announcement"
        >
          {formOpen ? "閉じる" : "公告を作成"}
        </button>
      </div>

      {formOpen && (
        <CreateForm
          onCreated={() => {
            setFormOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["announcements"] });
          }}
        />
      )}

      {announcements.isPending && <p className="muted">読み込み中…</p>}

      <ul className="list" data-testid="announcement-list">
        {announcements.data?.items.map((item) => (
          <li key={item.id} className="list__item">
            <div className="list__main">
              <Link to={`/announcements/${item.id}`} className="list__title">
                {item.title}
              </Link>
              <span className="list__meta">
                {item.status === "published" && item.recipientCount !== null
                  ? `${item.recipientCount}名に配信`
                  : "未公開"}
                {item.requiresAcknowledgement && " ・ 確認必須"}
              </span>
            </div>
            <div className="list__actions">
              <span className={`badge badge--${item.status}`}>
                {STATUS_LABEL[item.status]}
              </span>
            </div>
          </li>
        ))}
        {announcements.data?.items.length === 0 && (
          <li className="list__item">
            <span className="muted">まだ公告がありません。</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(true);
  const [dueAt, setDueAt] = useState("");

  const create = useMutation({
    mutationFn: api.announcements.create,
    onSuccess: onCreated,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({
      title,
      body,
      requiresAcknowledgement,
      // datetime-local gives local time; the API takes UTC.
      ...(dueAt ? { acknowledgementDueAt: new Date(dueAt).toISOString() } : {}),
    });
  }

  return (
    <section className="card">
      <h2 className="card__title">公告を作成</h2>
      <p className="muted card__lead">
        作成した時点では下書きです。宛先を決めて公開するまで、誰にも表示されません。
      </p>

      <form onSubmit={submit} className="form">
        <label className="field">
          <span className="field__label">件名</span>
          <input
            className="field__input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="明日の予定"
            data-testid="new-announcement-title"
          />
        </label>

        <label className="field">
          <span className="field__label">本文（全員共通）</span>
          <textarea
            className="field__input field__input--multiline"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            rows={6}
            data-testid="new-announcement-body"
          />
          <span className="field__hint">
            個人ごとの指示は、作成後に一人ずつ追加できます。
          </span>
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={requiresAcknowledgement}
            onChange={(e) => setRequiresAcknowledgement(e.target.checked)}
            data-testid="new-announcement-requires-ack"
          />
          確認を必須にする
        </label>

        {requiresAcknowledgement && (
          <label className="field">
            <span className="field__label">確認期限（任意）</span>
            <input
              className="field__input"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              data-testid="new-announcement-due"
            />
          </label>
        )}

        {create.isError && (
          <p className="alert alert--error" role="alert">
            {errorMessage(create.error)}
          </p>
        )}

        <button
          type="submit"
          className="button button--primary"
          disabled={create.isPending}
          data-testid="create-announcement-submit"
        >
          {create.isPending ? "作成中…" : "下書きを作成"}
        </button>
      </form>
    </section>
  );
}
