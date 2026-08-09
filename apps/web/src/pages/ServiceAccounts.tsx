import type {
  ApiToken,
  ServiceAccount,
  Webhook,
  WebhookEvent,
} from "@atarimae/api-schema";
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

      <Webhooks />
    </div>
  );
}

/**
 * The other direction: telling another system that something happened here.
 *
 * On the same screen because they are the same question from two sides — what
 * is connected to this organisation, and how do we disconnect it.
 */
function Webhooks() {
  const webhooks = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks.list });
  const items = webhooks.data?.items ?? [];

  return (
    <section>
      <h2 className="section__title">Webhook（送信）</h2>
      <p className="muted">
        公告の公開や確認を、外部システムへ HTTP で通知します。
        届かなかった場合は自動で再送し、その記録もここに残ります。
      </p>

      <NewWebhook />

      {webhooks.isPending && <p className="muted">読み込み中…</p>}
      {webhooks.isError && (
        <p className="alert alert--error">{errorMessage(webhooks.error)}</p>
      )}

      {webhooks.isSuccess && items.length === 0 && (
        <p className="muted" data-testid="no-webhooks">
          Webhook はまだ登録されていません。
        </p>
      )}

      {items.length > 0 && (
        <ul className="list" data-testid="webhook-list">
          {items.map((webhook) => (
            <WebhookRow key={webhook.id} webhook={webhook} />
          ))}
        </ul>
      )}
    </section>
  );
}

const WEBHOOK_EVENTS: { value: WebhookEvent; label: string }[] = [
  { value: "announcement.published", label: "公告の公開" },
  { value: "announcement.acknowledged", label: "確認の記録" },
  { value: "user.created", label: "メンバーの追加" },
  { value: "user.disabled", label: "メンバーの停止" },
];

