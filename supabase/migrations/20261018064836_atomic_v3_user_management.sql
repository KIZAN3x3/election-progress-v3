-- Global approved-user/admin access remains unchanged. Only user management is
-- serialized. Apply this migration before deploying the matching v3-users code.
begin;

create function public.v3_manage_users_atomic(
  p_actor_id uuid, p_action text, p_target_id uuid default null,
  p_role text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.v3_users%rowtype;
  target public.v3_users%rowtype;
  users_result jsonb;
  conflict_message constant text := 'ほかの管理者が先に変更しました。一覧を読み直してください';
begin
  -- Trusted manual status/role changes must acquire this lock first as well.
  -- Always lock before reading the actor to avoid reciprocal row-lock deadlocks.
  perform pg_catalog.pg_advisory_xact_lock(861713903);
  select * into actor from public.v3_users where id=p_actor_id for share;
  if not found or actor.status<>'active' then
    return jsonb_build_object('ok',false,'status',403,'error','このアカウントは現在利用できません');
  end if;
  if actor.role<>'admin' then
    return jsonb_build_object('ok',false,'status',403,'error','管理者のみ操作できます');
  end if;
  if p_action is null or p_action not in ('list','approve','disable','enable','set_role','delete') then
    return jsonb_build_object('ok',false,'status',400,'error','unknown action');
  end if;
  if p_action='list' then
    select coalesce(jsonb_agg(to_jsonb(u) order by u.created_at,u.id),'[]'::jsonb)
      into users_result from (
        select id,email,display_name,status,role,approved_at,approved_by,last_login_at,created_at
          from public.v3_users
      ) u;
    return jsonb_build_object('ok',true,'users',users_result);
  end if;
  if p_target_id is null then
    return jsonb_build_object('ok',false,'status',400,'error','target_id を指定してください');
  end if;
  select * into target from public.v3_users where id=p_target_id for update;
  if not found then
    return jsonb_build_object('ok',false,'status',404,'error','利用者が見つかりません');
  end if;

  if p_action='approve' then
    if p_role is null or p_role not in ('admin','viewer') then
      return jsonb_build_object('ok',false,'status',400,'error','役割（admin / viewer）を指定してください');
    end if;
    if target.status<>'pending' then
      return jsonb_build_object('ok',false,'status',409,'error',conflict_message);
    end if;
    update public.v3_users set status='active',role=p_role,approved_at=now(),approved_by=actor.id where id=target.id;
    return jsonb_build_object('ok',true);
  end if;
  if p_action='disable' then
    if target.id=actor.id then
      return jsonb_build_object('ok',false,'status',400,'error','自分自身は無効化できません');
    end if;
    if target.status='disabled' then
      return jsonb_build_object('ok',false,'status',409,'error',conflict_message);
    end if;
  elsif p_action='enable' then
    if target.status<>'disabled' then
      return jsonb_build_object('ok',false,'status',409,'error',conflict_message);
    end if;
    if target.approved_at is null then
      update public.v3_users set status='active',approved_at=now(),approved_by=actor.id where id=target.id;
    else
      update public.v3_users set status='active' where id=target.id;
    end if;
    return jsonb_build_object('ok',true);
  elsif p_action='set_role' then
    if p_role is null or p_role not in ('admin','viewer') then
      return jsonb_build_object('ok',false,'status',400,'error','役割（admin / viewer）を指定してください');
    end if;
    if target.id=actor.id then
      return jsonb_build_object('ok',false,'status',400,'error','自分自身の役割は変更できません');
    end if;
    if target.status<>'active' then
      return jsonb_build_object('ok',false,'status',409,'error',conflict_message);
    end if;
    if target.role=p_role then
      return jsonb_build_object('ok',false,'status',400,'error','すでにその役割です');
    end if;
  elsif p_action='delete' and target.id=actor.id then
    return jsonb_build_object('ok',false,'status',400,'error','自分自身は削除できません');
  end if;

  if target.status='active' and target.role='admin'
    and (p_action in ('disable','delete') or (p_action='set_role' and p_role='viewer'))
    and not exists (select 1 from public.v3_users u
      where u.id<>target.id and u.status='active' and u.role='admin') then
    return jsonb_build_object('ok',false,'status',400,'error',
      case p_action when 'disable' then '最後の管理者は無効化できません'
        when 'delete' then '最後の管理者は削除できません' else '最後の管理者は降格できません' end);
  end if;
  if p_action='disable' then
    update public.v3_users set status='disabled' where id=target.id;
  elsif p_action='set_role' then
    update public.v3_users set role=p_role where id=target.id;
  elsif p_action='delete' then
    delete from public.v3_users where id=target.id;
    -- Definer access is needed only for this hard deletion in the managed Auth
    -- schema. Do not make a later HTTP delete: it could remove a newly registered
    -- row with the same ID after the transaction's authorization has completed.
    begin
      delete from auth.users where id=target.id;
    exception when others then
      -- Storage ownership/FK failures retain the existing partial-delete UX.
      -- Only this nested deletion is rolled back; no SQL error/value is exposed.
      return jsonb_build_object('ok',true,'auth_deleted',false,'warning',
        '利用者は削除しましたが、ログイン情報（auth.users）の削除に失敗しました。Supabase の Authentication 画面から削除してください');
    end;
    return jsonb_build_object('ok',true,'auth_deleted',true);
  end if;
  return jsonb_build_object('ok',true);
end $$;

alter function public.v3_manage_users_atomic(uuid,text,uuid,text) owner to postgres;
revoke all on function public.v3_manage_users_atomic(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.v3_manage_users_atomic(uuid,text,uuid,text) to service_role;

comment on function public.v3_manage_users_atomic(uuid,text,uuid,text) is
  'Server-only global user administration. Edge verifies JWT and supplies actor ID. Serialized current DB authorization; no prefecture restriction. Auth hard delete stays in the same transaction.';
commit;
