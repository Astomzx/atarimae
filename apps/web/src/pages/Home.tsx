import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { hasAtLeast, ROLE_LABEL, useSession } from "../auth.js";

export function HomePage() {
  const { user } = useSession();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const members = useQuery({ queryKey: ["users", {}], queryFn: () => api.users.list() });
  const mine = useQuery({
    queryKey: ["my-announcements"],
    queryFn: api.my.announcements,
  });

  const pending = (mine.data?.items ?? []).filter(
    (item) => item.requiresAcknowledgement && !item.acknowledgedAt,
  );

  const isAdmin = user ? hasAtLeast(user.role, "admin") : false;

  return (
    <div className="page">
      <h1 className="page__title">ホーム</h1>
      <p className="muted">
        {user?.displayName} さん（{user ? ROLE_LABEL[user.role] : ""}）
      </p>

      {/* The first thing anybody needs to know: what is waiting on them. */}
      <section className="card">
        <h2 className="card__title">確認が必要なお知らせ</h2>

        {mine.isPending && <p className="muted">読み込み中…</p>}

        {mine.isSuccess && pending.length === 0 && (
          <p className="muted" data-testid="no-pending">
            確認が必要なお知らせはありません。
          </p>
        )}

        {pending.length > 0 && (
          <>
            <p className="stat" data-testid="pending-count">
              {pending.length}
              <span className="stat__unit">件</span>
            </p>
            <ul className="list list--flush">
              {pending.slice(0, 3).map((item) => (
                <li key={item.id} className="list__item">
                  <span className="list__title">{item.title}</span>
                  {item.dueAt && (
                    <span className="list__meta">
                      期限{" "}
                      {new Intl.DateTimeFormat("ja-JP", {
                        dateStyle: "short",
                        timeStyle: "short",
                      }).format(new Date(item.dueAt))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <Link to="/my/announcements" className="button button--primary">
              確認する
            </Link>
          </>
        )}
      </section>

      <div className="grid">
        <section className="card">
          <h2 className="card__title">メンバー</h2>
          <p className="stat" data-testid="member-count">
            {members.data?.items.length ?? "—"}
            <span className="stat__unit">名</span>
          </p>
          <Link to="/members" className="button button--quiet">
            メンバーを見る
          </Link>
        </section>

        {isAdmin && (
          <section className="card">
            <h2 className="card__title">管理</h2>
            <p className="muted card__lead">
              管理者は、営業担当に連絡することなく管理者を追加できます。
            </p>
            <Link
              to="/announcements"
              className="button button--primary"
              data-testid="home-create-announcement"
            >
              公告を作成
            </Link>
          </section>
        )}

        <section className="card">
          <h2 className="card__title">システム状態</h2>
          <dl className="status-list">
            <div className="status-list__row">
              <dt>サーバー</dt>
              <dd
                data-testid="health-status"
                className={
                  health.isSuccess ? "status status--ok" : "status status--error"
                }
              >
                {health.isPending
                  ? "確認中…"
                  : health.isSuccess
                    ? "正常"
                    : "接続できません"}
              </dd>
            </div>
            <div className="status-list__row">
              <dt>データベース</dt>
              <dd
                data-testid="health-database"
                className={
                  health.data?.checks.database === "ok"
                    ? "status status--ok"
                    : "status status--error"
                }
              >
                {health.data?.checks.database === "ok" ? "接続済み" : "—"}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
