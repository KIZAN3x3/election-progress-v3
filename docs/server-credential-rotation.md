# サーバー資格情報の切替

2026-10-18のmain（`e6af827`）を基準に、2本のEdge Functionの起動時に使う管理用APIキーだけを選択する。利用者JWTの`getUser`照合、管理者判定、同期の`V3_SYNC_TOKEN`照合、`verify_jwt`設定は変更しない。全国の閲覧・管理機能、利用者管理のatomic RPC、同期の全件入力検証と候補者ごとの失敗追跡も維持する。

## キーの選択

| 設定 | 動作 |
|---|---|
| `V3_BACKEND_KEY_NAME`が未設定 | 移行準備中に限り、自動注入される`SUPABASE_SERVICE_ROLE_KEY`を使用 |
| `V3_BACKEND_KEY_NAME`が設定済み | 自動注入される`SUPABASE_SECRET_KEYS`のJSON辞書から、その名前の`sb_secret_`キーだけを使用 |
| 明示した名前・辞書・値が欠落または不正 | 固定メッセージで起動失敗。legacyキーや`default`への切替なし |

`V3_BACKEND_KEY_NAME`はキー自体ではなく、Supabaseで作成したキーの名前を指定する非秘密のselector。空文字も設定不備として拒否する。`default`キーを自動選択しない。交換対象の既存キーを継続利用しないよう、作成者が新しい専用キーを作り、その名前を明示する。

`SUPABASE_SECRET_KEYS`・`SUPABASE_SERVICE_ROLE_KEY`はSupabase側の自動注入を使う。`SUPABASE_`接頭辞の変数を独自secretとして手動登録しない。辞書全体やキーの値を表示・ログ出力して確認しない。

## 実行順

1. Owner/Adminが対象プロジェクトと全利用先を確認する。旧サイト・他のEdge Function・CI・DB webhook/cron等に旧キー依存がないか確認する。このPRを配信しただけでは旧キーの交換は完了しない。
2. **selectorを未設定のまま**この2Functionと共有ファイルを先行配信する。既存キーによる疎通を確認する。`v3-sync-progress`の`verify_jwt: true`、`v3-users`の`false`は既存設定を保つ。
3. SupabaseのAPI Keysで新しいサーバー専用secret keyを作成する。自動注入辞書に選択対象の名前が提供される環境であることを確認する。キーをチャット・コード・公開ログへ貼らない。
4. Supabase Edge Function Secretsで`V3_BACKEND_KEY_NAME`にその**キー名**を設定する。旧APIキーを無効化する前に、この設定と適用確認が必須。設定は両Functionに影響する。適用後に両方の疎通を確認し、エラーなら旧キーをまだ停止しない。
5. 同期用`sb_secret_`も交換する場合は、同期専用の新キーを作成し、GitHub Actionsの`SUPABASE_SECRET_KEY`を更新する。このキーは一覧のREST読取に`apikey`ヘッダーだけで使い、Edge Functionには送らない。Edgeの管理用キーとは独立している。HEAD・`limit=0`等で本文を取得せずに認証を確認し、通常同期の集計結果を確認する。Edge呼出時の公開用キーと利用者JWTの送信方式は維持する。
6. `V3_SYNC_TOKEN`も交換する場合は、GitHub定期実行とGASからの起動を一時停止する。既存実行を終え、待機実行を残さず、GitHubとSupabaseの同名secretを同じ新トークンに更新する。新旧同時受理には対応していない。空の`records: []`なら新トークンで400（`invalid sync payload`）、旧または不正トークンで401となり、DB読書きなしで照合を確認できる。Functionの入口で必要な既存の公開用キーによる認証も付ける。秘密トークンを出力するコマンドや履歴へ残る引数を使わない。
7. 全利用先の切替と通常運用の確認後、交換対象の旧secretを削除する。削除は取り消せない。legacy APIキーの無効化は別途プロジェクト全体の旧`anon`・`service_role`両方に影響するため、旧サイト・他製品を含む依存が不明な間は実行しない。新設定で両Functionが動作することと、停止を承認した旧キーが拒否されることを、値・レスポンス本文を保存せず確認する。停止した同期起動を再開する。

確認には架空データまたは本文なしの要求を使い、ユーザー削除や実データの書換えを疎通テストとして行わない。同期の正常実行確認は通常の業務実行として行い、出力は既存の固定分類・HTTPステータス・件数に限定する。

`apps-script/candidate-realtime-sync.gs`はREADMEで不採用とされているが、コピー先で実際に稼働していないか確認する。停止済みなら旧トークンとトリガーを廃止し、新トークンを候補者シートへ配布しない。`dispatch-trigger.gs`はGitHub起動用PATだけを使う。

selector設定後の不備は意図的に停止する。修正は名前と自動注入辞書の対応を直す。漏えいした旧キーの再使用を通常の復旧手順にしない。legacy APIキー停止後にselectorを削除しても復旧しない。

今後別ブランチを配信する場合も、このhelperと2Functionの起動部を取り込み、まとめてテストしてから配信する。古いFunction全体で上書きすると、停止したlegacyキーへの依存や、修正済みの同期・利用者管理の問題が戻る。

AuthのJWT署名鍵のrotationは独立した作業であり、この手順には含めない。署名方式を変える場合は、既存のgateway JWT検証とセッションへの影響を別途確認する。

## オフライン検証

Node 24以上。テストは実際のhelperと2Functionの起動部をVMで実行し、架空のキーだけを渡す。VMには`process`・`fetch`・本番環境変数を提供しない。

```powershell
npm test
```

Deno 2.9.7で型検査と既存cleanupテスト。依存関係は固定したSDK 2.117.3と`supabase/functions/deno.lock`を使う。リポジトリのルートで実行する。`--cached-only`を使う場合は、同じlockの依存関係を取得済みのDenoキャッシュを指定する。`--no-config`と`--node-modules-dir=none`の両方でローカルのnpm依存関係から分離する。lockは更新しない。

```powershell
deno check --no-config --node-modules-dir=none --cached-only --frozen --lock=supabase/functions/deno.lock supabase/functions/v3-sync-progress/index.ts supabase/functions/v3-users/index.ts supabase/functions/_shared/auth.ts supabase/functions/_shared/backend-key.ts supabase/functions/_shared/cors.ts supabase/functions/v3-sync-progress/cleanup_test.ts
deno test --no-config --node-modules-dir=none --cached-only --frozen --lock=supabase/functions/deno.lock supabase/functions/v3-sync-progress/cleanup_test.ts
```

公式仕様: [新APIキーへの移行](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)、[Edgeの環境変数](https://supabase.com/docs/guides/functions/secrets)、[JWT署名鍵](https://supabase.com/docs/guides/auth/signing-keys)。
