# election-progress-v3

参政党 選挙準備進捗管理システム v3。Supabase (`v3_candidates` / `v3_progress` テーブル) を参照して、候補者ごとの広報物準備の進捗状況を確認するための静的フロントエンドです。ビルド不要の素のHTML/JS構成（GitHub Pages で公開）で、supabase-js（ESモジュール、cdn.jsdelivr.net）から Supabase を直接呼び出します。

## ページ構成

- `index.html` — ログイン画面（「Google でログイン」のみ）。ログイン済み・有効・担当県割当済みの利用者は `list.html`（または `?next=` で指定された元のページ）へ移動します。未登録・承認待ち・無効・担当県未設定の利用者には、状態ごとの画面を出します。
- `list.html` — 担当県の候補者一覧。RLSで許可された担当県の `v3_candidates` をページング取得し、同じ範囲の `v3_progress` の集計から達成率（%）を算出します。候補者名をクリックすると詳細ページへ移動します。管理者には同県の「候補者を登録」・編集・削除を表示します。
- `detail.html?id=<candidate_id>` — 候補者詳細。対象候補者の `v3_progress` を「政治活動期間」「選挙期間」に分けて、項目ごとにステータス（未着手／着手中／納品完了）を表示します。
- `admin.html` — 管理者専用。候補者の登録・一括登録と、利用者管理（承認・無効化・再有効化・役割変更・削除）。管理者以外が開くと `list.html` に戻します。
- `privacy.html` — プライバシーポリシー（ログイン不要）。
- `auth.js` — ログインの共通処理（ESモジュール）。Supabase クライアントの作成、Google ログイン、利用者の状態の確認、状態ごとの画面、ヘッダーの表示名・ログアウト。
- `config.js` — Supabase接続情報（URL・Publishable key）。
- `status-map.js` — `v3_progress.status` の生の文字列を「未着手／着手中／納品完了」の3段階に変換するマッピング（list.htmlとdetail.html共通）。未知のステータス値は保険的に「着手中」として扱います。
- `supabase/migrations/` — DB の変更（SQL Editor で手動実行）。`0001_v3_users.sql`（利用者テーブルと判定関数）、`0002_restrict_v3_reads.sql`（有効利用者のRLS）、`20261018053254_restrict_prefecture_access.sql`（担当県RLSと管理RPC）。最新の反映順は担当県の手順を参照。
- `supabase/functions/` — Edge Function。`v3-users`（利用者管理）、`v3-sync-progress`（進捗の同期と候補者の登録・編集・削除）、`_shared/`（CORS・ログイン照合の共通処理）。

## 達成率の算出方法

候補者ごとに、`v3_progress` の全項目のうち `status` が「納品完了」段階にマッピングされる項目数の割合を達成率（%）として算出します。

## 認証について

Google ログイン（Supabase Auth）＋管理者承認制です。共通パスワードは使いません。

### 流れ

1. `index.html` の「Google でログイン」から Google にログインする（PKCE。戻り先は元のページ）。LINE・チャットワークなどのアプリ内ブラウザでは Google がログインを拒否するため、「Safari か Chrome で開いてください」と案内する
2. 初回は表示名を入力して登録する → `v3_users` に `status='pending'`（承認待ち）、`role='viewer'` で作られる
3. 作成者が確認した担当県をDBで設定し、同県管理者が `admin.html` の「利用者管理」で役割を選んで承認する → `status='active'`
4. 有効かつ担当県割当済みの利用者だけが、担当県の一覧・詳細を読める。未割当・承認待ち・無効の人には状態ごとの画面を出す

### 役割

- **管理者（admin）**: 担当県の一覧・詳細、候補者の登録・一括登録・編集・削除、同県利用者の管理。全国例外なし
- **閲覧者（viewer）**: 担当県の一覧・詳細のみ（登録・編集・削除のボタンと `admin.html` へのリンクは出さない）

### どこで守っているか

| 対象 | 仕組み |
|---|---|
| `v3_candidates` / `v3_progress` の読み取り | 最新migrationの県別RLS。active本人の承認済み担当県だけを許可。進捗は親候補者の県も確認し、未割当は拒否 |
| 候補者の登録・編集・削除 | Edge FunctionでJWTを検証し、サーバー専用RPCのtransaction内で実行者のactive/admin/担当県と対象の変更前・変更先県を照合 |
| 進捗の同期（`action=sync`） | 今までどおり `V3_SYNC_TOKEN` で照合（GitHub Actions 用。Apps Script にはトークンを置かない） |
| Edge Function の入口 | `v3-sync-progress` は Supabase の JWT 検証（`verify_jwt: true`）も有効。`v3-users` は `verify_jwt: false` で、関数の中の `getUser` で照合 |
| 利用者管理 | Edge Function `v3-users`と県別RPC。JWT検証後、DB内で有効な同県管理者か再照合。自己停止・役割変更・削除を拒否し、県単位で最後の管理者を保護 |
| `v3_users` | RLS 有効・ポリシーなし。画面からは直接読めず、`v3-users`（service_role）だけが扱う |
| ブラウザからの呼び出し元 | 両方の Edge Function の CORS を `https://kizan3x3.github.io` と `http://localhost:5500` だけに許可 |

