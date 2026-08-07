import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, errorMessage } from "../api.js";

/**
 * A user manages their own sessions.
 *
 * Signing out a lost phone should not require asking an administrator, and
 * revoking a session must not disturb the device record or its notification
 * settings — those are separate concerns.
 */
export function SessionsPage() {
  const queryClient = useQueryClient();

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: api.auth.sessions,
  });

  const revoke = useMutation({
    mutationFn: api.auth.revokeSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });

  return (
    <div className="page">
      <h1 className="page__title">ログイン端末</h1>
      <p className="muted">
        現在ログイン中の端末の一覧です。管理者に依頼しなくても、自分で解除できます。
      </p>

      {sessions.isPending && <p className="muted">読み込み中…</p>}
      {revoke.isError && (
        <p className="alert alert--error">{errorMessage(revoke.error)}</p>
      )}

      <ul className="list" data-testid="session-list">
        {sessions.data?.items.map((session) => (
          <li key={session.id} className="list__item">
            <div className="list__main">
              <span className="list__title">
                {session.deviceName ?? "不明な端末"}
                {session.current && (
                  <span className="badge badge--current">この端末</span>
                )}
              </span>
              <span className="list__meta">
                最終利用 {formatDateTime(session.lastSeenAt)}
                {session.ipAddress && ` ・ ${session.ipAddress}`}
              </span>
            </div>

            {!session.current && (
              <div className="list__actions">
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => revoke.mutate(session.id)}
                  disabled={revoke.isPending}
                >
                  ログアウトさせる
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Timestamps cross the API as UTC; the browser renders them locally. */
function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}
