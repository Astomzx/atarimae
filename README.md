# Atarimae

**当たり前のことが、当たり前にできる社内掲示板。**

A free and self-hosted communication board for small teams.

---

管理者が管理者を追加できる。
同じアカウントを複数端末で利用できる。
会社のデータを自分でエクスポートできる。

Atarimae は、このような基本的な機能を、基本的な機能として実装した無料の社内掲示板です。

- 完全無料・人数制限なし
- セルフホスト型（データは自分のサーバーに）
- オープンソース (AGPL-3.0)
- 公式クラウドサービスなし・営業担当への連絡不要

---

## 何ができるか

### 全体の連絡と、一人ひとりへの指示を、1つの公告で

```
明日の予定                          ← 全員に共通の本文
朝礼は8時30分から。全員参加してください。

あなたの担当                        ← その人にだけ表示される
8:30 第一営業所集合、その後A区域を担当
```

田中さんには田中さんの担当だけが表示され、佐藤さんには佐藤さんの分だけが表示されます。
確認ボタンが記録するのは「共通の本文＋自分の担当」という、その人が実際に見た組み合わせです。

四十人分をひとつずつ入力するのは現実的ではないので、CSV での一括入力に対応しています。
名簿をダウンロードし、Excel で担当欄を埋めて、そのまま戻せます。

### 確認状況が、説明できる数字であること

確認率の分母は「現在有効な確認義務」です。現在の部署人数でも、宛先の人数でも、
配信対象の総数でもありません。だから次のことが成り立ちます。

- 公開時点で対象者が確定するため、後から異動があっても過去の確認率は変わらない
- 停止したメンバーは分母から外れる（ログインできない人がいる限り 100% にならない、を避ける）
- ただし、その人が既に確認していれば、その記録は残り続ける
- 確認済みの義務は、管理者でも免除できない

「確認を依頼しました」と表示されて実際には誰にも届いていない、という状態が
起きないように設計されています。対象者が 0 名の操作は成功ではなくエラーとして返します。

### そのほか

- 部署・営業所・チーム単位、または個人単位での宛先指定
- 確認期限と、期限24時間前のメール通知（送信は1回だけ）
- 複数端末の同時ログインと、自分でのログアウト操作
- 管理操作の監査ログ
- 確認結果の CSV エクスポート

---

## 開発状況

| マイルストーン | 内容                                     | 状態     |
| -------------- | ---------------------------------------- | -------- |
| M0             | 開発基盤、CI、マイグレーション、E2E      | 完了     |
| M1             | アカウント・組織・権限                   | 完了     |
| **M2**         | 公告・個人別内容・確認・通知             | **完了** |
| M3a            | 基本チャット                             | 未着手   |
| M4             | PWA・Windows クライアント                | 未着手   |
| M5             | 公開 API・通話 Provider                  | 未着手   |
| M6a / M6b      | セキュリティ・ドキュメント・正式リリース | 未着手   |

受け入れシナリオはすべて自動テスト化されています
（[M1](e2e/tests/m1-acceptance.spec.ts)、[M2](e2e/tests/m2-ui.spec.ts)）。

---

## Deploying

```bash
git clone https://github.com/Astomzx/atarimae.git
```

```bash
node scripts/setup-env.mjs
```

Set `PUBLIC_ORIGIN` in the generated `.env`, then:

```bash
docker compose up -d
```

```bash
docker compose exec app node scripts/db.mjs up
```

Open the address and create the first Owner — there is no activation step and
nobody to contact.

Full instructions, including TLS, SMTP, backups and updating:
**[docs/deployment/docker.md](docs/deployment/docker.md)**

> **Back up `ENCRYPTION_KEY_CURRENT` separately from your database dumps.**
> Losing it permanently destroys every stored external credential.

---

## Development

| Tool       | Version              | Why                                            |
| ---------- | -------------------- | ---------------------------------------------- |
| Node.js    | 22+ (24 recommended) | `process.loadEnvFile`                          |
| pnpm       | 10+                  | workspace management                           |
| PostgreSQL | **18+**              | `uuidv7()` and the builtin `C.UTF-8` collation |

PostgreSQL 18 is a hard floor, not a preference — see
[docs/architecture/decisions.md](docs/architecture/decisions.md).

```bash
pnpm install
```

```bash
node scripts/setup-env.mjs
```

```bash
pnpm db:reset
```

```bash
pnpm dev
```

- Web client: http://localhost:5173
- API: http://localhost:3000/api/v1
- API docs (development only): http://localhost:3000/docs

### Checks

```bash
pnpm check
```

Builds, then runs format check, lint, typecheck and unit tests — the same gates
as CI, in the same order.

```bash
pnpm test:e2e
```

Playwright, at desktop and phone widths, against the test database. Browsers
need installing once:

```bash
pnpm --filter @atarimae/e2e install-browsers
```

### Database

Migrations are plain SQL with both directions mandatory. `pnpm db:verify` runs
`up → down → up` and fails if any migration cannot be rolled back.

| Command              | What it does                                  |
| -------------------- | --------------------------------------------- |
| `pnpm db:new <name>` | Scaffold a migration, both directions stubbed |
| `pnpm db:up`         | Apply pending migrations                      |
| `pnpm db:down`       | Roll back the most recent one                 |
| `pnpm db:status`     | Show applied and pending                      |
| `pnpm db:reset`      | Drop, recreate and migrate the dev database   |
| `pnpm db:verify`     | Prove every migration is reversible           |

Append `--test` to target the test database.

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
└─ docs/
   ├─ architecture/    Frozen data model, technical decisions
   ├─ deployment/      Docker
   └─ engineering/     Defects found while building, and their guards
```

Request and response types are defined once in `packages/api-schema` and reused
by Fastify for validation, by `@fastify/swagger` for the OpenAPI document, and
by the web client for its types. `apps/server/openapi.json` is committed and CI
fails when it drifts.

The announcement data model is **frozen** and documented in
[docs/architecture/announcement-model.md](docs/architecture/announcement-model.md).
It explains not only what the tables are, but which failures each constraint
exists to make impossible.

---

## Security

Report vulnerabilities privately: **[SECURITY.md](SECURITY.md)**. It also states
plainly what the design already assumes, so no one wastes time reporting a
deliberate decision.

---

## License

[AGPL-3.0-only](LICENSE).

You may use, modify and self-host this freely. If you run a modified version as
a network service, that version's source must be made available to its users.

This is deliberate: it keeps anyone from taking this, closing it, and charging
per employee for it.

Known cost: some companies' legal departments refuse AGPL outright, so adoption
will be lower than under MIT. That trade is accepted.

## Project status and support

本プロジェクトは個人が作品および技術検証を目的として維持しています。

- 公式ホスティングサービスは提供しません
- SLA はありません
- 更新頻度は約束しません
- 電話・訪問・個別の無償導入支援は行いません

企業利用者は、デプロイ・バックアップ・セキュリティ設定・運用を自己責任で行ってください。

Issue は歓迎します。再現手順のあるバグ、セキュリティ問題、ドキュメントの改善、
汎用的な機能提案について。特定企業向けのカスタマイズ、無償の導入代行、
修正期日の確約には対応できません。

**PRs are welcome.**
