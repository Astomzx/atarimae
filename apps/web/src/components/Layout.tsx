import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { api } from "../api.js";
import { hasAtLeast, ROLE_LABEL, useSession } from "../auth.js";
import { chatKeys, type IncomingCall } from "../chat/keys.js";
import { useEnterCall } from "../chat/useEnterCall.js";
import { useRealtime } from "../chat/useRealtime.js";

/**
 * The same navigation at every width.
 *
 * There is no phone-only subset and no desktop-only feature: a rule the project
 * states plainly, and the easiest one to break by accident. Anything hidden on
 * small screens would have to be hidden for a reason other than "it did not
 * fit".
 */
export function Layout() {
  const { user } = useSession();

  /**
   * The socket is opened here, once, for as long as somebody is signed in —
   * not per page. Opening it inside the chat screens would mean a message
   * arriving while you are reading an announcement is never noticed, and the
   * unread badge below would be wrong exactly when it matters.
   */
  useRealtime(user?.id ?? null);

  const channels = useQuery({
    queryKey: chatKeys.channels(),
    queryFn: api.chat.channels,
  });

  const joined = (channels.data?.items ?? []).filter((channel) => channel.isMember);
  const unread = joined.reduce((total, channel) => total + channel.unreadCount, 0);
  const mentioned = joined.some((channel) => channel.hasMention);

  const logout = useMutation({
    mutationFn: api.auth.logout,
    /**
     * A full page load, not a client-side navigation.
     *
     * Clearing the query cache and calling navigate() leaves already-mounted
     * components holding their last render, so the previous user's name and
     * member list stay on screen after the cookie is gone — it looks like
     * sign-out failed. Reloading also guarantees nothing from the previous
     * session survives in memory, which matters on a shared machine.
     */
    onSettled: () => {
      window.location.assign("/login");
    },
  });

  const isAdmin = user ? hasAtLeast(user.role, "admin") : false;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <NavLink to="/" className="topbar__brand">
            Atarimae
          </NavLink>

          <nav className="nav" aria-label="メインナビゲーション">
            <NavLink to="/" end className="nav__link">
              ホーム
            </NavLink>
            <NavLink to="/my/announcements" className="nav__link">
              お知らせ
            </NavLink>
            {isAdmin && (
              <NavLink to="/announcements" className="nav__link">
                公告管理
              </NavLink>
            )}
            <NavLink to="/chat" className="nav__link">
              チャット
              {unread > 0 && (
                <span
                  className={`badge badge--unread${mentioned ? " badge--mention" : ""}`}
                  data-testid="nav-unread"
                >
                  {unread}
                </span>
              )}
            </NavLink>
            <NavLink to="/members" className="nav__link">
              メンバー
            </NavLink>
            {isAdmin && (
              <NavLink to="/org-units" className="nav__link">
                部署
              </NavLink>
            )}
            {isAdmin && (
              <NavLink to="/service-accounts" className="nav__link">
                連携
              </NavLink>
            )}
            <NavLink to="/sessions" className="nav__link">
              ログイン端末
            </NavLink>
          </nav>

          <div className="topbar__user">
            {user && (
              <span className="topbar__identity" data-testid="current-user">
                {user.displayName}
                <span className="badge badge--role">{ROLE_LABEL[user.role]}</span>
              </span>
            )}
            <button
              type="button"
              className="button button--quiet"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              data-testid="logout"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      <IncomingCallBanner />

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Somebody is calling, and they are waiting for an answer now.
 *
 * At the top of every screen rather than inside the chat pages: a call you
 * only find out about by having the right conversation open is not a call.
 * Dismissing it stops the ringing here and does nothing to the call itself —
 * the others carry on, and it can still be joined from the channel.
 */
function IncomingCallBanner() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const enter = useEnterCall();

  const { data: incoming } = useQuery<IncomingCall | null>({
    queryKey: chatKeys.incomingCall(),
    // Never fetched: the socket writes it, and these two say so.
    queryFn: () => null,
    enabled: false,
    initialData: null,
  });

  if (!incoming) return null;

  const dismiss = () =>
    queryClient.setQueryData<IncomingCall | null>(chatKeys.incomingCall(), null);

  return (
    <div className="ringing" role="alert" data-testid="incoming-call">
      <span className="ringing__text">
        <strong>{incoming.startedByName}</strong> さんが通話を開始しました
      </span>
      <span className="ringing__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            // Actually joins, and then shows the conversation it is in. A
            // button that says 参加する and only navigates somewhere is a
            // button that lies — they pressed it to be in the call.
            enter.mutate(
              { channelId: incoming.channelId, callId: incoming.callId },
              {
                onSettled: () => {
                  dismiss();
                  void navigate(`/chat/${incoming.channelId}`);
                },
              },
            );
          }}
          disabled={enter.isPending}
          data-testid="answer-call"
        >
          {enter.isPending ? "接続中…" : "参加する"}
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={dismiss}
          data-testid="dismiss-call"
        >
          閉じる
        </button>
      </span>
    </div>
  );
}
