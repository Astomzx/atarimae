import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { api, errorMessage } from "../api.js";
import { FullPageMessage, useSetupStatus } from "../auth.js";

/**
 * First run.
 *
 * The only screen that works without an account, and it stops working the
 * moment an Owner exists. There is no vendor to call and no activation code to
 * wait for — the organisation is set up by whoever opens the page first.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useSetupStatus();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const createOwner = useMutation({
    mutationFn: api.setup.createOwner,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      void navigate("/", { replace: true });
    },
  });

  if (status.isPending) return <FullPageMessage>読み込み中…</FullPageMessage>;
  if (status.data?.initialized) return <Navigate to="/login" replace />;

  function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);

    if (password !== confirm) {
      setLocalError("パスワードが一致しません。");
      return;
    }
    if (password.length < 12) {
      setLocalError("パスワードは12文字以上にしてください。");
      return;
    }

    createOwner.mutate({ email, displayName, password });
  }

  return (
    <div className="centered">
      <div className="centered__inner">
        <header className="brand">
          <h1 className="brand__name">Atarimae</h1>
          <p className="brand__tagline">当たり前のことが、当たり前にできる社内掲示板。</p>
        </header>

        <div className="card">
          <h2 className="card__title">最初のオーナーを作成</h2>
          <p className="muted card__lead">
            このアカウントが組織の最初の管理者になります。作成後すぐに他の管理者を追加できます。
          </p>

          <form onSubmit={submit} className="form">
            <label className="field">
              <span className="field__label">お名前</span>
              <input
                className="field__input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                maxLength={100}
                autoComplete="name"
                data-testid="setup-display-name"
              />
            </label>

            <label className="field">
              <span className="field__label">メールアドレス</span>
              <input
                className="field__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                data-testid="setup-email"
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
                minLength={12}
                autoComplete="new-password"
                data-testid="setup-password"
              />
              <span className="field__hint">
                12文字以上。記号や数字の混在は必須ではありません。
              </span>
            </label>

            <label className="field">
              <span className="field__label">パスワード（確認）</span>
              <input
                className="field__input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                data-testid="setup-password-confirm"
              />
            </label>

            {(localError ?? createOwner.isError) && (
              <p className="alert alert--error" role="alert" data-testid="setup-error">
                {localError ?? errorMessage(createOwner.error)}
              </p>
            )}

            <button
              type="submit"
              className="button button--primary"
              disabled={createOwner.isPending}
              data-testid="setup-submit"
            >
              {createOwner.isPending ? "作成中…" : "オーナーを作成する"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
