# 利用者管理の並行更新対策

従来の全国の承認済みユーザー閲覧、全国管理者の利用者管理、自己停止・自己役割変更・自己削除の拒否を維持する。都道府県の割当列や閲覧制限は追加しない。

以前はEdge Functionで管理者人数を数え、その後に別HTTP要求で更新していた。管理者が互いを同時に停止すると、両方の人数確認が通る可能性があった。新しい`v3_manage_users_atomic` RPCは共通advisory transaction lockを最初に取得し、現在のactorをDBで再確認して対象行をロックし、人数確認と更新を同じtransactionで行う。Edgeは検証済みJWTのuser IDだけをactorとして渡し、bodyに書かれたactorは利用しない。

RPCのownerはpostgres、`search_path=''`、EXECUTEはservice_roleのみ。PUBLIC/anon/authenticatedから明示的に剥奪する。SECURITY DEFINERが必要なのは、同じtransactionで保護されたアプリ行とAuthアカウントを削除し、削除後の再登録行を遅れたHTTP要求が消す競合を防ぐため。SQLは固定され、動的SQLは使わない。一般利用者からは呼べない。

Auth削除がStorageの所有者FK等で失敗したときは、その内側の削除だけをrollbackし、旧UIと同じ`ok:true, auth_deleted:false`の固定warningを返す。既にあった承認日時・承認者はenableで上書きしない。Auth削除に成功するとsessions等は実際のFKに従ってcascadeする。既発行access JWTそのものの即時失効は保証しない。アプリ行の削除により、既存のactive判定/RLSは権限を与えない。

## 配信順と確認

1. 現行DBのAuth FK/cascadeとpostgresのAuth DELETE権限を読取確認する。Storage等の削除を妨げる依存関係を把握する。実ユーザーを削除する疎通試験はしない。
2. `20261018064836_atomic_v3_user_management.sql`をレビュー・適用する。このmigrationは関数だけを作成し、既存ユーザー、候補者・進捗のデータ/RLSは変更しない。
3. `v3-users`と共有ファイルを配信する。migration未適用で配信すると管理操作は500で停止する。切替中は利用者の停止・役割変更・削除を行わず、旧実装の進行中要求を終えてから再開する。ログイン・承認・正規の管理操作を確認する。
4. 関数owner/search_path/EXECUTEをカタログで再確認する。例外ログは固定分類のみで、SQLエラーや秘密値・利用者情報を出力しない。

人数保護は同RPCと同じlock規約を守る書込経路について保証する。OwnerによるDashboard/Auth APIの直接削除、手動SQLは迂回できるため、運用作業もtransaction内で最初に`select pg_advisory_xact_lock(861713903)`を取得し、管理者を最低1人維持する。古いEdge実装への切戻しは並行更新の問題を復活させるため、通常の復旧手順にしない。

## テスト

Node 24で`npm ci --ignore-scripts`、`npm test`。PGlite 0.5.10（PostgreSQL 18.6）の実SQLテスト、実handlerのVMテストは合成データだけを使用する。VMにはprocess/fetch/本番環境を渡さない。

実際の複数接続の検証は使い捨てPostgreSQL 17とpsqlを使う。`V3_ADMIN_TEST_DATABASE_URL`を設定しないローカル環境ではこのsuiteだけを明示skipする。CIの`backend-security-checks.yml`では必ず設定する。接続先はloopback IP、DB名`v3_admin_security_test`だけを許可し、URI query/hashによるlibpq接続先の上書きを拒否する。テスト用DBにはfixtureが適用され、ユーザー等が削除されるので既存DBを指定しない。各接続にはSQL/lock/接続timeoutを設定する。

同時停止・降格・削除を単なるsleepに依存せずgateで調整し、後続がadvisory lockで実際に待機していることを観測してから先行transactionをcommitする。待機中のactor失効と、アプリ削除/Auth削除の間に同IDを再登録できないことも確認する。

公式仕様: [User Management](https://supabase.com/docs/guides/auth/managing-user-data)、[Database functions](https://supabase.com/docs/guides/database/functions)、[PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)。
