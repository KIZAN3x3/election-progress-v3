-- 0001: Googleログイン＋管理者承認制の利用者テーブル
--   ・v3_users（auth.users と 1対1）を作る。RLS は有効・ポリシーなし（画面からは直接読めない。Edge Function v3-users が service_role で扱う）
--   ・is_active_user() / is_admin_user() を作る（0002 の RLS ポリシーと、必要に応じて画面から rpc で使う）
--   ・既存の v3_candidates / v3_progress には一切触れない
--
-- 実行方法: Supabase ダッシュボードの SQL Editor で begin; 〜 commit; を実行する
-- 何度実行しても壊れない（create table if not exists / create or replace function）
--
-- 元に戻す SQL（0002 を適用済みなら、先に 0002 を戻すこと。0002 のポリシーが is_active_user() を使っているため）:
--   begin;
--   drop function if exists public.is_admin_user();
--   drop function if exists public.is_active_user();
--   drop table if exists public.v3_users;
--   commit;
--   ※ auth.users に作られた Google のログイン情報は残る。不要なら Authentication 画面から削除する

begin;

create table if not exists public.v3_users (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  display_name  text not null
                  constraint v3_users_display_name_check check (char_length(btrim(display_name)) between 1 and 50),
  status        text not null default 'pending'
                  constraint v3_users_status_check check (status in ('pending', 'active', 'disabled')),
  role          text not null default 'viewer'
                  constraint v3_users_role_check check (role in ('admin', 'viewer')),
  approved_at   timestamptz,
  -- 承認した管理者。その管理者が削除されたら空にする（削除を外部キーで止めないため）
  approved_by   uuid references public.v3_users (id) on delete set null,
  last_login_at timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.v3_users is '利用者（Googleログイン）。auth.users と1対1。Edge Function v3-users（service_role）からのみ読み書きする';
comment on column public.v3_users.status is 'pending=承認待ち / active=有効 / disabled=無効';
comment on column public.v3_users.role is 'admin=管理者（候補者の登録・編集・削除、利用者管理） / viewer=閲覧者';

create index if not exists idx_v3_users_status on public.v3_users (status);

alter table public.v3_users enable row level security;
-- ポリシーは作らない。念のため anon / authenticated の権限も外す
revoke all on table public.v3_users from anon, authenticated;

-- ログインしていて、v3_users の状態が active か
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.v3_users u
    where u.id = (select auth.uid())
      and u.status = 'active'
  );
$$;

-- ログインしていて、v3_users の状態が active かつ役割が admin か
create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.v3_users u
    where u.id = (select auth.uid())
      and u.status = 'active'
      and u.role = 'admin'
  );
$$;

revoke execute on function public.is_active_user() from public;
revoke execute on function public.is_active_user() from anon;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.is_active_user() to service_role;

revoke execute on function public.is_admin_user() from public;
revoke execute on function public.is_admin_user() from anon;
grant execute on function public.is_admin_user() to authenticated;
grant execute on function public.is_admin_user() to service_role;

commit;

-- ============================================================
-- 確認用の SELECT（適用後に実行）
-- ============================================================
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'v3_users'
--  order by ordinal_position;
--
-- select c.relname, c.relrowsecurity from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'v3_users';
--
-- select p.proname, p.prosecdef, p.proconfig,
--        has_function_privilege('anon', p.oid, 'execute')          as anon_can_execute,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('is_active_user', 'is_admin_user');
