import type { Role, UserSummary } from "@atarimae/api-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { api, errorMessage } from "../api.js";
import { hasAtLeast, ROLE_LABEL, useSession } from "../auth.js";

export function MembersPage() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [showDisabled, setShowDisabled] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const isAdmin = user ? hasAtLeast(user.role, "admin") : false;
  const isOwner = user?.role === "owner";

  const members = useQuery({
    queryKey: ["users", { includeDisabled: showDisabled }],
    queryFn: () => api.users.list({ includeDisabled: showDisabled }),
  });

  const orgUnits = useQuery({
    queryKey: ["org-units"],
    queryFn: () => api.orgUnits.list(),
    enabled: isAdmin,
  });

  // `void` because this is handed to child props typed as returning void;
  // invalidateQueries resolves once refetching settles, which callers here do
  // not need to await.
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["users"] });

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">メンバー</h1>
        {isAdmin && (
          <button
            type="button"
            className="button button--primary"
            onClick={() => setFormOpen((open) => !open)}
            data-testid="toggle-create-member"
          >
            {formOpen ? "閉じる" : "メンバーを追加"}
          </button>
        )}
      </div>

      {isAdmin && formOpen && (
        <CreateMemberForm
          canGrantOwner={isOwner}
          orgUnits={orgUnits.data?.items ?? []}
          onCreated={() => {
            setFormOpen(false);
            refresh();
          }}
        />
      )}

      {isAdmin && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={showDisabled}
            onChange={(e) => setShowDisabled(e.target.checked)}
            data-testid="show-disabled"
          />
          停止中のメンバーも表示
        </label>
      )}

      {members.isPending && <p className="muted">読み込み中…</p>}
      {members.isError && (
        <p className="alert alert--error">{errorMessage(members.error)}</p>
      )}

      <ul className="list" data-testid="member-list">
        {members.data?.items.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            isAdmin={isAdmin}
            isOwner={isOwner}
            isSelf={member.id === user?.id}
            onChanged={refresh}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Creating an administrator is an ordinary form with an ordinary dropdown.
 * That is the entire point: no support ticket, no per-seat upgrade, no waiting
 * for a vendor to flip a flag.
 */
function CreateMemberForm({
  canGrantOwner,
  orgUnits,
  onCreated,
}: {
  canGrantOwner: boolean;
  orgUnits: { id: string; name: string }[];
  onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [orgUnitId, setOrgUnitId] = useState("");

  const create = useMutation({
    mutationFn: api.users.create,
    onSuccess: () => {
      setDisplayName("");
      setEmail("");
      setPassword("");
      setRole("member");
      setOrgUnitId("");
      onCreated();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({
      displayName,
      email,
      role,
      password,
      ...(orgUnitId ? { primaryOrgUnitId: orgUnitId } : {}),
    });
  }

  return (
    <section className="card">
      <h2 className="card__title">メンバーを追加</h2>

      <form onSubmit={submit} className="form form--grid">
        <label className="field">
          <span className="field__label">お名前</span>
          <input
            className="field__input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            maxLength={100}
            data-testid="new-member-name"
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
            data-testid="new-member-email"
          />
        </label>

        <label className="field">
          <span className="field__label">初期パスワード</span>
          <input
            className="field__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={12}
            data-testid="new-member-password"
          />
          <span className="field__hint">12文字以上</span>
        </label>

        <label className="field">
          <span className="field__label">権限</span>
          <select
            className="field__input"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            data-testid="new-member-role"
          >
            <option value="member">メンバー</option>
            <option value="admin">管理者</option>
            {canGrantOwner && <option value="owner">オーナー</option>}
          </select>
          {!canGrantOwner && (
            <span className="field__hint">オーナーの任命はオーナーのみ可能です。</span>
          )}
        </label>

        <label className="field">
          <span className="field__label">所属部署</span>
          <select
            className="field__input"
            value={orgUnitId}
            onChange={(e) => setOrgUnitId(e.target.value)}
            data-testid="new-member-org-unit"
          >
            <option value="">未設定</option>
            {orgUnits.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
        </label>

        <div className="form__actions">
          {create.isError && (
            <p
              className="alert alert--error"
              role="alert"
              data-testid="create-member-error"
            >
              {errorMessage(create.error)}
            </p>
          )}
          <button
            type="submit"
            className="button button--primary"
            disabled={create.isPending}
            data-testid="create-member-submit"
          >
            {create.isPending ? "追加中…" : "追加する"}
          </button>
        </div>
      </form>
    </section>
  );
}

function MemberRow({
  member,
  isAdmin,
  isOwner,
  isSelf,
  onChanged,
}: {
  member: UserSummary;
  isAdmin: boolean;
  isOwner: boolean;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const mutate = (fn: () => Promise<unknown>) => () => {
    setError(null);
    fn()
      .then(onChanged)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };

  const disabled = member.disabledAt !== null;
  // Only an Owner may act on another Owner, and nobody may act on themselves.
  const canAct = isAdmin && !isSelf && (member.role !== "owner" || isOwner);

  return (
    <li className={`list__item ${disabled ? "list__item--muted" : ""}`}>
      <div className="list__main">
        <span className="list__title" data-testid="member-name">
          {member.displayName}
        </span>
        <span className="list__meta">{member.email}</span>
        <div className="list__tags">
          <span className={`badge badge--${member.role}`}>{ROLE_LABEL[member.role]}</span>
          {member.orgUnits.map((unit) => (
            <span key={unit.id} className="badge">
              {unit.name}
              {unit.isPrimary && "（主）"}
            </span>
          ))}
          {disabled && <span className="badge badge--disabled">停止中</span>}
        </div>
        {error && <p className="alert alert--error alert--inline">{error}</p>}
      </div>

      {canAct && (
        <div className="list__actions">
          <select
            className="field__input field__input--compact"
            value={member.role}
            onChange={(e) =>
              mutate(() => api.users.setRole(member.id, e.target.value as Role))()
            }
            aria-label={`${member.displayName} の権限`}
            data-testid={`role-${member.email}`}
          >
            <option value="member">メンバー</option>
            <option value="admin">管理者</option>
            {isOwner && <option value="owner">オーナー</option>}
          </select>

          <button
            type="button"
            className="button button--quiet"
            onClick={mutate(() =>
              disabled ? api.users.restore(member.id) : api.users.disable(member.id),
            )}
            data-testid={`toggle-${member.email}`}
          >
            {disabled ? "復元" : "停止"}
          </button>
        </div>
      )}
    </li>
  );
}
