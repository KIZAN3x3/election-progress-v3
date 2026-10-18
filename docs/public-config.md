# 公開用キーをGitHubソースから外す

GitHub Pagesは従来の`main:/`配信を維持する。`config.js`はURLだけを持つclassic scriptのままとし、匿名GETで`v3-public-config`から公開用キーを取得する。ブラウザの通信ではキーを取得できる。これはGitHubソースへの実値の埋め込みをやめる変更であり、ブラウザでの完全秘匿やRLSの代替ではない。

## 設定と互換性

- 新FunctionはSDK・DB接続を使わない。自動注入される`SUPABASE_PUBLISHABLE_KEYS`のJSON辞書からown propertyの`default`だけを読み、厳密な`sb_publishable_`形式を検証して`{publishable_key}`だけ返す。秘密キー、legacy JWT、欠落・不正な辞書は固定503で拒否し、別キーへ切り替えない。
- 新Functionの`verify_jwt`は`false`。キー取得前のブラウザが`apikey`なしで呼べる必要がある。既存`v3-users`・`v3-sync-progress`の認証や設定は変えない。
- GETの成功応答は`public, max-age=300`、失敗は`no-store`。既存の許可originを使い、GET/OPTIONSだけを案内する。CORSはブラウザの制限であり、この公開キーを秘密にする機能ではない。
- `SUPABASE_CONFIG_READY`は8秒以内に成功/失敗へ収束するPromise。`auth.js`はログイン・セッション確認・API・ログアウトの各非同期入口で完了を待つ。`getSupabase()`は同期APIを維持し、準備前にはクライアントを作らない。失敗は固定Errorで既存画面のcatchへ届ける。
- 設定取得不能でSDKをまだ作れない場合も、ログアウトは対象プロジェクトの端末内セッション・PKCEキーだけを除去する。他のプロジェクトや設定は消さない。この非常時の処理はサーバー側のセッション失効ではない。ブラウザがstorage削除を拒否した場合はログアウト失敗を表示する。
- 4HTMLのconfig/authの読込URLに同じ版queryを付け、旧同期configと新非同期authがcacheで混在するのを避ける。HTMLの操作や認証APIの形は維持する。
- 同期workflowの`SUPABASE_KEY`はrepository secretの`SUPABASE_PUBLISHABLE_KEY`から渡す。キーは公開用だが、secretを使うことでActionsのenv表示でもマスクする。既存`SUPABASE_SECRET_KEY`と`V3_SYNC_TOKEN`は別の設定であり、この変更では交換しない。
- 不採用の`candidate-realtime-sync.gs`は実キーをplaceholderへ置換した。実際のGASコピーやトリガーの変更を行ったわけではない。

## サイトを先に切り替えない手順

1. 現行サイトとmainを維持したまま、新Functionと`_shared/cors.ts`を配信する。対象プロジェクトを確認し、新Functionだけ`verify_jwt=false`にする。CLIを使う場合の例:

   ```powershell
   npx supabase functions deploy v3-public-config --project-ref hhlqgxmhbpfhjnjmradq --no-verify-jwt --use-api
   ```

2. `apikey`・AuthorizationなしのGETで200、JSONが公開用キー1値だけ、返るキーが現行configのキーと同じであることをメモリ内のboolean比較で確認する。値・辞書・レスポンス本文はログ/ファイル/チャットへ残さない。実Pages originのCORSとOPTIONS、POST=405も確認する。失敗する場合はフロントをまだ切り替えない。自動注入辞書が提供されない環境でも、secretキーやソース固定値で補完しない。
3. GitHubのrepository secretに`SUPABASE_PUBLISHABLE_KEY`を登録する。現行公開キーを同じ値のまま移す。名称だけでなく設定済みであることを確認し、値は表示しない。
4. レビュー済みのフロント・workflow・GAS sample変更をmainへ反映する。Pagesのビルドが完了してから、匿名ログイン画面と設定GETの200、利用者の通常ログイン・画面遷移・API、定期同期の集計結果を確認する。個人情報の取得・書換え・ユーザー削除を疎通テストにしない。
5. 履歴の削除はこの配信確認後に別作業として行う。current sourceから実キーを外しても、既存のGit履歴・コピー・cacheは自動で消えない。今回の前提となる既存公開キーを、配信確認前に無効化しない。

Pagesの設定変更は不要。Supabaseの公式権限表ではDeveloperにFunction更新権限があるが、実際のproject role・接続scopeで配信できることを別途確認する。Secret/DB/Authの変更はこのFunctionの配信要件ではない。

GitHubの接続がworkflowファイル更新scopeを持たない場合、`.github/workflows/sync-sheets.yml`のpushが拒否される。ファイル変更を黙って省いて完了にせず、所有者がGitHub UIまたは適切なworkflow更新権限の接続で同じsecret参照へ変更し、現行ソースに実値が残らないことを確認する。secretの設定が済む前にworkflowだけを切り替えない。

障害時は新Functionの配信・自動注入・CORSを修復する。ブラウザは8秒で固定エラー表示へ移り、再読み込みで再試行する。旧キーをソースへ再埋め込みするfallbackはない。

## ローカル検証

Node 24以上、実際のソースをVMで実行し、fetch/SDK/環境を架空fixtureへ置換する。本番接続・資格情報・実データを使わない。

```powershell
node --disable-warning=ExperimentalWarning --test scripts/public-config.test.mjs supabase/functions/v3-public-config/test.mjs
node --test scripts/sync-sheets.test.mjs
```

新Functionは外部依存がないため、Deno 2.9.7でネットワークを使わず型検査できる。

```powershell
deno check --no-config --node-modules-dir=none --no-lock --cached-only supabase/functions/v3-public-config/index.ts
```

参考: [Supabaseの環境変数](https://supabase.com/docs/guides/functions/secrets)、[権限表](https://supabase.com/docs/guides/platform/access-control)、[GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。
