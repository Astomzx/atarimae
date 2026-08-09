import { useMutation, useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";

import { api } from "../api.js";
import { hasAtLeast, ROLE_LABEL, useSession } from "../auth.js";
import { chatKeys } from "../chat/keys.js";
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
  useRealtime();

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

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
