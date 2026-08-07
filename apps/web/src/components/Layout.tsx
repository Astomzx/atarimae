import { useMutation } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";

import { api } from "../api.js";
import { hasAtLeast, ROLE_LABEL, useSession } from "../auth.js";

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
            <NavLink to="/members" className="nav__link">
              メンバー
            </NavLink>
            {isAdmin && (
              <NavLink to="/org-units" className="nav__link">
                部署
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
