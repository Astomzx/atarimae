import type { ApiToken, ServiceAccount } from "@atarimae/api-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, errorMessage } from "../api.js";

/**
 * Service accounts, and the tokens that let something other than a person use
 * the API.
 *
 * The screen exists to make two things impossible to miss: a token is visible
 * exactly once, and revoking one takes effect immediately. Everything else is
 * an ordinary list.
 */
export function ServiceAccountsPage() {
  const accounts = useQuery({
    queryKey: ["service-accounts"],
    queryFn: api.serviceAccounts.list,
  });

  const items = accounts.data?.items ?? [];

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">サービスアカウント</h1>
      </div>

      <p className="muted card__lead">
        外部システムが API を使うための利用者です。担当者個人のトークンにしないのは、
        その人が退職した日に連携も止まるからです。パスワードを持たず、
        画面からログインすることはできません。
      </p>

      <NewServiceAccount />

      {accounts.isPending && <p className="muted">読み込み中…</p>}
      {accounts.isError && (
        <p className="alert alert--error">{errorMessage(accounts.error)}</p>
      )}

      {accounts.isSuccess && items.length === 0 && (
        <p className="muted" data-testid="no-service-accounts">
          サービスアカウントはまだありません。
        </p>
      )}

      {items.length > 0 && (
        <ul className="list" data-testid="service-account-list">
          {items.map((account) => (
            <ServiceAccountRow key={account.id} account={account} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NewServiceAccount() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  const create = useMutation({
    mutationFn: api.serviceAccounts.create,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      setDisplayName("");
      setDescription("");
      setOpen(false);
    },
  });

  if (!open) {
    return (
      <p className="toggle">
        <button
          type="button"
          className="button button--primary"
          onClick={() => setOpen(true)}
          data-testid="toggle-create-service-account"
        >
          サービスアカウントを作成
        </button>
      </p>
    );
  }

  return (
    <section className="card">
      <h2 className="card__title">サービスアカウントを作成</h2>

      <form
        className="form form--grid"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({
            displayName: displayName.trim(),
            role,
            ...(description.trim() ? { description: description.trim() } : {}),
          });
        }}
      >
        <label className="field">
          <span className="field__label">名前</span>
          <input
            className="field__input"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="配車システム"
            required
            data-testid="new-service-account-name"
          />
        </label>

        <label className="field">
          <span className="field__label">権限</span>
          <select
            className="field__input"
            value={role}
            onChange={(event) => setRole(event.target.value as "member" | "admin")}
            data-testid="new-service-account-role"
          >
            <option value="member">メンバー</option>
            <option value="admin">管理者</option>
          </select>
          {/*
           * Owner is not offered, and the server refuses it. Owner is the role
           * that can grant Owner, so a token holding it would be one leak away
           * from being the whole organisation.
           */}
          <span className="field__hint">オーナー権限は付与できません。</span>
        </label>

        <label className="field">
          <span className="field__label">用途（任意）</span>
          <input
            className="field__input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="毎朝の配車表を取り込みます"
            maxLength={500}
            data-testid="new-service-account-description"
          />
        </label>

        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={create.isPending || displayName.trim() === ""}
            data-testid="create-service-account-submit"
          >
            {create.isPending ? "作成中…" : "作成"}
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setOpen(false)}
          >
            閉じる
          </button>
        </div>
      </form>

      {create.isError && (
        <p className="alert alert--error alert--inline">{errorMessage(create.error)}</p>
      )}
    </section>
  );
}

function ServiceAccountRow({ account }: { account: ServiceAccount }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const disabled = account.disabledAt !== null;

  const setEnabled = useMutation({
    mutationFn: (enable: boolean) =>
      enable
        ? api.serviceAccounts.restore(account.id)
        : api.serviceAccounts.disable(account.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["service-accounts"] }),
  });

  return (
    <li
      className={`list__item${disabled ? " list__item--muted" : ""}`}
      data-testid={`service-account-${account.displayName}`}
    >
      <div className="list__main">
        <span className="list__title">{account.displayName}</span>
        {account.description && <span className="list__meta">{account.description}</span>}
        <span className="list__meta">
          有効なトークン {account.activeTokenCount} 件
          {account.lastUsedAt
            ? ` ・ 最終利用 ${formatDateTime(account.lastUsedAt)}`
            : " ・ 未使用"}
        </span>
        <span className="list__tags">
          <span className={`badge badge--${account.role}`}>
            {account.role === "admin" ? "管理者" : "メンバー"}
          </span>
          {disabled && <span className="badge badge--disabled">停止中</span>}
        </span>
      </div>

      <div className="list__actions">
        <button
          type="button"
          className="button"
          onClick={() => setOpen((current) => !current)}
          data-testid={`tokens-${account.displayName}`}
        >
          {open ? "閉じる" : "トークン"}
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setEnabled.mutate(disabled)}
          disabled={setEnabled.isPending}
        >
          {disabled ? "再開" : "停止"}
        </button>
      </div>

      {open && <TokenPanel account={account} />}
    </li>
  );
}

