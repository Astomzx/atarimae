import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, errorMessage } from "../api.js";
import { currentState, disablePush, enablePush, type PushState } from "../push.js";

/**
 * Notifications for *this* device.
 *
 * On the device page rather than in a global settings screen because that is
 * what it is: permission is granted per browser, so the same account can have
 * it on for a phone and off for the office PC — which is usually what somebody
 * actually wants.
 *
 * Each state gets its own sentence. "有効にできませんでした" for all of them
 * would leave somebody pressing a button that cannot work: a refusal has to be
 * undone in browser settings, and iOS Safari cannot do this at all unless the
 * application has been added to the home screen.
 */
function PushSection() {
  const queryClient = useQueryClient();

  const state = useQuery<PushState>({
    queryKey: ["push-state"],
    queryFn: currentState,
  });

  const change = useMutation({
    mutationFn: (next: "on" | "off") => (next === "on" ? enablePush() : disablePush()),
    onSuccess: (result) => queryClient.setQueryData(["push-state"], result),
  });

  const kind = state.data?.kind;

  return (
    <section className="card" data-testid="push-section">
      <h2 className="card__title">通知</h2>

      {state.isPending && <p className="muted">確認中…</p>}

      {kind === "unsupported" && (
        <p className="muted" data-testid="push-unsupported">
          この端末では通知を受け取れません。iPhone や iPad
          の場合は、ホーム画面に追加すると使えるようになります。
        </p>
      )}

      {kind === "unavailable" && (
        <p className="muted" data-testid="push-unavailable">
          サーバー側で通知の準備ができていません。管理者にお問い合わせください。
        </p>
      )}

      {kind === "denied" && (
        <p className="muted" data-testid="push-denied">
          この端末では通知が拒否されています。ブラウザの設定から許可し直してください。
          このページからは再度お願いできません。
        </p>
      )}

      {kind === "available" && (
        <>
          <p className="muted">
            確認が必要なお知らせが届いたときに、この端末へ通知します。通知には件名だけが
            表示され、本文は含まれません。
          </p>
          <button
            type="button"
            className="button"
            data-testid="push-enable"
            disabled={change.isPending}
            onClick={() => change.mutate("on")}
          >
            この端末で通知を受け取る
          </button>
        </>
      )}

      {kind === "subscribed" && (
        <>
          <p className="muted" data-testid="push-subscribed">
            この端末で通知を受け取ります。
          </p>
          <button
            type="button"
            className="button button--secondary"
            data-testid="push-disable"
            disabled={change.isPending}
            onClick={() => change.mutate("off")}
          >
            通知を止める
          </button>
        </>
      )}

      {change.isError && (
        <p className="alert alert--error">{errorMessage(change.error)}</p>
      )}
    </section>
  );
}

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

      <PushSection />

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
