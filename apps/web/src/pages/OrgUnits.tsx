import type { OrgUnitKind } from "@atarimae/api-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { api, errorMessage } from "../api.js";

const KIND_LABEL: Record<OrgUnitKind, string> = {
  department: "部署",
  branch: "営業所",
  team: "チーム",
  other: "その他",
};

export function OrgUnitsPage() {
  const queryClient = useQueryClient();
  const [showDisabled, setShowDisabled] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OrgUnitKind>("department");

  const units = useQuery({
    queryKey: ["org-units", { includeDisabled: showDisabled }],
    queryFn: () => api.orgUnits.list(showDisabled),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["org-units"] });

  const create = useMutation({
    mutationFn: api.orgUnits.create,
    onSuccess: () => {
      setName("");
      refresh();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ name, kind });
  }

  return (
    <div className="page">
      <h1 className="page__title">部署・営業所</h1>
      <p className="muted">
        公告の宛先はここで作った単位で指定します。削除はできず、停止のみ可能です。
        過去の公告の宛先が解決できなくなるためです。
      </p>

      <section className="card">
        <h2 className="card__title">新しく作成</h2>
        <form onSubmit={submit} className="form form--inline">
          <label className="field field--grow">
            <span className="field__label">名前</span>
            <input
              className="field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              placeholder="第一営業所"
              data-testid="new-org-unit-name"
            />
          </label>

          <label className="field">
            <span className="field__label">種別</span>
            <select
              className="field__input"
              value={kind}
              onChange={(e) => setKind(e.target.value as OrgUnitKind)}
              data-testid="new-org-unit-kind"
            >
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className="button button--primary"
            disabled={create.isPending}
            data-testid="create-org-unit"
          >
            作成
          </button>
        </form>

        {create.isError && (
          <p
            className="alert alert--error"
            role="alert"
            data-testid="create-org-unit-error"
          >
            {errorMessage(create.error)}
          </p>
        )}
      </section>

      <label className="toggle">
        <input
          type="checkbox"
          checked={showDisabled}
          onChange={(e) => setShowDisabled(e.target.checked)}
          data-testid="show-disabled-units"
        />
        停止中の部署も表示
      </label>

      {units.isPending && <p className="muted">読み込み中…</p>}

      <ul className="list" data-testid="org-unit-list">
        {units.data?.items.map((unit) => (
          <OrgUnitRow key={unit.id} unit={unit} onChanged={refresh} />
        ))}
        {units.data?.items.length === 0 && (
          <li className="list__item">
            <span className="muted">まだ部署がありません。</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function OrgUnitRow({
  unit,
  onChanged,
}: {
  unit: {
    id: string;
    name: string;
    kind: OrgUnitKind;
    memberCount: number;
    disabledAt: string | null;
  };
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(unit.name);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn()
      .then(() => {
        setRenaming(false);
        onChanged();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };

  const disabled = unit.disabledAt !== null;

  return (
    <li className={`list__item ${disabled ? "list__item--muted" : ""}`}>
      <div className="list__main">
        {renaming ? (
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api.orgUnits.rename(unit.id, draft));
            }}
          >
            <input
              className="field__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              required
              maxLength={100}
              aria-label="新しい名前"
            />
            <button type="submit" className="button button--primary">
              保存
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                setRenaming(false);
                setDraft(unit.name);
              }}
            >
              取消
            </button>
          </form>
        ) : (
          <>
            <span className="list__title">{unit.name}</span>
            <span className="list__meta">
              {KIND_LABEL[unit.kind]} ・ {unit.memberCount}名
            </span>
          </>
        )}
        {disabled && <span className="badge badge--disabled">停止中</span>}
        {error && <p className="alert alert--error alert--inline">{error}</p>}
      </div>

      {!renaming && (
        <div className="list__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setRenaming(true)}
          >
            名前変更
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() =>
              run(() =>
                disabled ? api.orgUnits.restore(unit.id) : api.orgUnits.disable(unit.id),
              )
            }
            data-testid={`toggle-unit-${unit.name}`}
          >
            {disabled ? "復元" : "停止"}
          </button>
        </div>
      )}
    </li>
  );
}
