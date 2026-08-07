import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api } from "../api.js";
import { hasAtLeast, ROLE_LABEL, useSession } from "../auth.js";

export function HomePage() {
  const { user } = useSession();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const members = useQuery({ queryKey: ["users", {}], queryFn: () => api.users.list() });

  const isAdmin = user ? hasAtLeast(user.role, "admin") : false;

  return (
    <div className="page">
      <h1 className="page__title">ホーム</h1>
      <p className="muted">
        {user?.displayName} さん（{user ? ROLE_LABEL[user.role] : ""}）
      </p>

      {/* M2 replaces this with announcements requiring acknowledgement. */}
      <section className="card">
        <h2 className="card__title">お知らせ</h2>
        <p className="muted">
          掲示板機能は M2 で追加されます。現在はアカウントと組織の管理のみ利用できます。
        </p>
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
              to="/members"
              className="button button--primary"
              data-testid="home-add-member"
            >
              メンバーを追加
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
