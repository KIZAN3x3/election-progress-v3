-- 0002: 閲覧の締め出し（v3_candidates / v3_progress の読み取りを、ログインしている有効な利用者だけにする）
--   ・2つの表の既存ポリシーをすべて削除し、「for select to authenticated using ((select public.is_active_user()))」だけにする
--   ・anon からは全権限を外す。authenticated からは insert / update / delete / truncate を外す（読み取りだけ残す）
--   ・表の行は一切削除・上書きしない（ポリシーと権限の変更だけ）
--   ・Edge Function（service_role）と同期スクリプト（secret key = service_role）は RLS を通らないので影響なし
--   ・ログインしていない・承認待ち・無効の人は、エラーではなく 0 件になる
--
-- 前提: 0001_v3_users.sql を適用済み（is_active_user() を使う）。画面の新しいコード（feature/google-auth）を本番に出してから適用する
--
-- 実行方法: SQL Editor で次の順に実行する
--   (0) 下の「記録用の SELECT」を実行し、結果を CSV などで残す（元に戻すときに使う）
--   (1) このファイルの begin; 〜 commit; を実行する
--   (2) 末尾の「確認用の SELECT」を実行する
--
-- ============================================================
-- 記録用の SELECT（適用前に実行して、結果を残す）
-- ============================================================
-- select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
--   from pg_policies
--  where schemaname = 'public' and tablename in ('v3_candidates', 'v3_progress')
--  order by tablename, policyname;
--
-- select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname in ('v3_candidates', 'v3_progress');
--
-- select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name in ('v3_candidates', 'v3_progress')
--    and grantee in ('anon', 'authenticated')
--  group by table_name, grantee
--  order by table_name, grantee;
--
-- select (select count(*) from public.v3_candidates) as candidates,
--        (select count(*) from public.v3_progress)   as progress;

begin;

alter table public.v3_candidates enable row level security;
alter table public.v3_progress   enable row level security;

-- 2つの表の既存ポリシーをすべて削除する（行は消えない）
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public' and tablename in ('v3_candidates', 'v3_progress')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end
$$;

create policy "v3_candidates_select_active_users" on public.v3_candidates
  for select to authenticated
  using ((select public.is_active_user()));

create policy "v3_progress_select_active_users" on public.v3_progress
  for select to authenticated
  using ((select public.is_active_user()));

revoke all on table public.v3_candidates from anon;
revoke all on table public.v3_progress   from anon;

revoke insert, update, delete, truncate on table public.v3_candidates from authenticated;
revoke insert, update, delete, truncate on table public.v3_progress   from authenticated;

-- 読み取り権限が外れていた場合に備えて付け直す（行の絞り込みは上のポリシーで行う）
grant select on table public.v3_candidates to authenticated;
grant select on table public.v3_progress   to authenticated;

commit;

-- ============================================================
-- 確認用の SELECT（適用後に実行）
-- ============================================================
-- 見込み: 2行。roles = {authenticated}、cmd = SELECT、qual に is_active_user() を含む
-- select tablename, policyname, roles, cmd, qual
--   from pg_policies
--  where schemaname = 'public' and tablename in ('v3_candidates', 'v3_progress')
--  order by tablename;
--
-- 見込み: anon の行は無し。authenticated は SELECT だけ（REFERENCES / TRIGGER が残っていても読み書きには影響しない）
-- select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name in ('v3_candidates', 'v3_progress')
--    and grantee in ('anon', 'authenticated')
--  group by table_name, grantee
--  order by table_name, grantee;
--
-- 見込み: 適用前と同じ件数
-- select (select count(*) from public.v3_candidates) as candidates,
--        (select count(*) from public.v3_progress)   as progress;
--
-- ============================================================
-- 元に戻す SQL（適用前の状態に戻す）
-- ============================================================
-- 「記録用の SELECT」の結果をもとに、元のポリシーと権限を作り直す。下は、元が「誰でも読める」ポリシーだった場合の例。
-- 記録した policyname / roles / cmd / qual に合わせて書き換えてから実行すること。
--
-- begin;
-- drop policy if exists "v3_candidates_select_active_users" on public.v3_candidates;
-- drop policy if exists "v3_progress_select_active_users"   on public.v3_progress;
--
-- -- 例: 記録が「<元の名前> / {public} / SELECT / true」だった場合
-- create policy "<元のポリシー名>" on public.v3_candidates for select to public using (true);
-- create policy "<元のポリシー名>" on public.v3_progress   for select to public using (true);
--
-- -- 権限を Supabase の既定（anon / authenticated に全権限）に戻す。記録と違えば記録に合わせる
-- grant all on table public.v3_candidates to anon, authenticated;
-- grant all on table public.v3_progress   to anon, authenticated;
--
-- -- 記録で rls_enabled = false だった表があれば、その表だけ戻す
-- -- alter table public.v3_candidates disable row level security;
-- -- alter table public.v3_progress   disable row level security;
-- commit;
