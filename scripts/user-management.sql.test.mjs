import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db;
const migration = '20261018064836_atomic_v3_user_management.sql';
const scalar = async (sql, values=[]) => Object.values((await db.query(sql,values)).rows[0])[0];
async function role(name, subject='') {
  assert.ok(['service_role','authenticated','anon'].includes(name));
  await db.exec(`set local role ${name}`);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[subject]);
}
async function scenario(fn) {
  await db.exec('begin');
  try { await fn(); } finally { await db.exec('rollback'); }
}
async function denied(fn) {
  await db.exec('savepoint expected');
  let error;
  try { await fn(); } catch (caught) { error=caught; }
  await db.exec('rollback to savepoint expected; release savepoint expected');
  assert.equal(error?.code,'42501');
}
const rpc=(actor,action,target=null,targetRole=null)=>scalar(
  'select public.v3_manage_users_atomic($1::uuid,$2::text,$3::uuid,$4::text)',[actor,action,target,targetRole]);
function rejects(result,status,message) {
  assert.equal(result.ok,false);
  assert.equal(result.status,status);
  if (message) assert.equal(result.error,message);
}

describe('global atomic user management on real PostgreSQL', {concurrency:false},()=>{
  before(async()=>{
    db=await PGlite.create();
    await db.exec(await readFile(new URL('./fixtures/user-management-schema.sql',import.meta.url),'utf8'));
    for (const name of ['0001_v3_users.sql','0002_restrict_v3_reads.sql',migration]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
    }
    for (const [n,status,userRole] of [[1,'active','admin'],[2,'active','admin'],[3,'active','viewer'],[4,'pending','viewer'],[5,'disabled','viewer'],[6,'disabled','admin']]) {
      await db.query('insert into auth.users(id,email) values($1,$2)',[id(n),`fixture-${n}@example.invalid`]);
      await db.query('insert into public.v3_users(id,email,display_name,status,role) values($1,$2,$3,$4,$5)',[id(n),`fixture-${n}@example.invalid`,`Synthetic ${n}`,status,userRole]);
    }
    await db.query('insert into auth.sessions(user_id) values($1)',[id(3)]);
    await db.exec("insert into public.v3_candidates(prefecture) values('東京都'),('愛知県')");
  });
  after(async()=>{await db?.close();});

  test('no prefecture column or scope restriction is introduced',()=>scenario(async()=>{
    assert.equal(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='v3_users' and column_name='prefecture_code'"),0);
    await role('authenticated',id(3));
    assert.equal(await scalar('select count(*)::int from public.v3_candidates'),2);
  }));
  test('service-only execute includes revocation inherited from PUBLIC',()=>scenario(async()=>{
    for (const name of ['anon','authenticated']) {
      assert.equal(await scalar('select has_function_privilege($1,$2,$3)',[name,'public.v3_manage_users_atomic(uuid,text,uuid,text)','EXECUTE']),false);
    }
    assert.equal(await scalar('select has_function_privilege($1,$2,$3)',['service_role','public.v3_manage_users_atomic(uuid,text,uuid,text)','EXECUTE']),true);
    const definition=(await db.query("select r.rolname,p.prosecdef,p.proconfig from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='public.v3_manage_users_atomic(uuid,text,uuid,text)'::regprocedure")).rows[0];
    assert.equal(definition.rolname,'postgres');
    assert.equal(definition.prosecdef,true);
    assert.ok(definition.proconfig.includes('search_path=""'));
  }));
  for (const name of ['anon','authenticated']) {
    test(`${name} cannot call RPC with a forged admin ID`,()=>scenario(async()=>{
      await role(name,id(3));
      await denied(()=>rpc(id(1),'list'));
      await denied(()=>rpc(id(1),'delete',id(3)));
    }));
  }
  for (const actor of [null,id(99),id(3),id(4),id(5),id(6)]) {
    test(`current actor state is checked for actor ${actor?.slice(-2)??'null'}`,()=>scenario(async()=>{
      await role('service_role');
      rejects(await rpc(actor,'disable',id(2)),403);
      assert.equal(await scalar('select status from public.v3_users where id=$1',[id(2)]),'active');
    }));
  }
  test('admin listing retains all global users and the existing columns',()=>scenario(async()=>{
    await role('service_role');
    const result=await rpc(id(1),'list');
    assert.equal(result.ok,true);
    assert.equal(result.users.length,6);
    assert.deepEqual(Object.keys(result.users[0]).sort(),['id','email','display_name','status','role','approved_at','approved_by','last_login_at','created_at'].sort());
  }));
  for (const [action,message] of [['disable','自分自身は無効化できません'],['set_role','自分自身の役割は変更できません'],['delete','自分自身は削除できません']]) {
    test(`self ${action} retains the old rejection`,()=>scenario(async()=>{
      await role('service_role');
      rejects(await rpc(id(1),action,id(1),'viewer'),400,message);
      assert.equal(await scalar('select role from public.v3_users where id=$1',[id(1)]),'admin');
    }));
  }
  test('same role rejects without changing the row',()=>scenario(async()=>{
    const original=await scalar('select to_jsonb(u) from public.v3_users u where id=$1',[id(2)]);
    await role('service_role');
    rejects(await rpc(id(1),'set_role',id(2),'admin'),400,'すでにその役割です');
    assert.deepEqual(await scalar('select to_jsonb(u) from public.v3_users u where id=$1',[id(2)]),original);
  }));
  test('approval records role, actor and timestamp atomically',()=>scenario(async()=>{
    await role('service_role');
    assert.equal((await rpc(id(1),'approve',id(4),'admin')).ok,true);
    const row=(await db.query('select status,role,approved_by,approved_at is not null as approved from public.v3_users where id=$1',[id(4)])).rows[0];
    assert.deepEqual(row,{status:'active',role:'admin',approved_by:id(1),approved:true});
    rejects(await rpc(id(1),'approve',id(4),'viewer'),409);
  }));
  test('enable retains original approval audit, including NULL approved_by',()=>scenario(async()=>{
    await db.query("update public.v3_users set approved_at='2020-01-02T03:04:05Z',approved_by=null where id=$1",[id(5)]);
    const original=(await db.query('select approved_at::text,approved_by from public.v3_users where id=$1',[id(5)])).rows[0];
    await role('service_role');
    assert.equal((await rpc(id(1),'enable',id(5))).ok,true);
    assert.deepEqual((await db.query('select approved_at::text,approved_by from public.v3_users where id=$1',[id(5)])).rows[0],original);
  }));
  test('enabling a previously unapproved account records this approval',()=>scenario(async()=>{
    await role('service_role');
    assert.equal((await rpc(id(1),'enable',id(5))).ok,true);
    assert.equal(await scalar('select approved_by from public.v3_users where id=$1',[id(5)]),id(1));
  }));
  for (const action of ['disable','set_role','delete']) {
    test(`serialized reciprocal ${action} cannot remove every admin`,()=>scenario(async()=>{
      await role('service_role');
      assert.equal((await rpc(id(1),action,id(2),'viewer')).ok,true);
      rejects(await rpc(id(2),action,id(1),'viewer'),403);
      assert.equal(await scalar("select count(*)::int from public.v3_users where role='admin' and status='active'"),1);
    }));
  }
  test('database actor revocation is observed after an earlier Edge precheck',()=>scenario(async()=>{
    await db.query("update public.v3_users set role='viewer' where id=$1",[id(1)]);
    await role('service_role');
    rejects(await rpc(id(1),'disable',id(2)),403,'管理者のみ操作できます');
  }));
  test('hard delete removes Auth sessions in the same transaction without service Auth grants',()=>scenario(async()=>{
    assert.equal(await scalar("select has_table_privilege('service_role','auth.users','DELETE')"),false);
    await role('service_role');
    assert.deepEqual(await rpc(id(1),'delete',id(3)),{ok:true,auth_deleted:true});
    await db.exec('reset role');
    assert.equal(await scalar('select count(*)::int from public.v3_users where id=$1',[id(3)]),0);
    assert.equal(await scalar('select count(*)::int from auth.users where id=$1',[id(3)]),0);
    assert.equal(await scalar('select count(*)::int from auth.sessions where user_id=$1',[id(3)]),0);
  }));
  test('storage ownership failure keeps old partial-delete warning and Auth state',()=>scenario(async()=>{
    await db.query('insert into storage.objects(owner) values($1)',[id(3)]);
    await role('service_role');
    const result=await rpc(id(1),'delete',id(3));
    assert.equal(result.ok,true);
    assert.equal(result.auth_deleted,false);
    assert.equal(result.warning,'利用者は削除しましたが、ログイン情報（auth.users）の削除に失敗しました。Supabase の Authentication 画面から削除してください');
    await db.exec('reset role');
    assert.equal(await scalar('select count(*)::int from public.v3_users where id=$1',[id(3)]),0);
    assert.equal(await scalar('select count(*)::int from auth.users where id=$1',[id(3)]),1);
    assert.equal(await scalar('select count(*)::int from auth.sessions where user_id=$1',[id(3)]),1);
  }));
  test('transaction rollback restores application user, Auth user and session together',()=>scenario(async()=>{
    await role('service_role');
    await db.exec('savepoint synthetic');
    assert.equal((await rpc(id(1),'delete',id(3))).auth_deleted,true);
    await db.exec('rollback to savepoint synthetic; release savepoint synthetic; reset role');
    for (const table of ['public.v3_users','auth.users']) {
      assert.equal(await scalar(`select count(*)::int from ${table} where id=$1`,[id(3)]),1);
    }
    assert.equal(await scalar('select count(*)::int from auth.sessions where user_id=$1',[id(3)]),1);
  }));
  test('unknown target/action and invalid role retain bounded errors',()=>scenario(async()=>{
    await role('service_role');
    rejects(await rpc(id(1),'disable',null),400);
    rejects(await rpc(id(1),'disable',id(99)),404);
    rejects(await rpc(id(1),'approve',id(4),'owner'),400);
    rejects(await rpc(id(1),'not-an-action',id(3)),400,'unknown action');
  }));
});
