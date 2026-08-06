# Atarimae

**当たり前のことが、当たり前にできる社内掲示板。**

A free and self-hosted communication board for small teams.

---

> **開発中 (M0)** — まだ動作するアプリケーションではありません。
> 現在は開発基盤のみが揃っている段階です。

---

## これは何か

管理者が管理者を追加できる。
同じアカウントを複数端末で利用できる。
PC でもスマートフォンでもチャットできる。
会社のデータを自分でエクスポートできる。

Atarimae は、このような基本的な機能を、基本的な機能として実装した無料の社内掲示板です。

- 完全無料・人数制限なし
- セルフホスト型（データは自分のサーバーに）
- オープンソース (AGPL-3.0)
- 公式クラウドサービスなし・営業担当への連絡不要

## 開発状況

| マイルストーン | 内容                                       | 状態   |
| -------------- | ------------------------------------------ | ------ |
| **M0**         | 開発基盤、CI、マイグレーション、E2E 骨組み | 進行中 |
| M1             | アカウント・組織・権限                     | 未着手 |
| M2             | 公告・Recipient・通知                      | 未着手 |
| M3a            | 基本チャット                               | 未着手 |
| M4             | PWA・Windows クライアント                  | 未着手 |
| M5             | 公開 API・通話 Provider                    | 未着手 |
| M6a / M6b      | セキュリティ・ドキュメント・正式リリース   | 未着手 |

---

## Development setup

### Requirements

| Tool       | Version              | Why                                                     |
| ---------- | -------------------- | ------------------------------------------------------- |
| Node.js    | 22+ (24 recommended) | `process.loadEnvFile`, native `--env-file`              |
| pnpm       | 10+                  | workspace management                                    |
| PostgreSQL | **18+**              | `uuidv7()` and the builtin `C.UTF-8` collation provider |

PostgreSQL 18 is a hard floor, not a preference — see
[docs/architecture/decisions.md](docs/architecture/decisions.md).

### First run

```bash
pnpm install
```

```bash
node scripts/setup-env.mjs
```

That writes `.env` with freshly generated secrets. Check that `DATABASE_URL`
matches your local PostgreSQL, then create the databases:

```bash
pnpm db:reset
```

Start the API and the web client together:

```bash
pnpm dev
```

- Web client: http://localhost:5173
- API: http://localhost:3000/api/v1
- API docs (development only): http://localhost:3000/docs

---

## Database

Migrations are plain SQL. Both directions are mandatory — `pnpm db:verify` runs
`up → down → up` and fails if a migration cannot be rolled back.

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `pnpm db:new <name>` | Scaffold a migration with both directions stubbed         |
| `pnpm db:up`         | Apply pending migrations                                  |
| `pnpm db:down`       | Roll back the most recent migration                       |
| `pnpm db:status`     | Show applied and pending migrations                       |
| `pnpm db:reset`      | Drop, recreate and migrate the dev database               |
| `pnpm db:verify`     | Prove every migration is reversible (runs on the test DB) |
| `pnpm db:test:reset` | Same as reset, against the test database                  |

Append `--test` to target the test database, e.g. `pnpm db:up --test`.

---

## Checks

```bash
pnpm check
```

Runs format check, lint, typecheck and unit tests — the same gates as CI.

```bash
pnpm test:e2e
```

Playwright, at both desktop and phone widths. The suite starts its own API and
web server on separate ports and runs against the **test** database.

Browsers need installing once:

```bash
pnpm --filter @atarimae/e2e install-browsers
```

---

## Layout

```text
atarimae/
├─ apps/
│  ├─ server/          Fastify + TypeBox, REST + OpenAPI 3.1
│  └─ web/             React + Vite + TanStack Query
├─ packages/
│  ├─ api-schema/      TypeBox schemas — the single source of truth
│  └─ secret-store/    AES-256-GCM for external credentials
├─ migrations/         Plain SQL, up and down
├─ e2e/                Playwright
├─ scripts/            db.mjs, setup-env.mjs
└─ docs/
```

Request and response types are defined once in `packages/api-schema` and reused
by Fastify for validation, by `@fastify/swagger` for the OpenAPI document, and
by the web client for its types. `apps/server/openapi.json` is committed and CI
fails when it drifts.

---

## License

[AGPL-3.0-only](LICENSE).

You may use, modify and self-host this freely. If you run a modified version as
a network service, that version's source must be made available to its users.

This is deliberate: it keeps anyone from taking this, closing it, and charging
per employee for it.

## Project status and support

本プロジェクトは個人が作品および技術検証を目的として維持しています。

- 公式ホスティングサービスは提供しません
- SLA はありません
- 更新頻度は約束しません
- 電話・訪問・個別の無償導入支援は行いません

企業利用者は、デプロイ・バックアップ・セキュリティ設定・運用を自己責任で行ってください。