function NewWebhook() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["announcement.published"]);

  /** Shown once, exactly like an API token. */
  const [secret, setSecret] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.webhooks.create({
        url: url.trim(),
        events,
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: async (result) => {
      setSecret(result.secret);
      setUrl("");
      setDescription("");
      await queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });

  if (!open) {
    return (
      <p className="toggle">
        <button
          type="button"
          className="button"
          onClick={() => setOpen(true)}
          data-testid="toggle-create-webhook"
        >
          Webhook を追加
        </button>
      </p>
    );
  }

  return (
    <section className="card">
      <h3 className="card__title">Webhook を追加</h3>

      {secret && (
        <div className="token-reveal" data-testid="issued-secret">
          <p className="token-reveal__label">
            署名用のシークレットです。この画面を閉じると二度と表示できません。
          </p>
          <code className="token-reveal__value" data-testid="issued-secret-value">
            {secret}
          </code>
          <p className="field__hint">
            受信側では <code>X-Atarimae-Signature</code> を検証してください。
            <code>t=&lt;unix秒&gt;,v1=&lt;hex&gt;</code> の hex は、
            <code>&lt;t&gt;.&lt;本文&gt;</code> の HMAC-SHA256 です。
            5分以上前のものは拒否してください。
          </p>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setSecret(null)}
            data-testid="dismiss-issued-secret"
          >
            コピーしました
          </button>
        </div>
      )}

      <form
        className="form form--grid"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label className="field">
          <span className="field__label">送信先 URL</span>
          <input
            className="field__input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/hooks/atarimae"
            required
            data-testid="new-webhook-url"
          />
          {/*
           * The server refuses private and loopback addresses. Saying so here
           * turns a rejection into an expectation rather than a surprise.
           */}
          <span className="field__hint">
            社内アドレス（localhost・127.0.0.1・10.x など）は指定できません。
          </span>
        </label>

        <label className="field">
          <span className="field__label">説明（任意）</span>
          <input
            className="field__input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            data-testid="new-webhook-description"
          />
        </label>

        <div className="field">
          <span className="field__label">送信する出来事</span>
          <div className="chips">
            {WEBHOOK_EVENTS.map((event) => {
              const on = events.includes(event.value);
              return (
                <button
                  key={event.value}
                  type="button"
                  className={`chip${on ? " chip--on" : ""}`}
                  onClick={() =>
                    setEvents((current) =>
                      on
                        ? current.filter((value) => value !== event.value)
                        : [...current, event.value],
                    )
                  }
                  data-testid={`webhook-event-${event.value}`}
                >
                  {event.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={create.isPending || url.trim() === "" || events.length === 0}
            data-testid="create-webhook-submit"
          >
            {create.isPending ? "登録中…" : "登録"}
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
        <p
          className="alert alert--error alert--inline"
          data-testid="create-webhook-error"
        >
          {errorMessage(create.error)}
        </p>
      )}
    </section>
  );
}

function WebhookRow({ webhook }: { webhook: Webhook }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const disabled = webhook.disabledAt !== null;

  const setEnabled = useMutation({
    mutationFn: (enable: boolean) =>
      enable ? api.webhooks.restore(webhook.id) : api.webhooks.disable(webhook.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["webhooks"] }),
  });

  const deliveries = useQuery({
    queryKey: ["webhooks", webhook.id, "deliveries"],
    queryFn: () => api.webhooks.deliveries(webhook.id),
    enabled: open,
  });

  return (
    <li
      className={`list__item${disabled ? " list__item--muted" : ""}`}
      data-testid="webhook-row"
    >
      <div className="list__main">
        <span className="list__title">{webhook.url}</span>
        {webhook.description && <span className="list__meta">{webhook.description}</span>}
        <span className="list__meta">
          {webhook.events
            .map((event) => WEBHOOK_EVENTS.find((e) => e.value === event)?.label ?? event)
            .join(" ・ ")}
        </span>
        <span className="list__tags">
          {disabled && <span className="badge badge--disabled">停止中</span>}
          {webhook.consecutiveFailures > 0 && (
            <span className="badge badge--mention" data-testid="webhook-failing">
              連続失敗 {webhook.consecutiveFailures} 回
            </span>
          )}
        </span>
        {/*
         * The last error is on the row rather than in a server log, because
         * "did it arrive" should not require shell access to answer.
         */}
        {webhook.lastError && (
          <span className="list__meta" data-testid="webhook-last-error">
            直近のエラー: {webhook.lastError}
          </span>
        )}
      </div>

      <div className="list__actions">
        <button
          type="button"
          className="button"
          onClick={() => setOpen((current) => !current)}
          data-testid="webhook-deliveries"
        >
          {open ? "閉じる" : "送信履歴"}
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setEnabled.mutate(disabled)}
          disabled={setEnabled.isPending}
          data-testid="toggle-webhook"
        >
          {disabled ? "再開" : "停止"}
        </button>
      </div>

      {open && (
        <section className="token-panel">
          {deliveries.isPending && <p className="muted">読み込み中…</p>}

          {deliveries.isSuccess && deliveries.data.items.length === 0 && (
            <p className="muted">送信履歴はまだありません。</p>
          )}

          {(deliveries.data?.items.length ?? 0) > 0 && (
            <ul className="list list--flush" data-testid="delivery-list">
              {deliveries.data!.items.map((delivery) => (
                <li key={delivery.id} className="list__item">
                  <div className="list__main">
                    <span className="list__title">
                      {WEBHOOK_EVENTS.find((e) => e.value === delivery.event)?.label ??
                        delivery.event}
                    </span>
                    <span className="list__meta">
                      {delivery.deliveredAt
                        ? `送信済み ${formatDateTime(delivery.deliveredAt)}`
                        : `未送信 ・ ${delivery.attemptCount} 回試行`}
                      {delivery.lastStatus !== null && ` ・ HTTP ${delivery.lastStatus}`}
                    </span>
                    {delivery.lastError && (
                      <span className="list__meta">{delivery.lastError}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </li>
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
