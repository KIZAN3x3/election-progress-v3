import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// This file runs only synthetic data in an in-memory PostgreSQL instance.
const projectRoot = new URL('../', import.meta.url);
const migrationNames = [
  '0001_v3_users.sql',
  '0002_restrict_v3_reads.sql',
  '20261018053254_restrict_prefecture_access.sql',
];
const prefectures = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
const userId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const candidateId = (code) => `10000000-0000-4000-8000-${String(code).padStart(12, '0')}`;
const user = {
  tokyoViewer: userId(1), aichiViewer: userId(2), tokyoAdmin: userId(3),
  aichiAdmin: userId(4), unassignedViewer: userId(5), pendingTokyo: userId(6),
  disabledTokyo: userId(7), unassignedAdmin: userId(8), secondTokyoAdmin: userId(9),
  pendingAichi: userId(10), unassignedPending: userId(11),
};
let db;

async function scalar(tx, sql, values = []) {
  const row = (await tx.query(sql, values)).rows[0];
  return Object.values(row)[0];
}
async function asRole(tx, role, subject = '') {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await tx.exec(`set local role ${role}`);
  await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [subject]);
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: subject || null, role })]);
}
async function scenario(fn) {
  await db.exec('begin');
  try {
    return await fn(db);
  } finally {
    await db.exec('rollback');
  }
}
async function expectSqlState(tx, fn, code) {
  await tx.exec('savepoint expected_denial');
  let failure;
  try { await fn(); } catch (error) { failure = error; }
  await tx.exec('rollback to savepoint expected_denial; release savepoint expected_denial');
  assert.ok(failure, `Expected SQLSTATE ${code}`);
  assert.equal(failure.code, code);
}
function assertRejected(result, statuses = [403, 404]) {
  assert.equal(result.ok, false);
  assert.ok(statuses.includes(result.status), `Unexpected rejection status ${result.status}`);
  assert.equal(typeof result.error, 'string');
  assert.equal(typeof result.code, 'string');
}
async function candidateRpc(tx, actor, action, target = null, payload = {}) {
  return scalar(tx, 'select public.v3_manage_candidate($1::uuid,$2::text,$3::uuid,$4::jsonb)',
    [actor, action, target, JSON.stringify(payload)]);
}
async function usersRpc(tx, actor, action, target = null, role = null, afterId = null, limit = 200) {
  return scalar(tx, 'select public.v3_manage_users($1::uuid,$2::text,$3::uuid,$4::text,$5::uuid,$6::int)',
    [actor, action, target, role, afterId, limit]);
}
async function visibleIds(tx, table) {
  assert.ok(['v3_candidates', 'v3_progress'].includes(table));
  const column = table === 'v3_candidates' ? 'id' : 'candidate_id';
  return (await tx.query(`select ${column} as id from public.${table} order by ${column}`)).rows.map((r) => r.id);
}