画面のボタンの出し分けは見た目だけで、本当の判定は RLS と Edge Function で行います。

### 最初の管理者の作り方

1. 本番の画面で Google ログインし、表示名を入力して登録する（承認待ちになる）
2. 作成者が本人と担当県を確認し、SupabaseのSQL Editorで対象の1行だけを有効な同県管理者にする（下記UUID/県コードは例で、公開PRへ実利用者の値を保存しない）

   ```sql
   begin;
   select pg_advisory_xact_lock(861713903);
   update public.v3_users
      set status = 'active', role = 'admin', approved_at = now(), prefecture_code = '23'
    where id = '<確認済み利用者UUID>'::uuid;
   commit;
   ```

3. 画面で「承認されたか確認する」を押す。2人目以降も作成者による担当県設定が先で、同県管理者だけが `admin.html` から承認する。反映順と県割当は [担当県の手順](docs/prefecture-access.md) を参照

### 移行時に設定し直す項目

Supabase プロジェクトや公開 URL を変えるときは、次をすべて設定し直します。

| 項目 | 場所 | 内容 |
|---|---|---|
| OAuth クライアント | Google Cloud Console → API とサービス → 認証情報 | 種類「ウェブアプリケーション」。承認済みのリダイレクト URI に `https://<project-ref>.supabase.co/auth/v1/callback` |
| OAuth 同意画面 | Google Cloud Console → OAuth 同意画面 | アプリ名、サポートメール、プライバシーポリシーの URL（`.../privacy.html`）、スコープは `email`・`profile`・`openid` のみ。公開ステータスを「本番環境」にする（「テスト」のままだとテストユーザー以外ログインできない） |
| Google プロバイダー | Supabase → Authentication → Sign In / Providers → Google | 有効にして、OAuth クライアントの ID とシークレットを登録 |
| URL Configuration | Supabase → Authentication → URL Configuration | Site URL: `https://kizan3x3.github.io/election-progress-v3/`。Redirect URLs: `https://kizan3x3.github.io/election-progress-v3/**`、ローカル確認用に `http://localhost:5500/**` |
| CORS の許可元 | `supabase/functions/_shared/cors.ts` | 公開 URL のオリジンを変えたら書き換えて、両方の Edge Function を再デプロイ |
| `config.js` | リポジトリ | Supabase の URL と publishable key |
| Edge Function の secret | Supabase → Edge Functions → Secrets | `V3_SYNC_TOKEN`（`SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY` は自動で入る） |
| GitHub Secrets | GitHub → Settings → Secrets and variables → Actions | `V3_SYNC_TOKEN`、`SUPABASE_SECRET_KEY`、`GOOGLE_SERVICE_ACCOUNT_KEY_B64`（または `GOOGLE_SERVICE_ACCOUNT_KEY`） |
| ワークフローの publishable key | `.github/workflows/sync-sheets.yml` | `SUPABASE_KEY` |
| Apps Script のスクリプトプロパティ | 各 Apps Script プロジェクト | `GITHUB_PAT`（`dispatch-trigger.gs`）。`V3_SYNC_TOKEN` は置かない方針 |

### Edge Function のデプロイ

`verify_jwt`（Supabase の入口での JWT 検証）は関数ごとに次の設定を保ちます。`--no-verify-jwt` を付けてデプロイすると `false` に変わるので、`v3-sync-progress` には付けません。

| 関数 | verify_jwt | 理由 |
|---|---|---|
| `v3-sync-progress` | `true` | 同期の publishable key も、画面から送るログイン中の利用者のトークンも、この設定で入口を通る |
| `v3-users` | `false` | 関数の中の `getUser` で照合する |

事前の確認（設定は変えない）:

```bash
npx supabase functions list --project-ref hhlqgxmhbpfhjnjmradq   # 各関数の version と verify_jwt
```

デプロイ（`--use-api` は Docker を使わない指定。Docker が動いていれば無くてもよい）:

```bash
npx supabase functions deploy v3-users         --project-ref hhlqgxmhbpfhjnjmradq --no-verify-jwt --use-api
npx supabase functions deploy v3-sync-progress --project-ref hhlqgxmhbpfhjnjmradq --use-api
npx supabase functions list --project-ref hhlqgxmhbpfhjnjmradq   # v3-sync-progress: true / v3-users: false を確認
```

ロールバック（`v3-sync-progress` を前の版に戻す。`<commit>` は戻したい版のコミット）:

```bash
git checkout <commit> -- supabase/functions/v3-sync-progress/index.ts
npx supabase functions deploy v3-sync-progress --project-ref hhlqgxmhbpfhjnjmradq --use-api
git checkout HEAD -- supabase/functions/v3-sync-progress/index.ts
npx supabase functions list --project-ref hhlqgxmhbpfhjnjmradq   # verify_jwt: true のままであること
```

