import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

// This suite requires a disposable local PostgreSQL server, never a hosted DB.
const databaseUrl = process.env.TEST_DATABASE_URL;
const sessions = new Set();
const actorA = '00000000-0000-4000-8000-000000000001';
const actorB = '00000000-0000-4000-8000-000000000002';
const candidate = '10000000-0000-4000-8000-000000000001';

function session(source, keepOpen = false) {
  const child = spawn('psql', ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set=ON_ERROR_STOP=1', '--dbname', databaseUrl], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PGCONNECT_TIMEOUT: '5',
      PGOPTIONS: '-c statement_timeout=12000 -c lock_timeout=10000' },
  });
  const state = { child, output: '', errors: '' };
  sessions.add(child);
  const deadline = setTimeout(() => child.kill(), 20_000);
  child.stdout.setEncoding('utf8').on('data', text => { state.output += text; });
  child.stderr.setEncoding('utf8').on('data', text => { state.errors += text; });
  state.done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(deadline);
      sessions.delete(child);
      if (code === 0) resolve(state.output.trim());
      else reject(new Error(`Synthetic PostgreSQL session failed (${code}): ${state.errors}`));
    });
  });
  // Cleanup can terminate a session after another assertion has failed.
  state.done.catch(() => {});
  if (keepOpen) child.stdin.write(source);
  else child.stdin.end(source);
  return state;
}
const sql = source => session(source).done;
async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Synthetic database coordination timed out');
}
async function seed() {
  await sql(`delete from public.v3_candidates; delete from public.v3_users; delete from auth.users;
    insert into auth.users(id) values ('${actorA}'),('${actorB}');
    insert into public.v3_users(id,display_name,status,role,prefecture_code) values
      ('${actorA}','Synthetic A','active','admin','23'),
      ('${actorB}','Synthetic B','active','admin','23');
    insert into public.v3_candidates(id,candidate_code,name,election_name,prefecture)
      values ('${candidate}','SYNTHETIC','Synthetic candidate','Synthetic election','愛知県');`);
}

describe('prefecture RPCs with independent PostgreSQL sessions', { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const target = new URL(databaseUrl);
    assert.ok(['127.0.0.1', '[::1]'].includes(target.hostname), 'Only a loopback IP test server is allowed');
    assert.equal(target.pathname, '/scope_security_test', 'Use the dedicated disposable database');
    assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
    // libpq accepts query options that override a URI's host/database.
    assert.equal(target.search, '', 'Connection override parameters are forbidden');
    assert.equal(target.hash, '', 'Connection fragments are forbidden');
    await sql(await readFile(new URL('./fixtures/prefecture-test-schema.sql', import.meta.url), 'utf8'));
    for (const name of ['0001_v3_users.sql', '0002_restrict_v3_reads.sql',
      '20261018053254_restrict_prefecture_access.sql']) {
      await sql(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    }
  });
  after(() => { for (const child of sessions) child.kill(); });

  test('simultaneous mutual disable leaves one active prefecture administrator', async () => {
    await seed();
    const gate = session("begin; select pg_advisory_xact_lock(861713905); select 'GATE_READY';\n", true);
    try {
      await until(() => gate.output.includes('GATE_READY'));
      const first = session(`set application_name='scope_admin_first'; begin; set local role service_role;
        select public.v3_manage_users('${actorA}','disable','${actorB}');
        select pg_advisory_xact_lock(861713905); commit;`);
      await until(async () => await sql("select exists(select 1 from pg_stat_activity where application_name='scope_admin_first' and wait_event_type='Lock')") === 't');
      const second = session(`set application_name='scope_admin_second'; begin; set local role service_role;
        select public.v3_manage_users('${actorB}','disable','${actorA}'); commit;`);
      await until(async () => await sql("select exists(select 1 from pg_stat_activity where application_name='scope_admin_second' and wait_event='advisory')") === 't');
      gate.child.stdin.end('rollback;\n');
      const [, firstOutput, secondOutput] = await Promise.all([gate.done, first.done, second.done]);
      const result = output => JSON.parse(output.split('\n').find(line => line.startsWith('{')));
      assert.equal(result(firstOutput).ok, true);
      assert.equal(result(secondOutput).ok, false);
      assert.equal(result(secondOutput).status, 403);
      assert.equal(await sql("select count(*) from public.v3_users where status='active' and role='admin' and prefecture_code='23'"), '1');
    } finally {
      if (!gate.child.stdin.destroyed && !gate.child.stdin.writableEnded) gate.child.stdin.end('rollback;\n');
    }
  });

  test('scope reassignment waits for the authorized transaction, then an old request scope is denied', async () => {
    await seed();
    const gate = session("begin; select pg_advisory_xact_lock(861713904); select 'GATE_READY';\n", true);
    try {
      await until(() => gate.output.includes('GATE_READY'));
      const writer = session(`set application_name='scope_candidate_update';
        begin; set local role service_role;
        select public.v3_manage_candidate('${actorA}','updateCandidate','${candidate}', '{"name":"Synthetic updated"}');
        select pg_advisory_xact_lock(861713904); commit;`);
      await until(async () => await sql("select exists(select 1 from pg_stat_activity where application_name='scope_candidate_update' and wait_event_type='Lock')") === 't');
      const reassignment = session(`set application_name='scope_assignment_change'; begin;
        select pg_advisory_xact_lock(861713903);
        update public.v3_users set prefecture_code='13' where id='${actorA}'; commit;`);
      await until(async () => await sql("select exists(select 1 from pg_stat_activity where application_name='scope_assignment_change' and wait_event_type='Lock')") === 't');
      gate.child.stdin.end('rollback;\n');
      await Promise.all([gate.done, writer.done, reassignment.done]);
      assert.equal(await sql(`select prefecture_code from public.v3_users where id='${actorA}'`), '13');
      const denied = JSON.parse(await sql(`set role service_role;
        select public.v3_manage_candidate('${actorA}','updateCandidate','${candidate}', '{"name":"Must not write"}');`));
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 404);
      assert.equal(await sql(`select name from public.v3_candidates where id='${candidate}'`), 'Synthetic updated');
    } finally {
      if (!gate.child.stdin.destroyed && !gate.child.stdin.writableEnded) gate.child.stdin.end('rollback;\n');
    }
  });
});
