# election-progress-v3

参政党 選挙準備進捗管理システム v3。Supabase (`v3_candidates` / `v3_progress` テーブル) を参照して、候補者ごとの広報物準備の進捗状況を確認するための静的フロントエンドです。ビルド不要の素のHTML/JS構成で、Supabase REST APIを直接呼び出します。

## ページ構成

- `index.html` — パスワード入力画面。正しいパスワード（コード内埋め込みの簡易方式）を入力すると `list.html` へ遷移します。
- `list.html` — 候補者一覧。`v3_candidates` を全件取得し、`v3_progress` の集計から達成率（%）を算出して、候補者名・選挙名とともに一覧表示します。候補者名をクリックすると詳細ページへ移動します。
- `detail.html?id=<candidate_id>` — 候補者詳細。対象候補者の `v3_progress` を「政治活動期間」「選挙期間」に分けて、項目ごとにステータス（未着手／着手中／納品完了）を表示します。
- `config.js` — Supabase接続情報（URL・Publishable key）。
- `status-map.js` — `v3_progress.status` の生の文字列を「未着手／着手中／納品完了」の3段階に変換するマッピング（list.htmlとdetail.html共通）。未知のステータス値は保険的に「着手中」として扱います。

## 達成率の算出方法

候補者ごとに、`v3_progress` の全項目のうち `status` が「納品完了」段階にマッピングされる項目数の割合を達成率（%）として算出します。

## 認証について

`index.html` で入力したパスワードに応じて `sessionStorage` に `v3_auth` フラグを立てます。

- `123123` → `v3_auth='1'`（管理者。候補者の登録・一括登録・削除が可能）
- `123` → `v3_auth='2'`（閲覧のみ。一覧・詳細の閲覧のみ可能。登録リンクや削除ボタンは非表示）

`list.html` / `detail.html` / `admin.html` はこのフラグを確認し、`'1'`・`'2'` のいずれでもなければログイン画面へ戻します。あくまで簡易的な閲覧制限であり、堅牢な認証機構ではありません。

## Googleスプレッドシートからの自動同期

候補者ごとの進捗スプレッドシートに`v3_progress`の内容を自動反映する仕組みです。

- **手動反映（既存・そのまま利用可）**: 候補者側のスプレッドシートに組み込まれたApps Scriptのメニュー「広報物進捗」→「進捗をアプリへ反映」ボタンで、いつでも即時反映できます。
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

- `V3_SYNC_TOKEN` — `v3-sync-progress` Edge Functionの認証トークン
- `GOOGLE_SERVICE_ACCOUNT_KEY` — サービスアカウント鍵（`service-account-key.json`）の中身をそのままJSON文字列として登録
