import type { MyAnnouncement } from "@atarimae/api-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, cachedAt, errorMessage } from "../api.js";

/**
 * The fetch time, in words somebody can act on.
 *
 * An ISO string is not a time to a reader in a truck. Today shows a clock,
 * anything older shows a date as well — because "16:32" on a roster fetched
 * three days ago is exactly the misreading this label exists to prevent.
 */
function formatFetchedAt(iso: string): string {
  const fetched = new Date(iso);
  const sameDay = new Date().toDateString() === fetched.toDateString();

  return fetched.toLocaleString("ja-JP", {
    ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

  /*
   * The condition `docs/architecture/pwa.md` set for caching announcements at
   * all: cached content carries the time it was fetched, on screen, every
   * time. Read after the query settles, so it describes the answer being
   * rendered rather than the previous one.
   */
  const fetchedAt = announcements.isSuccess ? cachedAt("/my/announcements") : null;

  const items = announcements.data?.items ?? [];
  const pending = items.filter((a) => a.requiresAcknowledgement && !a.acknowledgedAt);
  const rest = items.filter((a) => !pending.includes(a));

  return (
    <div className="page">
      <h1 className="page__title">お知らせ</h1>

      {/*
        Not a badge and not a tooltip. Somebody reading a roster in a basement
        has to be told, without looking for it, that this is not live — the
        whole argument for showing it at all is that "yesterday's, clearly
        labelled" beats "nothing", and it only beats nothing while the label
        is impossible to miss.
      */}
      {fetchedAt && (
        <p className="alert alert--warning" data-testid="offline-snapshot">
          オフラインです。{formatFetchedAt(fetchedAt)}
          に取得した内容を表示しています。最新ではない可能性があります。
        </p>
      )}

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