function TokenPanel({ account }: { account: ServiceAccount }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");

  /**
   * The plaintext, held in this component and nowhere else.
   *
   * Not written to the query cache: it is not server state, it is a one-time
   * disclosure, and caching it would mean it survives navigation and sits in
   * memory long after the person who needed it has copied it.
   */
  const [issued, setIssued] = useState<{ token: ApiToken; plaintext: string } | null>(
    null,
  );

  const tokens = useQuery({
    queryKey: ["service-accounts", account.id, "tokens"],
    queryFn: () => api.serviceAccounts.tokens(account.id),
  });

  const issue = useMutation({
    mutationFn: () =>
      api.serviceAccounts.issueToken(account.id, {
        name: name.trim(),
        ...(expiresInDays.trim() ? { expiresInDays: Number(expiresInDays) } : {}),
      }),
    onSuccess: async (result) => {
      setIssued(result);
      setName("");
      setExpiresInDays("");
      await queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.serviceAccounts.revokeToken(account.id, tokenId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
    },
  });

  const items = tokens.data?.items ?? [];

  return (
    <section className="token-panel">
      {issued && (
        <div className="token-reveal" data-testid="issued-token">
          <p className="token-reveal__label">
            この画面を閉じると二度と表示できません。今すぐコピーしてください。
          </p>
          <code className="token-reveal__value" data-testid="issued-token-value">
            {issued.plaintext}
          </code>
          <p className="field__hint">
            サーバーはハッシュしか保存していないため、再表示はできません。
            紛失した場合は、このトークンを失効させて新しく発行してください。
          </p>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setIssued(null)}
            data-testid="dismiss-issued-token"
          >
            コピーしました
          </button>
        </div>
      )}

      <form
        className="form form--inline"
        onSubmit={(event) => {
          event.preventDefault();
          issue.mutate();
        }}
      >
        <label className="field field--grow">
          <span className="field__label">トークンの用途</span>
          <input
            className="field__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="夜間取り込み"
            required
            data-testid="new-token-name"
          />
        </label>

        <label className="field">
          <span className="field__label">有効期限（日・任意）</span>
          <input
            className="field__input"
            type="number"
            min={1}
            max={3650}
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
            placeholder="無期限"
            data-testid="new-token-expiry"
          />
        </label>

        <button
          type="submit"
          className="button button--primary"
          disabled={issue.isPending || name.trim() === ""}
          data-testid="issue-token"
        >
          {issue.isPending ? "発行中…" : "発行"}
        </button>
      </form>

      {issue.isError && (
        <p className="alert alert--error alert--inline" data-testid="issue-token-error">
          {errorMessage(issue.error)}
        </p>
      )}

      {tokens.isPending && <p className="muted">読み込み中…</p>}

      {tokens.isSuccess && items.length === 0 && (
        <p className="muted">発行済みのトークンはありません。</p>
      )}

      {items.length > 0 && (
        <ul className="list list--flush" data-testid="token-list">
          {items.map((token) => {
            const dead =
              token.revokedAt !== null ||
              (token.expiresAt !== null && new Date(token.expiresAt) <= new Date());

            return (
              <li
                key={token.id}
                className={`list__item${dead ? " list__item--muted" : ""}`}
              >
                <div className="list__main">
                  <span className="list__title">{token.name}</span>
                  <span className="list__meta">
                    <code>{token.tokenPrefix}…</code>
                    {token.lastUsedAt
                      ? ` ・ 最終利用 ${formatDateTime(token.lastUsedAt)}`
                      : " ・ 未使用"}
                    {token.expiresAt && ` ・ 期限 ${formatDateTime(token.expiresAt)}`}
                  </span>
                  {token.revokedAt && (
                    <span className="list__tags">
                      <span className="badge badge--disabled">失効済み</span>
                    </span>
                  )}
                </div>

                {!token.revokedAt && (
                  <div className="list__actions">
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => revoke.mutate(token.id)}
                      disabled={revoke.isPending}
                      data-testid={`revoke-token-${token.name}`}
                    >
                      失効させる
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}
