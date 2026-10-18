# 担当県によるアクセス制限

利用者は、自分に割り当てられた1都道府県の候補者・進捗だけを閲覧する。`admin`にも全国例外を設けない。担当県は`v3_users.prefecture_code`の`01`〜`47`で管理し、NULLは業務アクセスを拒否する。

登録フォーム、`user_metadata`、リクエストの県や実行者IDから権限を付与しない。作成者が対応表を確認し、本番反映時に担当県を設定する。県担当の管理画面から県割当を変更する機能は提供しない。未割当の申請者は、割当の確認後に同県管理者が承認できる。

## 保護する経路

- 候補者SELECTはactive本人の担当県と一致する行だけ。進捗SELECTは親候補者を経由して同じ条件を適用する。
- 既存の全国SELECTポリシーを2表とも同じmigrationで置換する。旧ポリシーを併存させない。
- `service_role`はRLSを迂回するため、人間の管理APIはサーバー専用RPCを使い、DB内で実行者の現在の状態・役割・県、対象行の県を再確認する。県変更は変更前・変更先の両方を照合する。
- RPCの`p_actor_id`は検証済みJWTの本人IDだけを渡す。RPCはPUBLIC/anon/authenticatedから実行できず、service_roleのみが呼べる。
- 利用者管理も同県だけ。最後の有効な管理者を県単位で保護する。一覧は200件ずつのcursorページング。
- 機械同期は専用のサーバー資格情報で全国の同期を継続する。その秘密はブラウザへ渡さない。
- 県名は47都道府県の正式名。既存データとの互換としてASCIIスペースの前後だけを許容し、略称/未知/空欄は拒否する。既存の候補者レコードをこのmigrationで書き換えない。

`v3_private`はData APIの公開スキーマへ追加しない。RLS helperのSECURITY DEFINERは本人の現在の担当県だけを返し、空のsearch_path・限定したEXECUTEを使う。

## 本番反映の順序

この変更はフロントのマージだけで完了しない。作成者が確認した対応表とメンテナンス時間帯を用意し、実装SHA・Functionバージョン・migration・検証結果を対応付ける。

1. 対象プロジェクトが`election-progress / hhlqgxmhbpfhjnjmradq`であることを確認。現行ポリシー/GRANT/Functionを記録し、復旧方法を確認する。個人情報を公開ログやPRへ貼らない。
2. 利用者UUIDと担当県コードの対応を、作成者がアクセス制限した場所で確認。候補者の不明/空欄県を棚卸しする。既存全員への全国権限や、申告県の自動承認で代用しない。
3. 隔離環境でmigration・新Function・フロントを組み合わせ、A県/B県の直接REST/Function試験を行う。実環境のAuth・PostgREST・Edge配信と同じ条件の確認も行う。
4. メンテナンス中に新しい`v3-users`と`v3-sync-progress`を先に配信し、共有ファイルも含める。旧Functionの全国管理経路を残したまま、県制限を完了扱いにしない。列/RPCの追加前は新Functionが固定エラーで拒否するため、一時的な利用停止を予定する。
5. `20261018053254_restrict_prefecture_access.sql`を適用。既存アカウントには県を自動補完しない。作成者が下記の手順で担当県を設定する。
6. フロントを配信。未割当画面、本人の担当県表示、自県の正常操作、他県・未承認・停止済みの拒否を確認して利用を再開する。古いJWTで県割当の剥奪後の要求も拒否されることを確認する。
7. Security Advisor、実効ポリシー/GRANT、定期同期、非公開の監査記録を確認する。通常の利用者・Google Sheetsの更新を本番で破壊する試験は行わない。

県の割当/変更/剥奪は、限定したDB運用者だけが実行する。実際のUUIDは公開PRに保存せず、次の例のプレースホルダーを確認済みの値へ置き換える。状態・役割はこのUPDATEでは変更しない。

