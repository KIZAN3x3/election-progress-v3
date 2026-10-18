-- Human access is limited to one explicitly assigned prefecture. No backfill:
-- existing accounts remain unassigned until a trusted database operator assigns them.
-- Deploy the new Edge Functions before this migration; see docs/prefecture-access.md.
begin;

alter table public.v3_users add column prefecture_code text
  constraint v3_users_prefecture_code_check check (
    prefecture_code is null or (
      char_length(prefecture_code) = 2 and
      prefecture_code ~ '^(0[1-9]|[1-3][0-9]|4[0-7])$'
    )
  );
comment on column public.v3_users.prefecture_code is
  'Trusted operator assignment only: 01..47, NULL denies business access. Never set from registration or user_metadata.';
create index idx_v3_users_prefecture on public.v3_users (prefecture_code, id);

create schema if not exists v3_private;
revoke all on schema v3_private from public, anon, authenticated;
grant usage on schema v3_private to authenticated, service_role;
-- This schema must not be added to Data API exposed schemas.
create function v3_private.prefecture_code(p_name text)
returns text language sql immutable strict set search_path = '' as $$
  select pg_catalog.lpad(pg_catalog.array_position(array[
    '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県',
    '埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県',
    '岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
    '鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県',
    '佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'
  ]::text[], pg_catalog.btrim(p_name))::text, 2, '0');
$$;
revoke all on function v3_private.prefecture_code(text) from public, anon, authenticated;
grant execute on function v3_private.prefecture_code(text) to authenticated, service_role;

-- The only privileged RLS lookup returns the caller's current approved scope.
create function v3_private.current_prefecture_code()
returns text language sql stable security definer set search_path = '' as $$
  select u.prefecture_code from public.v3_users u
   where u.id = (select auth.uid()) and u.status = 'active'
     and char_length(u.prefecture_code) = 2
     and u.prefecture_code ~ '^(0[1-9]|[1-3][0-9]|4[0-7])$';
$$;
revoke all on function v3_private.current_prefecture_code() from public, anon, authenticated;
grant execute on function v3_private.current_prefecture_code() to authenticated, service_role;

-- Replace both policies atomically. An old permissive policy left alongside the
-- new one would OR with it and retain nationwide access.
do $$ declare p record; begin
  for p in select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in ('v3_candidates','v3_progress')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
alter table public.v3_candidates enable row level security;
alter table public.v3_progress enable row level security;
create policy v3_candidates_select_assigned_prefecture on public.v3_candidates
  for select to authenticated using (
    v3_private.prefecture_code(prefecture) = (select v3_private.current_prefecture_code())
  );
create policy v3_progress_select_assigned_prefecture on public.v3_progress
  for select to authenticated using (
    exists (select 1 from public.v3_candidates c
      where c.id = v3_progress.candidate_id
        and v3_private.prefecture_code(c.prefecture) = (select v3_private.current_prefecture_code()))
  );
revoke all on public.v3_candidates, public.v3_progress from anon, authenticated;
grant select on public.v3_candidates, public.v3_progress to authenticated;
revoke all on public.v3_users from anon, authenticated;

