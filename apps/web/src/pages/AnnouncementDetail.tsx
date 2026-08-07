import type { AnnouncementTarget } from "@atarimae/api-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { api, errorMessage } from "../api.js";

/**
 * Authoring and, once published, the acknowledgement result.
 *
 * The two halves of the screen answer the two questions an administrator
 * actually has: who is this going to, and who has read it.
 */
export function AnnouncementDetailPage() {
  const { announcementId = "" } = useParams();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["announcement", announcementId],
    queryFn: () => api.announcements.get(announcementId),
  });

  const orgUnits = useQuery({
    queryKey: ["org-units"],
    queryFn: () => api.orgUnits.list(),
  });
  const members = useQuery({ queryKey: ["users", {}], queryFn: () => api.users.list() });

  const published = detail.data?.status === "published";

  const statistics = useQuery({
    queryKey: ["announcement-statistics", announcementId],
    queryFn: () => api.announcements.statistics(announcementId),
    enabled: published,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["announcement", announcementId] });
    void queryClient.invalidateQueries({
      queryKey: ["announcement-statistics", announcementId],
    });
    void queryClient.invalidateQueries({ queryKey: ["announcements"] });
  };

  const setTargets = useMutation({
    mutationFn: (targets: AnnouncementTarget[]) =>
      api.announcements.setTargets(announcementId, targets),
    onSuccess: (result) => {
      setNotice(`宛先を保存しました。現在 ${result.resolvedUserCount} 名が対象です。`);
      refresh();
    },
  });

  const publish = useMutation({
    mutationFn: () => api.announcements.publish(announcementId),
    onSuccess: (result) => {
      // The summary is shown rather than a bare "success": an administrator
      // must be able to see how many people were actually reached.
      setNotice(
        `${result.recipientsCreated}名に公開しました。` +
          `確認依頼 ${result.obligations.createdCount}件、` +
          `通知 ${result.notificationsQueued}件を送信キューに登録しました。`,
      );
      refresh();
    },
  });

  const setPersonalization = useMutation({
    mutationFn: (input: { userId: string; personalBody: string }) =>
      api.announcements.setPersonalization(
        announcementId,
        input.userId,
        input.personalBody,
      ),
    onSuccess: () => {
      setNotice("個人ごとの内容を保存しました。");
      refresh();
    },
  });

  if (detail.isPending) return <p className="page muted">読み込み中…</p>;
  if (detail.isError)
    return <p className="page alert alert--error">{errorMessage(detail.error)}</p>;

  const data = detail.data;
  const selected = new Set(
    data.targets.map((t) =>
      t.kind === "all"
        ? "all"
        : t.kind === "org_unit"
          ? `unit:${t.orgUnitId}`
          : `user:${t.userId}`,
    ),
  );

  function toggleTarget(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);

    const targets: AnnouncementTarget[] = [...next].map((entry) => {
      if (entry === "all") return { kind: "all" };
      const [kind, id] = entry.split(":");
      return kind === "unit"
        ? { kind: "org_unit", orgUnitId: id! }
        : { kind: "user", userId: id! };
    });

    if (targets.length === 0) {
      setNotice("宛先は1つ以上必要です。");
      return;
    }
    setTargets.mutate(targets);
  }

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title" data-testid="detail-title">
          {data.currentContent?.title ?? "(無題)"}
        </h1>
        <span className={`badge badge--${data.status}`} data-testid="detail-status">
          {data.status === "draft"
            ? "下書き"
            : data.status === "published"
              ? "公開中"
              : "アーカイブ"}
        </span>
      </div>

      {notice && (
        <p className="alert alert--info" role="status" data-testid="notice">
          {notice}
        </p>
      )}
      {(setTargets.isError || publish.isError || setPersonalization.isError) && (
        <p className="alert alert--error" role="alert" data-testid="detail-error">
          {errorMessage(setTargets.error ?? publish.error ?? setPersonalization.error)}
        </p>
      )}

      <section className="card">
        <h2 className="card__title">本文（全員共通）</h2>
        <p className="announcement__body">{data.currentContent?.body}</p>
      </section>

      {/* ------------------------------------------------------- targets -- */}
      <section className="card">
        <h2 className="card__title">宛先</h2>
        <p className="muted card__lead" data-testid="resolved-count">
          現在の宛先には {data.resolvedUserCount} 名が該当します。
        </p>

        <div className="chips">
          <button
            type="button"
            className={`chip ${selected.has("all") ? "chip--on" : ""}`}
            onClick={() => toggleTarget("all")}
            disabled={setTargets.isPending}
            data-testid="target-all"
          >
            全員
          </button>

          {orgUnits.data?.items.map((unit) => (
            <button
              key={unit.id}
              type="button"
              className={`chip ${selected.has(`unit:${unit.id}`) ? "chip--on" : ""}`}
              onClick={() => toggleTarget(`unit:${unit.id}`)}
              disabled={setTargets.isPending}
              data-testid={`target-unit-${unit.name}`}
            >
              {unit.name}（{unit.memberCount}名）
            </button>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------- personalization -- */}
      <section className="card">
        <h2 className="card__title">個人ごとの内容</h2>
        <p className="muted card__lead">
          全員共通の本文に加えて、一人ずつ別の指示を書けます。
          本人には共通の本文と自分の分だけが表示されます。
        </p>

        <ul className="list list--flush" data-testid="personalization-list">
          {members.data?.items.map((member) => (
            <PersonalizationRow
              key={member.id}
              name={member.displayName}
              email={member.email}
              busy={setPersonalization.isPending}
              onSave={(personalBody) =>
                setPersonalization.mutate({ userId: member.id, personalBody })
              }
            />
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------- publish -- */}
      {!published && (
        <section className="card">
          <h2 className="card__title">公開</h2>
          <p className="muted card__lead">
            公開すると、その時点の宛先が確定します。以降にメンバーが異動しても、
            この公告の確認率は変わりません。
          </p>
          <button
            type="button"
            className="button button--primary"
            onClick={() => publish.mutate()}
            disabled={publish.isPending || data.resolvedUserCount === 0}
            data-testid="publish"
          >
            {publish.isPending ? "公開中…" : `${data.resolvedUserCount}名に公開する`}
          </button>
          {data.resolvedUserCount === 0 && (
            <p className="field__hint">
              宛先に有効なメンバーがいないため公開できません。
            </p>
          )}
        </section>
      )}

      {/* ---------------------------------------------------- statistics -- */}
      {published && statistics.data && (
        <section className="card">
          <h2 className="card__title">確認状況</h2>

          <p className="stat" data-testid="ack-rate">
            {statistics.data.acknowledgedCount}
            <span className="stat__unit">
              / {statistics.data.obligationCount} 名が確認済み
            </span>
          </p>

          {statistics.data.waivedCount > 0 && (
            <p className="muted">
              {statistics.data.waivedCount}名は確認免除のため、分母に含まれていません。
            </p>
          )}

          <div className="grid">
            <div>
              <h3 className="section__title">確認済み</h3>
              <ul className="list list--flush" data-testid="acknowledged-list">
                {statistics.data.acknowledgedUsers.map((user) => (
                  <li key={user.userId} className="list__item">
                    <span className="list__title">{user.displayName}</span>
                    <span className="list__meta">
                      {formatDateTime(user.acknowledgedAt)}
                    </span>
                  </li>
                ))}
                {statistics.data.acknowledgedUsers.length === 0 && (
                  <li className="list__item muted">まだ誰も確認していません。</li>
                )}
              </ul>
            </div>

            <div>
              <h3 className="section__title">未確認</h3>
              <ul className="list list--flush" data-testid="pending-list">
                {statistics.data.pendingUsers.map((user) => (
                  <li key={user.userId} className="list__item">
                    <span className="list__title">{user.displayName}</span>
                    {user.dueAt && (
                      <span className="list__meta">
                        期限 {formatDateTime(user.dueAt)}
                      </span>
                    )}
                  </li>
                ))}
                {statistics.data.pendingUsers.length === 0 && (
                  <li className="list__item muted">全員が確認済みです。</li>
                )}
              </ul>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function PersonalizationRow({
  name,
  email,
  busy,
  onSave,
}: {
  name: string;
  email: string;
  busy: boolean;
  onSave: (personalBody: string) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <li className="list__item">
      <div className="list__main">
        <span className="list__title">{name}</span>
        <span className="list__meta">{email}</span>
      </div>
      <div className="list__actions list__actions--grow">
        <input
          className="field__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="この人だけへの指示"
          data-testid={`personal-input-${email}`}
        />
        <button
          type="button"
          className="button button--quiet"
          onClick={() => onSave(draft)}
          disabled={busy || draft.trim() === ""}
          data-testid={`personal-save-${email}`}
        >
          保存
        </button>
      </div>
    </li>
  );
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}