describe('prefecture SQL boundaries on real in-memory PostgreSQL', { concurrency: false }, () => {
  before(async () => {
    db = await PGlite.create();
    await db.exec(await readFile(new URL('./fixtures/prefecture-test-schema.sql', import.meta.url), 'utf8'));
    for (const name of migrationNames) {
      const source = await readFile(new URL(`supabase/migrations/${name}`, projectRoot), 'utf8');
      assert.ok(source.trim().length > 0, `${name} must contain a real migration`);
      await db.exec(source);
    }
    const specs = [
      [user.tokyoViewer, 'active', 'viewer', '13'],
      [user.aichiViewer, 'active', 'viewer', '23'],
      [user.tokyoAdmin, 'active', 'admin', '13'],
      [user.aichiAdmin, 'active', 'admin', '23'],
      [user.unassignedViewer, 'active', 'viewer', null],
      [user.pendingTokyo, 'pending', 'viewer', '13'],
      [user.disabledTokyo, 'disabled', 'viewer', '13'],
      [user.unassignedAdmin, 'active', 'admin', null],
      [user.secondTokyoAdmin, 'active', 'admin', '13'],
      [user.pendingAichi, 'pending', 'viewer', '23'],
      [user.unassignedPending, 'pending', 'viewer', null],
    ];
    for (const [id, status, role, scope] of specs) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [id, `fixture-${id.slice(-2)}@example.invalid`]);
      await db.query(`insert into public.v3_users(id,email,display_name,status,role,prefecture_code)
        values($1,$2,'Synthetic fixture user',$3,$4,$5)`, [id, `fixture-${id.slice(-2)}@example.invalid`, status, role, scope]);
    }
    for (let index = 0; index < prefectures.length; index++) {
      const code = String(index + 1).padStart(2, '0');
      await db.query(`insert into public.v3_candidates(id,candidate_code,name,election_name,prefecture)
        values($1,$2,'Synthetic SQL candidate','Synthetic election',$3)`, [candidateId(code), `SYNTH-${code}`, prefectures[index]]);
    }
    for (const [id, value] of [[98, 'UNKNOWN'], [99, ''], [100, null]]) {
      await db.query(`insert into public.v3_candidates(id,candidate_code,name,prefecture)
        values($1,$2,'Synthetic invalid-prefecture candidate',$3)`, [candidateId(id), `SYNTH-${id}`, value]);
    }
    await db.exec(`insert into public.v3_progress(candidate_id,period,item_name,required,status)
      select id,'Synthetic period','Synthetic item',true,'未着手' from public.v3_candidates`);
  });
  after(async () => { if (db) await db.close(); });

  test('all 47 canonical prefectures isolate both candidate and parent-derived progress reads', () => scenario(async (tx) => {
    for (let index = 0; index < 47; index++) {
      const code = String(index + 1).padStart(2, '0');
      await tx.exec('reset role');
      await tx.query('update public.v3_users set prefecture_code=$1 where id=$2', [code, user.tokyoViewer]);
      await asRole(tx, 'authenticated', user.tokyoViewer);
      assert.deepEqual(await visibleIds(tx, 'v3_candidates'), [candidateId(code)]);
      assert.deepEqual(await visibleIds(tx, 'v3_progress'), [candidateId(code)]);
    }
  }));

  test('a regional admin receives no national SELECT exception', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoAdmin);
    assert.deepEqual(await visibleIds(tx, 'v3_candidates'), [candidateId('13')]);
    assert.deepEqual(await visibleIds(tx, 'v3_progress'), [candidateId('13')]);
  }));

  for (const [label, id] of [
    ['unassigned viewer', user.unassignedViewer], ['unassigned admin', user.unassignedAdmin],
    ['pending viewer', user.pendingTokyo], ['disabled viewer', user.disabledTokyo],
  ]) test(`${label} receives no business rows`, () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', id);
    assert.deepEqual(await visibleIds(tx, 'v3_candidates'), []);
    assert.deepEqual(await visibleIds(tx, 'v3_progress'), []);
  }));

  test('anonymous role has no direct SELECT privilege', () => scenario(async (tx) => {
    await asRole(tx, 'anon');
    await expectSqlState(tx, () => tx.query('select id from public.v3_candidates'), '42501');
    await expectSqlState(tx, () => tx.query('select candidate_id from public.v3_progress'), '42501');
  }));

  test('direct candidate ID and parent progress ID cannot bypass a different prefecture', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoViewer);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where id=$1', [candidateId('23')]), 0);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_progress where candidate_id=$1', [candidateId('23')]), 0);
  }));

  test('forged JWT app metadata does not grant a wider database scope', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoViewer);
    await tx.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({
      sub: user.tokyoViewer, role: 'authenticated', app_metadata: { role: 'admin', prefecture_code: '23' },
      user_metadata: { role: 'admin', prefecture_code: '23' },
    })]);
    assert.deepEqual(await visibleIds(tx, 'v3_candidates'), [candidateId('13')]);
  }));

  test('a user cannot directly read or assign their own membership', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoViewer);
    await expectSqlState(tx, () => tx.query('select prefecture_code from public.v3_users'), '42501');
    await expectSqlState(tx, () => tx.query(`update public.v3_users set prefecture_code='23',role='admin' where id=$1`, [user.tokyoViewer]), '42501');
  }));

  test('authenticated clients retain no direct candidate writes', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoAdmin);
    await expectSqlState(tx, () => tx.query(`update public.v3_candidates set name='Synthetic changed' where id=$1`, [candidateId('13')]), '42501');
    await expectSqlState(tx, () => tx.query('delete from public.v3_candidates where id=$1', [candidateId('13')]), '42501');
  }));

  test('business tables retain only SELECT for authenticated and no anonymous privileges', () => scenario(async (tx) => {
    for (const table of ['public.v3_candidates', 'public.v3_progress']) {
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
          assert.equal(await scalar(tx, 'select has_table_privilege($1,$2,$3)', [role, table, privilege]), false,
            `${role} must not retain ${privilege} on ${table}`);
        }
        assert.equal(await scalar(tx, 'select has_table_privilege($1,$2,$3)', [role, table, 'SELECT']), role === 'authenticated');
      }
    }
  }));

  test('private lookup helpers expose only the authenticated caller scope and no schema creation', () => scenario(async (tx) => {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await scalar(tx, 'select has_schema_privilege($1,$2,$3)', [role, 'v3_private', 'CREATE']), false);
    }
    for (const signature of ['v3_private.prefecture_code(text)', 'v3_private.current_prefecture_code()']) {
      assert.equal(await scalar(tx, 'select has_function_privilege($1,$2,$3)', ['anon', signature, 'EXECUTE']), false);
    }
    await asRole(tx, 'authenticated', user.tokyoViewer);
    assert.equal(await scalar(tx, 'select v3_private.current_prefecture_code()'), '13');
    await asRole(tx, 'authenticated', user.unassignedViewer);
    assert.equal(await scalar(tx, 'select v3_private.current_prefecture_code()'), null);
  }));

  test('authenticated clients have no direct progress mutations', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoAdmin);
    await expectSqlState(tx, () => tx.query(`update public.v3_progress set status='Synthetic forbidden' where candidate_id=$1`, [candidateId('13')]), '42501');
    await expectSqlState(tx, () => tx.query('delete from public.v3_progress where candidate_id=$1', [candidateId('13')]), '42501');
  }));

  test('scope removal and disable affect the next SQL statement with the same JWT subject', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoViewer);
    assert.equal((await visibleIds(tx, 'v3_candidates')).length, 1);
    await tx.exec('reset role');
    await tx.query('update public.v3_users set prefecture_code=null where id=$1', [user.tokyoViewer]);
    await asRole(tx, 'authenticated', user.tokyoViewer);
    assert.deepEqual(await visibleIds(tx, 'v3_candidates'), []);
    await tx.exec('reset role');
    await tx.query(`update public.v3_users set prefecture_code='13',status='disabled' where id=$1`, [user.tokyoViewer]);
    await asRole(tx, 'authenticated', user.tokyoViewer);
    assert.deepEqual(await visibleIds(tx, 'v3_progress'), []);
  }));

  test('new users default to NULL scope without granting national access', () => scenario(async (tx) => {
    const fresh = userId(80);
    await tx.query('insert into auth.users(id) values($1)', [fresh]);
    await tx.query(`insert into public.v3_users(id,display_name,status) values($1,'Synthetic new user','active')`, [fresh]);
    assert.equal(await scalar(tx, 'select prefecture_code from public.v3_users where id=$1', [fresh]), null);
    await asRole(tx, 'authenticated', fresh);
    assert.deepEqual(await visibleIds(tx, 'v3_candidates'), []);
  }));

  test('invalid scope codes fail the database constraint', () => scenario(async (tx) => {
    for (const invalid of ['', '1', '00', '48', '13 ', '東京都']) {
      await expectSqlState(tx, () => tx.query('update public.v3_users set prefecture_code=$1 where id=$2', [invalid, user.tokyoViewer]), '23514');
    }
  }));

  test('legacy active-wide SELECT policies were replaced', () => scenario(async (tx) => {
    const count = await scalar(tx, `select count(*)::int from pg_policies where schemaname='public'
      and policyname in ('v3_candidates_select_active_users','v3_progress_select_active_users')`);
    assert.equal(count, 0);
  }));

  test('management RPC execute privileges are server-only including PUBLIC inheritance', () => scenario(async (tx) => {
    for (const signature of [
      'public.v3_manage_candidate(uuid,text,uuid,jsonb)',
      'public.v3_manage_users(uuid,text,uuid,text,uuid,integer)',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await scalar(tx, 'select has_function_privilege($1,$2,$3)', [role, signature, 'EXECUTE']), false);
      }
      assert.equal(await scalar(tx, 'select has_function_privilege($1,$2,$3)', ['service_role', signature, 'EXECUTE']), true);
    }
  }));

  test('authenticated caller cannot invoke privileged RPC even with an admin actor ID', () => scenario(async (tx) => {
    await asRole(tx, 'authenticated', user.tokyoViewer);
    await expectSqlState(tx, () => candidateRpc(tx, user.tokyoAdmin, 'deleteCandidate', candidateId('13')), '42501');
    await expectSqlState(tx, () => usersRpc(tx, user.tokyoAdmin, 'list'), '42501');
  }));

  test('trusted service role still bypasses RLS; human safety depends on scoped RPC checks', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    assert.equal((await visibleIds(tx, 'v3_candidates')).length, 50);
  }));

  test('candidate RPC rejects a viewer actor even though its caller is service_role', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    assertRejected(await candidateRpc(tx, user.tokyoViewer, 'deleteCandidate', candidateId('13')));
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where id=$1', [candidateId('13')]), 1);
  }));

  test('candidate RPC scopes deletion and old/new prefecture checks', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'deleteCandidate', candidateId('23')));
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'updateCandidate', candidateId('23'), { prefecture: '東京都' }));
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'updateCandidate', candidateId('13'), { prefecture: '愛知県' }));
    assert.equal(await scalar(tx, 'select prefecture from public.v3_candidates where id=$1', [candidateId('13')]), '東京都');
    assert.equal(await scalar(tx, 'select prefecture from public.v3_candidates where id=$1', [candidateId('23')]), '愛知県');
  }));

  test('candidate RPC cannot repair unknown/blank prefectures through a regional actor', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    for (const target of [98, 99, 100]) {
      assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'updateCandidate', candidateId(target), { prefecture: '東京都' }), [400, 403, 404]);
      assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'deleteCandidate', candidateId(target)), [400, 403, 404]);
    }
  }));

  test('in-scope candidate update and cascading parent delete succeed', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    assert.equal((await candidateRpc(tx, user.tokyoAdmin, 'updateCandidate', candidateId('13'), { name: 'Synthetic updated name' })).ok, true);
    assert.equal(await scalar(tx, 'select name from public.v3_candidates where id=$1', [candidateId('13')]), 'Synthetic updated name');
    assert.equal((await candidateRpc(tx, user.tokyoAdmin, 'deleteCandidate', candidateId('13'))).ok, true);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where id=$1', [candidateId('13')]), 0);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_progress where candidate_id=$1', [candidateId('13')]), 0);
  }));

  test('candidate creation requires the actor prefecture and keeps failure atomic', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    const payload = { candidate_code: 'SYNTH-CREATED', name: 'Synthetic created name', election_name: 'Synthetic election', prefecture: '東京都', sheet_id: null };
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'createCandidate', null, { ...payload, prefecture: '愛知県' }), [400, 403]);
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'createCandidate', null, { ...payload, prefecture: '' }), [400, 403]);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where candidate_code=$1', [payload.candidate_code]), 0);
    assert.equal((await candidateRpc(tx, user.tokyoAdmin, 'createCandidate', null, payload)).ok, true);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where candidate_code=$1', [payload.candidate_code]), 1);
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'createCandidate', null, payload), [409]);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where candidate_code=$1', [payload.candidate_code]), 1);
  }));

  test('malformed candidate payloads cannot modify candidate or progress rows', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    const original = await scalar(tx, 'select to_jsonb(c) from public.v3_candidates c where id=$1', [candidateId('13')]);
    const progressCount = await scalar(tx, 'select count(*)::int from public.v3_progress where candidate_id=$1', [candidateId('13')]);
    for (const payload of [null, [], {}, { name: null }, { name: '' }, { name: 2 },
      { name: 'x'.repeat(201) }, { candidate_code: 'SYNTH-recode' },
      { prefecture_code: '23' }, { p_actor_id: user.aichiAdmin }, { sheet_id: 'invalid' }]) {
      assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'updateCandidate', candidateId('13'), payload), [400]);
    }
    assert.deepEqual(await scalar(tx, 'select to_jsonb(c) from public.v3_candidates c where id=$1', [candidateId('13')]), original);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_progress where candidate_id=$1', [candidateId('13')]), progressCount);
  }));

  test('missing, unassigned and disabled actors cannot use management RPCs', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    for (const actor of [null, userId(99), user.unassignedAdmin, user.disabledTokyo]) {
      assertRejected(await candidateRpc(tx, actor, 'deleteCandidate', candidateId('13')), [403]);
      assertRejected(await usersRpc(tx, actor, 'list'), [403]);
    }
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where id=$1', [candidateId('13')]), 1);
  }));

  test('candidate RPC reads the current database actor scope and status', () => scenario(async (tx) => {
    await tx.query(`update public.v3_users set prefecture_code='23' where id=$1`, [user.tokyoAdmin]);
    await asRole(tx, 'service_role');
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'updateCandidate', candidateId('13'), { name: 'Synthetic forbidden' }));
    await tx.exec('reset role');
    await tx.query(`update public.v3_users set status='disabled',prefecture_code='13' where id=$1`, [user.tokyoAdmin]);
    await asRole(tx, 'service_role');
    assertRejected(await candidateRpc(tx, user.tokyoAdmin, 'deleteCandidate', candidateId('13')));
  }));

  test('user listing is scoped and cursor pagination cannot cross prefectures', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    const first = await usersRpc(tx, user.tokyoAdmin, 'list', null, null, null, 1);
    assert.equal(first.ok, true);
    assert.equal(first.users.length, 1);
    assert.equal(first.users[0].prefecture_code, '13');
    assert.equal(typeof first.next_cursor, 'string');
    const second = await usersRpc(tx, user.tokyoAdmin, 'list', null, null, first.next_cursor, 1);
    assert.equal(second.ok, true);
    assert.equal(second.users.length, 1);
    assert.equal(second.users[0].prefecture_code, '13');
    assert.notEqual(second.users[0].id, first.users[0].id);
    assertRejected(await usersRpc(tx, user.tokyoViewer, 'list'));
  }));

  test('user listing rejects invalid page limits without changing membership', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    const count = await scalar(tx, 'select count(*)::int from public.v3_users');
    for (const limit of [null, 0, -1, 201]) {
      assertRejected(await usersRpc(tx, user.tokyoAdmin, 'list', null, null, null, limit), [400]);
    }
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_users'), count);
  }));

  test('regional admin cannot approve, disable, change role or delete another prefecture', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    for (const action of ['approve', 'disable', 'enable', 'set_role', 'delete']) {
      assertRejected(await usersRpc(tx, user.tokyoAdmin, action, user.pendingAichi, action === 'set_role' ? 'admin' : null));
    }
    assert.equal(await scalar(tx, 'select status from public.v3_users where id=$1', [user.pendingAichi]), 'pending');
  }));

  test('regional admin cannot provision or approve an unassigned target', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    for (const action of ['approve', 'enable', 'set_role', 'delete']) {
      assertRejected(await usersRpc(tx, user.tokyoAdmin, action, user.unassignedPending, action === 'set_role' ? 'admin' : null));
    }
    assert.equal(await scalar(tx, 'select prefecture_code from public.v3_users where id=$1', [user.unassignedPending]), null);
  }));

  test('regional admin can approve a trusted preassigned same-prefecture viewer', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    assert.equal((await usersRpc(tx, user.tokyoAdmin, 'approve', user.pendingTokyo, 'viewer')).ok, true);
    const target = (await tx.query('select status,role,prefecture_code from public.v3_users where id=$1', [user.pendingTokyo])).rows[0];
    assert.deepEqual(target, { status: 'active', role: 'viewer', prefecture_code: '13' });
  }));

  test('same-prefecture enable and role changes preserve the trusted assignment', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    assert.equal((await usersRpc(tx, user.tokyoAdmin, 'enable', user.disabledTokyo)).ok, true);
    assert.equal((await usersRpc(tx, user.tokyoAdmin, 'set_role', user.disabledTokyo, 'admin')).ok, true);
    assert.deepEqual((await tx.query('select status,role,prefecture_code from public.v3_users where id=$1', [user.disabledTokyo])).rows[0],
      { status: 'active', role: 'admin', prefecture_code: '13' });
    assert.equal((await usersRpc(tx, user.tokyoAdmin, 'set_role', user.disabledTokyo, 'viewer')).ok, true);
    assert.equal(await scalar(tx, 'select prefecture_code from public.v3_users where id=$1', [user.disabledTokyo]), '13');
  }));

  test('same-prefecture application-user delete returns only the authorized target ID', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    const result = await usersRpc(tx, user.tokyoAdmin, 'delete', user.tokyoViewer);
    assert.deepEqual(result, { ok: true, deleted_user_id: user.tokyoViewer });
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_users where id=$1', [user.tokyoViewer]), 0);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_users where id=$1', [user.aichiViewer]), 1);
  }));

  for (const action of ['disable', 'set_role', 'delete']) {
    test(`a regional admin cannot ${action} themselves even with another active regional admin`, () => scenario(async (tx) => {
      await asRole(tx, 'service_role');
      const result = await usersRpc(tx, user.tokyoAdmin, action, user.tokyoAdmin, action === 'set_role' ? 'viewer' : null);
      assertRejected(result, [400]);
      assert.equal(result.code, 'SELF_CHANGE');
      assert.deepEqual((await tx.query('select status,role,prefecture_code from public.v3_users where id=$1', [user.tokyoAdmin])).rows[0],
        { status: 'active', role: 'admin', prefecture_code: '13' });
      assert.equal(await scalar(tx, `select count(*)::int from public.v3_users where status='active' and role='admin' and prefecture_code='13'`), 2);
    }));
  }

  test('setting another user to their existing role is rejected without changing approval audit', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    const original = await scalar(tx, 'select to_jsonb(u) from public.v3_users u where id=$1', [user.secondTokyoAdmin]);
    const result = await usersRpc(tx, user.tokyoAdmin, 'set_role', user.secondTokyoAdmin, 'admin');
    assertRejected(result, [400]);
    assert.equal(result.code, 'NO_CHANGE');
    assert.deepEqual(await scalar(tx, 'select to_jsonb(u) from public.v3_users u where id=$1', [user.secondTokyoAdmin]), original);
  }));

  test('reenabling a same-prefecture user retains the original approval timestamp and actor', () => scenario(async (tx) => {
    await tx.query(`update public.v3_users set approved_at='2020-01-02T03:04:05Z',approved_by=$1 where id=$2`,
      [user.secondTokyoAdmin, user.disabledTokyo]);
    const original = (await tx.query('select approved_at::text,approved_by from public.v3_users where id=$1', [user.disabledTokyo])).rows[0];
    await asRole(tx, 'service_role');
    assert.equal((await usersRpc(tx, user.tokyoAdmin, 'enable', user.disabledTokyo)).ok, true);
    assert.deepEqual((await tx.query('select approved_at::text,approved_by from public.v3_users where id=$1', [user.disabledTokyo])).rows[0], original);
    assert.equal(await scalar(tx, 'select status from public.v3_users where id=$1', [user.disabledTokyo]), 'active');
  }));

  test('last active admin is protected per prefecture even when other regions have admins', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    for (const action of ['disable', 'delete', 'set_role']) {
      const result = await usersRpc(tx, user.aichiAdmin, action, user.aichiAdmin, action === 'set_role' ? 'viewer' : null);
      assertRejected(result, [400]);
      assert.equal(result.code, 'LAST_ADMIN');
    }
    assert.equal(await scalar(tx, `select count(*)::int from public.v3_users where status='active' and role='admin' and prefecture_code='23'`), 1);
  }));

  test('serialized reciprocal disable retains an admin and rejects the now-disabled actor', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    assert.equal((await usersRpc(tx, user.tokyoAdmin, 'disable', user.secondTokyoAdmin)).ok, true);
    assertRejected(await usersRpc(tx, user.secondTokyoAdmin, 'disable', user.tokyoAdmin));
    assert.equal(await scalar(tx, `select count(*)::int from public.v3_users where status='active' and role='admin' and prefecture_code='13'`), 1);
  }));

  test('transaction rollback restores both candidate and cascading progress changes', () => scenario(async (tx) => {
    await asRole(tx, 'service_role');
    await tx.exec('savepoint synthetic_failure');
    assert.equal((await candidateRpc(tx, user.tokyoAdmin, 'deleteCandidate', candidateId('13'))).ok, true);
    await tx.exec('rollback to savepoint synthetic_failure; release savepoint synthetic_failure');
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_candidates where id=$1', [candidateId('13')]), 1);
    assert.equal(await scalar(tx, 'select count(*)::int from public.v3_progress where candidate_id=$1', [candidateId('13')]), 1);
  }));
});