-- Edge Functions use service_role, so RLS alone cannot protect their mutations.
-- Actor IDs must originate from auth.getUser(), never a request body's identity.
create function public.v3_manage_candidate(
  p_actor_id uuid, p_action text, p_candidate_id uuid default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  actor public.v3_users%rowtype;
  target public.v3_candidates%rowtype;
  next_prefecture text;
  next_name text;
  next_election text;
  next_sheet text;
  next_code text;
begin
  select * into actor from public.v3_users where id = p_actor_id for share;
  if not found or actor.status <> 'active' or actor.role <> 'admin'
    or actor.prefecture_code is null then
    return jsonb_build_object('ok',false,'status',403,'code','FORBIDDEN','error','この操作は許可されていません');
  end if;
  if p_action is null or p_action not in ('createCandidate','updateCandidate','deleteCandidate')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok',false,'status',400,'code','INVALID_INPUT','error','入力内容が不正です');
  end if;
  if p_action <> 'createCandidate' then
    select * into target from public.v3_candidates where id = p_candidate_id
      and v3_private.prefecture_code(prefecture) = actor.prefecture_code for update;
    if not found or v3_private.prefecture_code(target.prefecture) is distinct from actor.prefecture_code then
      return jsonb_build_object('ok',false,'status',404,'code','NOT_FOUND','error','対象が見つかりません');
    end if;
  end if;
  if p_action = 'deleteCandidate' then
    -- Existing FK deletes progress atomically with its parent.
    delete from public.v3_candidates where id = target.id;
    return jsonb_build_object('ok',true);
  end if;
  if exists (select 1 from jsonb_each(p_payload) e
    where e.key not in ('candidate_code','name','election_name','prefecture','sheet_id'))
    or (p_action = 'updateCandidate' and (p_payload = '{}'::jsonb or p_payload ? 'candidate_code')) then
    return jsonb_build_object('ok',false,'status',400,'code','INVALID_INPUT','error','入力内容が不正です');
  end if;
  if exists (select 1 from jsonb_each(p_payload) e
    where (e.key <> 'sheet_id' and jsonb_typeof(e.value) <> 'string')
       or (e.key = 'sheet_id' and jsonb_typeof(e.value) not in ('string','null'))) then
    return jsonb_build_object('ok',false,'status',400,'code','INVALID_INPUT','error','入力内容が不正です');
  end if;
  next_prefecture := case when p_payload ? 'prefecture' then btrim(p_payload->>'prefecture') else target.prefecture end;
  if v3_private.prefecture_code(next_prefecture) is distinct from actor.prefecture_code then
    return jsonb_build_object('ok',false,'status',403,'code','FORBIDDEN','error','この操作は許可されていません');
  end if;
  next_name := case when p_payload ? 'name' then btrim(p_payload->>'name') else target.name end;
  next_election := case when p_payload ? 'election_name' then btrim(p_payload->>'election_name') else target.election_name end;
  next_sheet := case when p_payload ? 'sheet_id' then nullif(btrim(p_payload->>'sheet_id'),'') else target.sheet_id end;
  next_code := case when p_action = 'createCandidate' then btrim(p_payload->>'candidate_code') else target.candidate_code end;
  if next_name is null or char_length(next_name) not between 1 and 200
    or next_election is null or char_length(next_election) not between 1 and 200
    or next_code is null or char_length(next_code) not between 1 and 100
    or (next_sheet is not null and (next_sheet !~ '^[A-Za-z0-9_-]{10,200}$'
      or next_sheet = '1q4Vimnn6BHqxCpfcCcRsmvWCvC4J6jGP6avLoOu-mGk')) then
    return jsonb_build_object('ok',false,'status',400,'code','INVALID_INPUT','error','入力内容が不正です');
  end if;
  if p_action = 'createCandidate' then
    insert into public.v3_candidates (candidate_code,name,election_name,prefecture,sheet_id)
      values (next_code,next_name,next_election,next_prefecture,next_sheet);
  else
    update public.v3_candidates set name=next_name, election_name=next_election,
      prefecture=next_prefecture, sheet_id=next_sheet where id=target.id;
  end if;
  return jsonb_build_object('ok',true);
exception when unique_violation then
  -- Do not reveal whether a code belongs to a different prefecture.
  return jsonb_build_object('ok',false,'status',409,'code','CONFLICT','error','登録できません。入力内容をご確認ください');
end $$;
revoke all on function public.v3_manage_candidate(uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.v3_manage_candidate(uuid,text,uuid,jsonb) to service_role;

create function public.v3_manage_users(
  p_actor_id uuid, p_action text, p_target_id uuid default null,
  p_role text default null, p_after_id uuid default null, p_limit integer default 200
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  actor public.v3_users%rowtype;
  target public.v3_users%rowtype;
  result jsonb;
begin
  -- Also take this lock for trusted scope assignments (see runbook).
  perform pg_catalog.pg_advisory_xact_lock(861713903);
  select * into actor from public.v3_users where id=p_actor_id for share;
  if not found or actor.status <> 'active' or actor.role <> 'admin' or actor.prefecture_code is null then
    return jsonb_build_object('ok',false,'status',403,'code','FORBIDDEN','error','この操作は許可されていません');
  end if;
  if p_action is null or p_action not in ('list','approve','disable','enable','set_role','delete') then
    return jsonb_build_object('ok',false,'status',400,'code','INVALID_INPUT','error','入力内容が不正です');
  end if;
  if p_action = 'list' then
    if p_limit is null or p_limit not between 1 and 200 then
      return jsonb_build_object('ok',false,'status',400,'code','INVALID_INPUT','error','入力内容が不正です');
    end if;
    with page as (
      select u.id,u.email,u.display_name,u.status,u.role,u.approved_at,u.approved_by,
        u.last_login_at,u.created_at,u.prefecture_code
      from public.v3_users u where u.prefecture_code=actor.prefecture_code
        and (p_after_id is null or u.id>p_after_id) order by u.id limit p_limit+1
    ), visible as (select * from page order by id limit p_limit)
    select jsonb_build_object('ok',true,
      'users',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from visible v),'[]'::jsonb),
      'next_cursor',case when (select count(*) from page)>p_limit
        then (select id from visible order by id desc limit 1) else null end) into result;
    return result;
  end if;
  select * into target from public.v3_users where id=p_target_id
    and prefecture_code=actor.prefecture_code for update;
  if not found or target.prefecture_code is distinct from actor.prefecture_code then
    return jsonb_build_object('ok',false,'status',404,'code','NOT_FOUND','error','対象が見つかりません');
  end if;
  if (p_action in ('approve','set_role') and (p_role is null or p_role not in ('admin','viewer'))) then
    return jsonb_build_object('ok',false,'status',400,'code','INVALID_INPUT','error','入力内容が不正です');
  end if;
  if (p_action='approve' and target.status<>'pending')
    or (p_action='enable' and target.status<>'disabled')
    or (p_action='set_role' and target.status<>'active')
    or (p_action='disable' and target.status='disabled') then
    return jsonb_build_object('ok',false,'status',409,'code','CONFLICT','error','状態が変更されています。一覧を読み直してください');
  end if;
  if target.status='active' and target.role='admin'
    and (p_action in ('disable','delete') or (p_action='set_role' and p_role='viewer'))
    and not exists (select 1 from public.v3_users u where u.id<>target.id
      and u.prefecture_code=actor.prefecture_code and u.status='active' and u.role='admin') then
    return jsonb_build_object('ok',false,'status',400,'code','LAST_ADMIN','error','担当県の最後の管理者は停止・降格・削除できません');
  end if;
  -- Preserve the existing API's self-management guard as well as last-admin safety.
  if target.id=actor.id and p_action in ('disable','set_role','delete') then
    return jsonb_build_object('ok',false,'status',400,'code','SELF_CHANGE','error','自分自身の停止・役割変更・削除はできません');
  end if;
  if p_action='set_role' and p_role=target.role then
    return jsonb_build_object('ok',false,'status',400,'code','NO_CHANGE','error','すでにその役割です');
  end if;
  case p_action
    when 'approve' then update public.v3_users set status='active',role=p_role,approved_at=now(),approved_by=actor.id where id=target.id;
    when 'enable' then update public.v3_users set status='active',
      approved_at=coalesce(approved_at,now()),
      approved_by=case when approved_at is null then actor.id else approved_by end where id=target.id;
    when 'disable' then update public.v3_users set status='disabled' where id=target.id;
    when 'set_role' then update public.v3_users set role=p_role where id=target.id;
    when 'delete' then
      delete from public.v3_users where id=target.id;
      return jsonb_build_object('ok',true,'deleted_user_id',target.id);
  end case;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.v3_manage_users(uuid,text,uuid,text,uuid,integer) from public, anon, authenticated;
grant execute on function public.v3_manage_users(uuid,text,uuid,text,uuid,integer) to service_role;

commit;