切り替えの手順は [`docs/cutover-2026-10-11.md`](docs/cutover-2026-10-11.md) を参照してください。

## Googleスプレッドシートからの自動同期

候補者ごとの進捗スプレッドシートに`v3_progress`の内容を自動反映する仕組みです。

- **手動反映（現在は使用停止）**: 候補者側のスプレッドシートに組み込まれたApps Scriptのメニュー「広報物進捗」→「進捗をアプリへ反映」ボタンは、現在は使用停止です。シートの変更は自動同期で最大15分ほどで反映されます。
- **自動反映（新規）**: `scripts/sync-sheets.mjs` が、`v3_candidates.sheet_id` が設定されている候補者のスプレッドシートをサービスアカウント（`v3-sheet-reader@election-progress-v3.iam.gserviceaccount.com`）経由で読み取り、Apps Script側と同じロジック（`findLabelValue` / `collectItems` / `buildRecords`）で`v3-sync-progress`にPOSTします。GitHub Actionsのワークフロー（`.github/workflows/sync-sheets.yml`）が5分おきに実行します。

候補者数の増加に備え、2段階の差分検知でスプレッドシートの中身のフル読み込みを最小限にしています。まずDrive API（`drive.metadata.readonly`スコープ、サービスアカウントは既に閲覧者として共有済みなので追加の認可は不要）で各候補者の`sheet_id`ごとに`modifiedTime`だけを軽量取得し、`v3_candidates.sheet_modified_at`（前回処理時点のmodifiedTime）と比較します。変化がある候補者だけ、従来通りSheets APIでの中身のフル読み込み・`v3-sync-progress`へのPOSTを行い、成功後に`sheet_modified_at`を更新します。変化が無い候補者はAPI呼び出しをスキップします。`modifiedTime`の取得自体に失敗した場合はフェイルセーフとして「要同期」扱いにする（本来のエラーはフル読み込み側で可視化される）ため、取得エラーで同期が永久にスキップされることはありません。

候補者のスプレッドシートは、自動同期の対象にするには以下が必要です。

1. `admin.html`の登録フォームで「GoogleスプレッドシートのURLまたはID」にそのシートのURL（またはID）を入力して`sheet_id`列に保存する
2. スプレッドシートを`v3-sheet-reader@election-progress-v3.iam.gserviceaccount.com`に「閲覧者」として共有する

シート内の「候補者ID」欄の値がDB上の`candidate_code`と一致しない場合、その候補者はエラーとしてスキップされます（他候補者の処理は継続）。1回の実行の成功/失敗件数はGitHub Actionsのログに出力されます。

`v3-sync-progress`（`supabase/functions/v3-sync-progress/index.ts`）は同期のたびに`v3_progress`を完全上書きしますが、同期前に既存の`item_name/required/status`と比較し、差分（項目の追加・削除・値の変化）があった候補者のみ`v3_candidates.last_updated_at`を現在時刻に更新します。差分が無い場合は`last_updated_at`を維持します。`list.html`の各候補者カードにこの`last_updated_at`を「最終更新: YYYY/MM/DD HH:mm」の形式で表示します。

### リアルタイム同期（プッシュ型）は不採用

`apps-script/candidate-realtime-sync.gs` は、候補者シートのonEditから`v3-sync-progress`へ直接プッシュする方式として実装しましたが、コピーされた候補者シートに紐づくApps ScriptプロジェクトはデフォルトのGCPプロジェクトのままとなり、都道府県担当者が「① 同期を有効化」を実行する際に「Google で確認されていないアプリ」の警告が出てしまうことが判明しました。600件規模での運用には不向きと判断し、不採用としました（ファイルは経緯の記録として残しています）。代わりに、既存のプル型同期を「差分検知型」に強化する方針で対応します。

### 必要なGitHub Secrets

- `V3_SYNC_TOKEN` — `v3-sync-progress` Edge Functionの認証トークン（`action=sync` 用）
- `SUPABASE_SECRET_KEY` — 候補者一覧の読み取り用の secret key（`sb_secret_`）。RLS で読み取りがログイン済みの利用者に限られるため、同期スクリプトはこのキーで読む。Edge Function には送らない
- `GOOGLE_SERVICE_ACCOUNT_KEY_B64` — サービスアカウント鍵（`service-account-key.json`）の中身を base64 にしたもの（推奨）
- `GOOGLE_SERVICE_ACCOUNT_KEY` — サービスアカウント鍵の中身をそのままJSON文字列として登録（`_B64` が未設定のときに使う）

## 担当県のアクセス制限

県別RLS、管理API、作成者による担当県割当、テストと本番反映順は [担当県アクセス制限の手順](docs/prefecture-access.md) を参照してください。未割当は閲覧不可で、管理者にも全国閲覧の例外はありません。