```sql
begin;
select pg_advisory_xact_lock(861713903);
-- 例: 確認済みの本人へ愛知県(23)を割り当てる。1行だけ更新されることを確認。
update public.v3_users set prefecture_code = '23'
 where id = '<確認済み利用者UUID>'::uuid;
commit;
```

剥奪は同じtransaction/lockで`prefecture_code = NULL`へ変更する。割当のcommit後の次の要求からDBの現在値で判定する。先に認可・commit済みの処理や既に端末へ表示された情報を取り消す機能ではない。候補者の所属県をDBから直接変更する場合も、担当県・監査・対象行ロックを確認した運用手順に従う。

切り戻しで全国SELECT、匿名GRANT、旧公開トークンを復活させない。業務を停止したまま保護を維持して修復する。古いフロント/Functionだけを戻すと県外管理操作を再び許すため、一部だけの旧版復元は行わない。

## テスト

Node 24で次を実行する。通常のテストは外部API・実データ・本番資格情報を使わない。

```sh
npm ci --ignore-scripts
npm test
```

公開ログのcanary回帰、実画面スクリプトのDOM/APIモック、JWT/役割/担当県を検証する実Edge handler、PGliteのPostgreSQL 18.6で実際のmigration/RLS/GRANT/RPCを実行する。PGliteの単一接続だけでは同時実行を証明しない。

CIは専用PostgreSQL 17で独立接続の競合テストも実行する。手動実行する場合も、空の破棄可能なDB`scope_security_test`とloopback IPだけを使用する。接続先のquery/hashは許可しない。fixtureはrole/schemaを作成するため、本物のプロジェクトへ実行しない。

```sh
TEST_DATABASE_URL=postgresql://postgres:synthetic-tests-only@127.0.0.1:5432/scope_security_test npm test
```

担当県を剥奪するtransactionが実行中の管理操作を待つこと、並行した相互停止でも有効な管理者が1人残ることを、advisory lockと行ロックの待機を実測して確認する。ローカルでTEST_DATABASE_URLがなければ、この多接続suiteはskipと表示される。

EdgeはSupabase SDKを2.117.3に固定し、`supabase/functions/deno.lock`を保存する。Deno 2.9.7の通常アプリ型検査とcleanupテスト:

```sh
deno check --no-config --node-modules-dir=none --frozen-lockfile --lock=supabase/functions/deno.lock supabase/functions/v3-sync-progress/index.ts supabase/functions/v3-users/index.ts supabase/functions/_shared/auth.ts supabase/functions/_shared/prefectures.ts supabase/functions/_shared/scoped-rpc.ts supabase/functions/_shared/cors.ts supabase/functions/v3-sync-progress/cleanup_test.ts
deno test --no-config --node-modules-dir=none --frozen-lockfile --lock=supabase/functions/deno.lock supabase/functions/v3-sync-progress/cleanup_test.ts
```

通常アプリ型検査は成功。第三者SDK内部までの`--all`はSDKのDOM/Node型不整合が残るため、全SDK内部の型検査成功とは扱わない。証明書検証や型検査を無効化しない。実プラットフォームへのbundle/deploy互換性は隔離環境の配信手順でも確認する。

## キーの扱い

- `sb_publishable_...`はブラウザで公開される前提のキー。隠しても画面から取得できるため、RLS・承認・担当県の認可で保護する。
- `sb_secret_...`、service_role、同期トークン、Googleサービスアカウント秘密鍵、PAT等はサーバー/CIに限定する。漏えいが確認された場合は供給元で失効・交換し、利用先を更新する。gitignoreやソース削除だけでは失効しない。
- 履歴の旧同期トークンと現在Supabase SecretのSHA256は不一致で、2026-10-08の交換を裏付ける。別GAS/旧環境での再利用は作成者が確認する。秘密値はPRや公開ログへ貼らない。
- この変更で既存の公開ログや外部の保存コピーは消えない。制限した証拠保全と過去ログの公開解消は管理者の別作業とする。

公式資料: [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html)。
