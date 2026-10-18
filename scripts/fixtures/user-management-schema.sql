-- Disposable synthetic database only. Never apply this fixture to a project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text);
create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users on delete cascade);
create schema storage;
create table storage.objects(id uuid primary key default gen_random_uuid(),owner uuid references auth.users);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
create table public.v3_candidates(id uuid primary key default gen_random_uuid(),prefecture text);
create table public.v3_progress(id uuid primary key default gen_random_uuid(),candidate_id uuid references public.v3_candidates on delete cascade);
