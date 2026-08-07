import type { MyAnnouncement } from "@atarimae/api-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, errorMessage } from "../api.js";

/**
 * What a recipient actually sees: the shared body, and — if there is one — the
 * paragraph written for them personally.
 *
 * Acknowledging confirms that exact combination. The obligation records which
 * body revision and which personal revision were shown, so "what did they
 * actually agree to" stays answerable later.
 */
export function MyAnnouncementsPage() {
  const queryClient = useQueryClient();

  const announcements = useQuery({
    queryKey: ["my-announcements"],
    queryFn: api.my.announcements,
  });

  const acknowledge = useMutation({
    mutationFn: api.my.acknowledge,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-announcements"] }),
  });

  const items = announcements.data?.items ?? [];
  const pending = items.filter((a) => a.requiresAcknowledgement && !a.acknowledgedAt);
  const rest = items.filter((a) => !pending.includes(a));

  return (
    <div className="page">
      <h1 className="page__title">お知らせ</h1>

      {announcements.isPending && <p className="muted">読み込み中…</p>}

      {items.length === 0 && !announcements.isPending && (
        <p className="muted">現在、あなた宛てのお知らせはありません。</p>
      )}

      {pending.length > 0 && (
        <section>
          <h2 className="section__title" data-testid="pending-heading">
            確認が必要（{pending.length}件）
          </h2>
          {pending.map((item) => (
            <AnnouncementCard
              key={item.id}
              item={item}
              onAcknowledge={() => acknowledge.mutate(item.id)}
              busy={acknowledge.isPending}
              error={acknowledge.isError ? errorMessage(acknowledge.error) : null}
            />
          ))}
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h2 className="section__title">その他</h2>
          {rest.map((item) => (
            <AnnouncementCard key={item.id} item={item} />
          ))}
        </section>
      )}
    </div>
  );
}

function AnnouncementCard({
  item,
  onAcknowledge,
  busy,
  error,
}: {
  item: MyAnnouncement;
  onAcknowledge?: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const acknowledged = item.acknowledgedAt !== null;

  return (
    <article className="card" data-testid="announcement-card">
      <h3 className="card__title" data-testid="announcement-title">
        {item.title}
      </h3>

      <p className="announcement__body">{item.body}</p>

      {/* The paragraph that belongs only to this reader. */}
      {item.personalBody && (
        <div className="announcement__personal" data-testid="personal-body">
          <span className="announcement__personal-label">あなたの担当</span>
          <p className="announcement__personal-text">{item.personalBody}</p>
        </div>
      )}

      <footer className="announcement__footer">
        {item.dueAt && !acknowledged && (
          <span className="muted">期限 {formatDateTime(item.dueAt)}</span>
        )}

        {acknowledged ? (
          <span className="status status--ok" data-testid="acknowledged-at">
            確認済み {formatDateTime(item.acknowledgedAt!)}
          </span>
        ) : (
          item.requiresAcknowledgement &&
          onAcknowledge && (
            <button
              type="button"
              className="button button--primary"
              onClick={onAcknowledge}
              disabled={busy}
              data-testid="acknowledge"
            >
              {busy ? "送信中…" : "確認しました"}
            </button>
          )
        )}
      </footer>

      {error && <p className="alert alert--error alert--inline">{error}</p>}
    </article>
  );
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}
