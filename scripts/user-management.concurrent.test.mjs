import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

const databaseUrl=process.env.V3_ADMIN_TEST_DATABASE_URL;
const children=new Set();
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function session(source,keepOpen=false) {
  const child=spawn('psql',['--no-psqlrc','--quiet','--tuples-only','--no-align',
    '--set=ON_ERROR_STOP=1','--set=VERBOSITY=sqlstate','--dbname',databaseUrl],{
    stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',PGCONNECT_TIMEOUT:'5',
      PGOPTIONS:'-c statement_timeout=12000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=20000'},
  });
  const state={child,output:'',errors:''};
  children.add(child);
  const timer=setTimeout(()=>child.kill(),25000);
  child.stdout.setEncoding('utf8').on('data',part=>{state.output+=part;});
  child.stderr.setEncoding('utf8').on('data',part=>{state.errors+=part;});
  child.stdin.on('error',()=>{});
  state.done=new Promise((resolve,reject)=>{
    child.on('error',()=>reject(new Error('Unable to start local PostgreSQL client')));
    child.on('close',code=>{
      clearTimeout(timer);children.delete(child);
      if(code===0) resolve(state.output.trim());
      else {const error=new Error(`Synthetic PostgreSQL session failed (${code})`);error.sqlState=/\b23503\b/.test(state.errors)?'23503':null;reject(error);}
    });
  });
  state.done.catch(()=>{});
  if(keepOpen) child.stdin.write(source); else child.stdin.end(source);
  return state;
}
const sql=source=>session(source).done;
async function until(predicate) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline) {
    if(await predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  throw new Error('Synthetic lock coordination timed out');
}
const result=output=>JSON.parse(output.split('\n').find(line=>line.startsWith('{')));
async function seed() {
  await sql(`delete from storage.objects;delete from public.v3_users;delete from auth.users;
    insert into auth.users(id) values('${id(1)}'),('${id(2)}');
    insert into public.v3_users(id,display_name,status,role) values
      ('${id(1)}','Synthetic A','active','admin'),('${id(2)}','Synthetic B','active','admin');
    insert into auth.sessions(user_id) values('${id(2)}');`);
}
function release(gate,source='rollback;\n') {
  if(!gate.child.stdin.destroyed&&!gate.child.stdin.writableEnded) gate.child.stdin.end(source);
}
describe('global user RPC with independent PostgreSQL connections',{skip:!databaseUrl,concurrency:false},()=>{
  before(async()=>{
    const url=new URL(databaseUrl);
    assert.ok(['postgres:','postgresql:'].includes(url.protocol));
    assert.ok(['127.0.0.1','[::1]'].includes(url.hostname),'Loopback IP only');
    assert.equal(url.pathname,'/v3_admin_security_test','Dedicated disposable DB only');
    assert.equal(url.search,'','libpq override query parameters forbidden');
    assert.equal(url.hash,'','Connection fragments forbidden');
    await sql(await readFile(new URL('./fixtures/user-management-schema.sql',import.meta.url),'utf8'));
    for(const name of ['0001_v3_users.sql','0002_restrict_v3_reads.sql','20261018064836_atomic_v3_user_management.sql']) {
      await sql(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
    }
  });
  after(()=>{for(const child of children) child.kill();});

  for(const action of ['disable','set_role','delete']) {
    test(`concurrent reciprocal ${action} retains an admin and checks the queued actor`,{timeout:30000},async()=>{
      await seed();
      const gate=session("begin;select pg_advisory_xact_lock(861713905);select 'READY';\n",true);
      try {
        await until(()=>gate.output.includes('READY'));
        const first=session(`set application_name='admin_atomic_first';begin;set local role service_role;
          select public.v3_manage_users_atomic('${id(1)}','${action}','${id(2)}','viewer');
          select pg_advisory_xact_lock(861713905);commit;`);
        await until(async()=>await sql("select exists(select 1 from pg_stat_activity where application_name='admin_atomic_first' and wait_event='advisory')")==='t');
        const second=session(`set application_name='admin_atomic_second';begin;set local role service_role;
          select public.v3_manage_users_atomic('${id(2)}','${action}','${id(1)}','viewer');commit;`);
        await until(async()=>await sql("select exists(select 1 from pg_stat_activity where application_name='admin_atomic_second' and wait_event='advisory')")==='t');
        release(gate);
        const [,a,b]=await Promise.all([gate.done,first.done,second.done]);
        assert.equal(result(a).ok,true);
        assert.equal(result(b).ok,false);
        assert.equal(result(b).status,403);
        assert.equal(await sql("select count(*) from public.v3_users where status='active' and role='admin'"),'1');
      } finally {release(gate);}
    });
  }
  test('a queued request reads revocation committed before it acquires the admin lock',{timeout:30000},async()=>{
    await seed();
    const gate=session("begin;select pg_advisory_xact_lock(861713903);select 'READY';\n",true);
    try {
      await until(()=>gate.output.includes('READY'));
      const request=session(`set application_name='admin_revoked_request';begin;set local role service_role;
        select public.v3_manage_users_atomic('${id(1)}','disable','${id(2)}');commit;`);
      await until(async()=>await sql("select exists(select 1 from pg_stat_activity where application_name='admin_revoked_request' and wait_event='advisory')")==='t');
      release(gate,`update public.v3_users set role='viewer' where id='${id(1)}';commit;\n`);
      const [,output]=await Promise.all([gate.done,request.done]);
      assert.equal(result(output).status,403);
      assert.equal(await sql(`select status from public.v3_users where id='${id(2)}'`),'active');
    } finally {release(gate);}
  });
  test('concurrent re-registration cannot slip between application and Auth deletion',{timeout:30000},async()=>{
    await seed();
    const gate=session("begin;select pg_advisory_xact_lock(861713905);select 'READY';\n",true);
    try {
      await until(()=>gate.output.includes('READY'));
      const deletion=session(`set application_name='admin_atomic_delete';begin;set local role service_role;
        select public.v3_manage_users_atomic('${id(1)}','delete','${id(2)}');
        select pg_advisory_xact_lock(861713905);commit;`);
      await until(async()=>await sql("select exists(select 1 from pg_stat_activity where application_name='admin_atomic_delete' and wait_event='advisory')")==='t');
      const register=session(`set application_name='admin_reregister';begin;set local role service_role;
        insert into public.v3_users(id,display_name) values('${id(2)}','Synthetic re-register');commit;`);
      await until(async()=>await sql("select exists(select 1 from pg_stat_activity where application_name='admin_reregister' and wait_event_type='Lock')")==='t');
      release(gate);
      const outcomes=await Promise.allSettled([gate.done,deletion.done,register.done]);
      assert.equal(outcomes[1].status,'fulfilled');
      assert.equal(outcomes[2].status,'rejected');
      assert.equal(outcomes[2].reason.sqlState,'23503');
      assert.equal(await sql(`select count(*) from public.v3_users where id='${id(2)}'`),'0');
      assert.equal(await sql(`select count(*) from auth.users where id='${id(2)}'`),'0');
      assert.equal(await sql(`select count(*) from auth.sessions where user_id='${id(2)}'`),'0');
    } finally {release(gate);}
  });
});
