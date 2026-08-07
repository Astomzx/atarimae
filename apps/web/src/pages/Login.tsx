import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { api, errorMessage } from "../api.js";
import { useSession, useSetupStatus } from "../auth.js";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const queryClient = useQueryClient();
  const { user } = useSession();
  const status = useSetupStatus();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: api.auth.login,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      void navigate(location.state?.from ?? "/", { replace: true });
    },
  });

  // An organisation with no Owner has nothing to sign in to yet.
  if (status.data && !status.data.initialized) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to="/" replace />;

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password });
  }

  return (
    <div className="centered">
      <div className="centered__inner">
        <header className="brand">
          <h1 className="brand__name">Atarimae</h1>
          <p className="brand__tagline">当たり前のことが、当たり前にできる社内掲示板。</p>
        </header>

        <div className="card">
          <h2 className="card__title">ログイン</h2>

          <form onSubmit={submit} className="form">
            <label className="field">
              <span className="field__label">メールアドレス</span>
              <input
                className="field__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                data-testid="login-email"
              />
            </label>

            <label className="field">
              <span className="field__label">パスワード</span>
              <input
                className="field__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                data-testid="login-password"
              />
            </label>

            {login.isError && (
              <p className="alert alert--error" role="alert" data-testid="login-error">
                {errorMessage(login.error)}
              </p>
            )}

            <button
              type="submit"
              className="button button--primary"
              disabled={login.isPending}
              data-testid="login-submit"
            >
              {login.isPending ? "ログイン中…" : "ログイン"}
            </button>
          </form>

          <p className="muted card__footnote">
            同じアカウントで、PC とスマートフォンに同時にログインできます。
          </p>
        </div>
      </div>
    </div>
  );
}
