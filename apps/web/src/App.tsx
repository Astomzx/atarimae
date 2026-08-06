import { useQuery } from "@tanstack/react-query";

import { api } from "./api.js";

/**
 * M0 placeholder. Exists so the toolchain is proven end to end: the browser
 * reaches Vite, Vite proxies to Fastify, Fastify reaches PostgreSQL, and
 * Playwright can assert on the result.
 */
export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });

  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Atarimae</h1>
        <p className="shell__subtitle">当たり前のことが、当たり前にできる社内掲示板。</p>
      </header>

      <section className="card" aria-labelledby="status-heading">
        <h2 id="status-heading" className="card__title">
          システム状態
        </h2>

        {health.isPending && <p data-testid="health-status">確認中…</p>}

        {health.isError && (
          <p data-testid="health-status" className="status status--error">
            サーバーに接続できません
          </p>
        )}

        {health.isSuccess && (
          <dl className="status-list">
            <div className="status-list__row">
              <dt>サーバー</dt>
              <dd data-testid="health-status" className="status status--ok">
                正常
              </dd>
            </div>
            <div className="status-list__row">
              <dt>データベース</dt>
              <dd
                data-testid="health-database"
                className={
                  health.data.checks.database === "ok"
                    ? "status status--ok"
                    : "status status--error"
                }
              >
                {health.data.checks.database === "ok" ? "接続済み" : "エラー"}
              </dd>
            </div>
            <div className="status-list__row">
              <dt>バージョン</dt>
              <dd data-testid="health-version">{health.data.version}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}
