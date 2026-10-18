-- Synthetic compatibility schema only. Never run against a real project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_admin nologin;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant all on table auth.users to service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Model the broad legacy grants, so real migrations must remove them.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

create table public.v3_candidates (
  id uuid primary key default gen_random_uuid(),
  candidate_code text unique not null,
  name text not null,
  election_name text,
  prefecture text,
  sheet_id text,
  created_at timestamptz not null default now(),
  last_updated_at timestamptz,
  sheet_modified_at timestamptz
);

create table public.v3_progress (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.v3_candidates(id) on delete cascade,
  period text not null,
  item_name text not null,
  required boolean not null default false,
  status text not null,
  updated_at timestamptz not null default now(),
  unique(candidate_id, period, item_name)
);
