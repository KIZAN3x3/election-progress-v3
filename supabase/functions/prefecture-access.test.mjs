import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Actual HTTP handlers and helpers; all identity, RPC and rows are synthetic.
// The VM has no process, fetch, SDK, filesystem, environment, or production credentials.
// RPC responses model its contract; the separate SQL suite must test real RLS/transactions.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const plain = source => source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const helpers = ['_shared/prefectures.ts', '_shared/auth.ts', '_shared/scoped-rpc.ts'].map(path => plain(read(path))).join('\n');
const ACTOR = '00000000-0000-4000-8000-000000000001';
const OWN = '00000000-0000-4000-8000-000000000002';
const FOREIGN = '00000000-0000-4000-8000-000000000003';
const UNASSIGNED = '00000000-0000-4000-8000-000000000004';
const CANDIDATE = '00000000-0000-4000-8000-000000000011';
const OTHER_CANDIDATE = '00000000-0000-4000-8000-000000000012';
const CURSOR = '00000000-0000-4000-8000-000000000020';
const CANARY = 'SYNTHETIC_PRIVATE_ERROR';
const user = (id, scope, extra = {}) => ({ id, email: 'fixture@example.invalid', display_name: 'Fixture',
  status: 'active', role: 'admin', prefecture_code: scope, ...extra });
const ownCandidate = { candidate_code: 'fixture', name: 'Fixture', election_name: 'Fixture election', prefecture: '愛知県' };

class Query {
  constructor(db, table) { this.db = db; this.table = table; this.filters = []; this.op = 'select'; }
  select(columns) { this.columns = columns; return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
  maybeSingle() { this.isSingle = true; return this; }
  single() { this.isSingle = true; return this; }
  insert(data) { this.op = 'insert'; this.payload = data; return this; }
  update(data) { this.op = 'update'; this.payload = data; return this; }
  upsert(data) { this.op = 'upsert'; this.payload = data; return this; }
  delete() { this.op = 'delete'; return this; }
  then(resolve, reject) { return this.run().then(resolve, reject); }
  async run() {
    const rows = this.db.rows[this.table];
    const selected = rows.filter(row => this.filters.every(filter => filter(row)));
    this.db.queries.push({ table: this.table, op: this.op, columns: this.columns, payload: this.payload });
    if (this.op === 'insert') { rows.push(structuredClone(this.payload)); return { data: structuredClone(this.payload), error: null }; }
    if (this.op === 'update') selected.forEach(row => Object.assign(row, this.payload));
    if (this.op === 'upsert') rows.push(...structuredClone(this.payload));
    if (this.op === 'delete') this.db.rows[this.table] = rows.filter(row => !selected.includes(row));
    return { data: this.isSingle ? structuredClone(selected[0] ?? null) : structuredClone(selected), error: null };
  }
}

function fixture(route, actorOverrides = {}) {
  const db = {
    rows: { v3_users: [user(ACTOR, '23', actorOverrides), user(OWN, '23'), user(FOREIGN, '13'), user(UNASSIGNED, null)],
      v3_candidates: [{ id: CANDIDATE, ...ownCandidate }, { id: OTHER_CANDIDATE, ...ownCandidate, candidate_code: 'other', prefecture: '東京都' }], v3_progress: [] },
    queries: [], calls: [], authCalls: [], authDeletes: [], authDeleteError: false, beforeRpc: null, rpcResult: null,
    from(table) { return new Query(this, table); },
    async rpc(name, args) {
      this.calls.push({ name, args: structuredClone(args) });
      if (this.beforeRpc) this.beforeRpc();
      if (this.rpcResult) return this.rpcResult;
      const actor = this.rows.v3_users.find(row => row.id === args.p_actor_id);
      const denied = status => ({ data: { ok: false, status, error: '操作できません' }, error: null });
      if (!actor || actor.status !== 'active' || actor.role !== 'admin' || !/^(0[1-9]|[1-3][0-9]|4[0-7])$/.test(actor.prefecture_code ?? '')) return denied(403);
      if (name === 'v3_manage_users') {
        if (args.p_action === 'list') return { data: { ok: true, users: this.rows.v3_users.filter(row => row.prefecture_code === actor.prefecture_code), next_cursor: null }, error: null };
        const target = this.rows.v3_users.find(row => row.id === args.p_target_id);
        if (!target || target.prefecture_code !== actor.prefecture_code) return denied(404);
        return { data: args.p_action === 'delete' ? { ok: true, deleted_user_id: target.id } : { ok: true }, error: null };
      }
      if (name !== 'v3_manage_candidate') throw new Error('Unexpected fixture RPC');
      const names = { 愛知県: '23', 東京都: '13' };
      if (args.p_action !== 'createCandidate') {
        const target = this.rows.v3_candidates.find(row => row.id === args.p_candidate_id);
        if (!target || names[target.prefecture] !== actor.prefecture_code) return denied(404);
      }
      if (args.p_payload.prefecture !== undefined && names[args.p_payload.prefecture] !== actor.prefecture_code) return denied(403);
      return { data: { ok: true }, error: null };
    },
  };
  db.auth = {
    getUser: async token => { db.authCalls.push(token); return token === 'fixture-jwt'
      ? { data: { user: { id: ACTOR, email: 'fixture@example.invalid', user_metadata: { prefecture_code: '13', role: 'admin' } } }, error: null }
      : { data: null, error: { status: 401, message: CANARY } }; },
    admin: { deleteUser: async id => { db.authDeletes.push(id); return { error: db.authDeleteError ? { message: CANARY } : null }; } },
  };
  let source = plain(read(`${route}/index.ts`)).split('Deno.serve')[0];
  source = source.replace(/const SUPABASE_URL[\s\S]*?const supabase = createClient\([^;]*;/,
    'const supabase = globalThis.__db; const V3_SYNC_TOKEN = "fixture-machine-token";');
  const cleanup = route === 'v3-sync-progress' ? plain(read('v3-sync-progress/cleanup.ts')) : '';
  const context = { __db: db, Request, Response, URL, console: { log() {}, warn() {}, error() {} } };
  vm.runInNewContext(stripTypeScriptTypes(helpers + '\n' + cleanup + '\n' + source), context);
  const handle = vm.runInNewContext('handle', context);
  return { db, async call(body, token = 'fixture-jwt', method = 'POST') {
    const req = new Request('https://fixture.invalid/', { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    const res = await handle(req); return { status: res.status, body: await res.json() };
  } };
}

for (const route of ['v3-sync-progress', 'v3-users']) {
  for (const [label, overrides] of [['pending', { status: 'pending' }], ['disabled', { status: 'disabled' }], ['viewer', { role: 'viewer' }],
    ['unassigned admin', { prefecture_code: null }], ['invalid assignment', { prefecture_code: '00' }]]) {
    test(`${route} denies ${label} before any privileged RPC`, async () => {
      const f = fixture(route, overrides);
      const result = await f.call(route === 'v3-users' ? { action: 'list' } : { action: 'createCandidate', ...ownCandidate });
      assert.equal(result.status, 403); assert.equal(f.db.calls.length, 0);
    });
  }
  for (const token of [null, 'invalid-jwt']) test(`${route} rejects missing/invalid JWT`, async () => {
    const f = fixture(route); const r = await f.call(route === 'v3-users' ? { action: 'list' } : { action: 'createCandidate', ...ownCandidate }, token);
    assert.equal(r.status, 401); assert.equal(f.db.calls.length, 0); assert.ok(!JSON.stringify(r.body).includes(CANARY));
  });
  for (const body of [null, [], 'bad', { action: {} }, { action: 'assign_prefecture', prefecture_code: '13' }]) {
    test(`${route} rejects malformed body/action`, async () => {
      const f = fixture(route); assert.equal((await f.call(body)).status, 400); assert.equal(f.db.calls.length, 0);
    });
  }
  test(`${route} rejects an unsupported HTTP method`, async () => {
    const f = fixture(route); assert.equal((await f.call(null, 'fixture-jwt', 'GET')).status, 405);
  });
  test(`${route} respects transactional recheck after actor is disabled`, async () => {
    const f = fixture(route); f.db.beforeRpc = () => { f.db.rows.v3_users[0].status = 'disabled'; };
    const result = await f.call(route === 'v3-users' ? { action: 'list' } : { action: 'createCandidate', ...ownCandidate });
    assert.equal(result.status, 403); assert.equal(f.db.calls.length, 1);
    assert.equal(f.db.queries.filter(q => q.op !== 'select').length, 0);
  });
  test(`${route} hides an unexpected SQL error`, async () => {
    const f = fixture(route); f.db.rpcResult = { data: null, error: { message: CANARY, details: CANARY } };
    const result = await f.call(route === 'v3-users' ? { action: 'list' } : { action: 'createCandidate', ...ownCandidate });
    assert.equal(result.status, 500); assert.ok(!JSON.stringify(result.body).includes(CANARY));
  });
}

test('candidate creation forwards only normalized input and JWT actor, never body scope/actor', async () => {
  const f = fixture('v3-sync-progress');
  const r = await f.call({ action: 'createCandidate', ...ownCandidate, prefecture: ' 愛知県 ', actor_id: FOREIGN, prefecture_code: '13', role: 'admin', token: 'untrusted' });
  assert.equal(r.status, 200); assert.equal(r.body.results[0].status, 'ok');
  assert.deepEqual(f.db.calls[0], { name: 'v3_manage_candidate', args: { p_actor_id: ACTOR, p_action: 'createCandidate', p_candidate_id: null,
    p_payload: { ...ownCandidate, sheet_id: null } } });
  assert.equal(f.db.queries.filter(q => q.table === 'v3_candidates').length, 0);
});
for (const [prefecture, status] of [['東京都', 403], ['', 400], ['愛知', 400], ['23', 400], ['\t愛知県', 400], ['全都道府県', 400]]) {
  test(`candidate creation rejects nonmatching/noncanonical prefecture (${status})`, async () => {
    const f = fixture('v3-sync-progress'); assert.equal((await f.call({ action: 'createCandidate', ...ownCandidate, prefecture })).status, status);
    assert.equal(f.db.calls.length, 0);
  });
}
test('mixed-prefecture bulk is rejected before its first write', async () => {
  const f = fixture('v3-sync-progress');
  assert.equal((await f.call({ action: 'createCandidate', candidates: [ownCandidate, { ...ownCandidate, prefecture: '東京都' }] })).status, 403);
  assert.equal(f.db.calls.length, 0);
});
test('candidate conflicts reveal only the generic RPC error, not cross-prefecture duplication', async () => {
  for (const payload of [{ action: 'createCandidate', ...ownCandidate }, { action: 'createCandidate', candidates: [ownCandidate, { ...ownCandidate, candidate_code: 'fixture-two' }] }]) {
    const f = fixture('v3-sync-progress');
    f.db.rpcResult = { data: { ok: false, status: 409, error: '処理が競合しました', code: 'CONFLICT' }, error: null };
    const result = await f.call(payload);
    assert.equal(result.status, 207);
    assert.ok(result.body.results.every(row => row.status === 'error' && row.error === '処理が競合しました' && !('reason' in row) && !('code' in row)));
    assert.ok(!JSON.stringify(result.body).includes('duplicate'));
  }
});
for (const action of ['updateCandidate', 'deleteCandidate']) {
  test(`${action} authorizes existing target in RPC and hides foreign/missing targets equally`, async () => {
    const f = fixture('v3-sync-progress');
    assert.equal((await f.call({ action, id: CANDIDATE, name: 'Changed' })).status, 200);
    const other = await f.call({ action, id: OTHER_CANDIDATE, name: 'Changed' });
    const missing = await f.call({ action, id: CURSOR, name: 'Changed' });
    assert.equal(other.status, 404); assert.deepEqual(other, missing);
    assert.equal(f.db.queries.filter(q => q.table === 'v3_candidates').length, 0);
  });
}
test('candidate update rejects moving a candidate into another prefecture', async () => {
  const f = fixture('v3-sync-progress');
  assert.equal((await f.call({ action: 'updateCandidate', id: CANDIDATE, prefecture: '東京都' })).status, 403);
  assert.equal(f.db.calls.length, 0);
});
test('candidate UUID/type failures are controlled 400 responses', async () => {
  for (const input of [{ action: 'deleteCandidate', id: 'bad' }, { action: 'updateCandidate', id: CANDIDATE, name: '' },
    { action: 'createCandidate', candidates: [null] }, { action: 'createCandidate', ...ownCandidate, sheet_id: {} }]) {
    const f = fixture('v3-sync-progress'); assert.equal((await f.call(input)).status, 400); assert.equal(f.db.calls.length, 0);
  }
});
test('a scoped administrator has no national exception', async () => {
  const f = fixture('v3-sync-progress', { prefecture_code: '13' });
  assert.equal((await f.call({ action: 'createCandidate', ...ownCandidate })).status, 403);
  assert.equal((await f.call({ action: 'createCandidate', ...ownCandidate, prefecture: '東京都' })).status, 200);
});

test('users list is scoped and cursor/actor arguments are server controlled', async () => {
  const f = fixture('v3-users');
  const r = await f.call({ action: 'list', cursor: CURSOR, actor_id: FOREIGN, prefecture_code: '13', limit: 999999 });
  assert.equal(r.status, 200); assert.deepEqual(r.body.users.map(row => row.id), [ACTOR, OWN]);
  assert.equal(f.db.calls[0].args.p_actor_id, ACTOR); assert.equal(f.db.calls[0].args.p_after_id, CURSOR); assert.equal(f.db.calls[0].args.p_limit, 200);
  assert.equal((await f.call({ action: 'list', cursor: 'bad' })).status, 400);
});
for (const action of ['approve', 'disable', 'enable', 'set_role', 'delete']) {
  test(`user ${action} cannot target foreign or unassigned users`, async () => {
    const f = fixture('v3-users');
    for (const target_id of [FOREIGN, UNASSIGNED, CURSOR]) assert.equal((await f.call({ action, target_id, role: 'viewer' })).status, 404);
    assert.equal(f.db.authDeletes.length, 0);
    assert.equal((await f.call({ action, target_id: OWN, role: 'viewer', actor_id: FOREIGN, prefecture_code: '13' })).status, 200);
    assert.equal(f.db.calls.at(-1).args.p_actor_id, ACTOR);
    assert.equal(f.db.queries.filter(q => q.op !== 'select').length, 0);
    assert.deepEqual(f.db.authDeletes, action === 'delete' ? [OWN] : []);
  });
}
test('Auth deletion requires matching ID from a successful scoped transaction', async () => {
  const f = fixture('v3-users'); f.db.rpcResult = { data: { ok: true, deleted_user_id: FOREIGN }, error: null };
  assert.equal((await f.call({ action: 'delete', target_id: OWN })).status, 500); assert.equal(f.db.authDeletes.length, 0);
});
test('Auth deletion failure preserves a safe manual-cleanup warning', async () => {
  const f = fixture('v3-users'); f.db.authDeleteError = true;
  const r = await f.call({ action: 'delete', target_id: OWN });
  assert.equal(r.status, 200); assert.equal(r.body.auth_deleted, false); assert.ok(r.body.warning); assert.ok(!JSON.stringify(r.body).includes(CANARY));
});
test('self registration cannot assign scope, role, status, or another identity', async () => {
  const f = fixture('v3-users'); f.db.rows.v3_users.shift();
  const r = await f.call({ action: 'register', display_name: 'Fixture', id: FOREIGN, actor_id: FOREIGN, status: 'active', role: 'admin', prefecture_code: '13' });
  assert.equal(r.status, 201); assert.equal(r.body.user.id, ACTOR); assert.equal(r.body.user.status, 'pending');
  assert.equal(r.body.user.role, 'viewer'); assert.equal(r.body.user.prefecture_code, null);
  assert.equal(f.db.calls.length, 0);
});
test('me and login disclose/update only the authenticated account, including an unassigned viewer', async () => {
  const f = fixture('v3-users', { role: 'viewer', prefecture_code: null });
  const me = await f.call({ action: 'me', target_id: FOREIGN }); assert.equal(me.status, 200); assert.equal(me.body.user.id, ACTOR); assert.equal(me.body.user.prefecture_code, null);
  assert.equal((await f.call({ action: 'login', target_id: FOREIGN })).status, 200);
  assert.ok(f.db.rows.v3_users[0].last_login_at); assert.equal(f.db.rows.v3_users[2].last_login_at, undefined);
  assert.equal((await f.call({ action: 'register', display_name: 'Changed' })).status, 409);
});
test('the machine sync credential retains the explicit national synchronization path', async () => {
  const f = fixture('v3-sync-progress', { status: 'disabled', prefecture_code: null });
  const body = { token: 'fixture-machine-token', records: [{ candidate_code: 'other', period: 'phase', items: [{ item_name: 'item', status: 'todo' }] }] };
  assert.equal((await f.call(body, null)).status, 200); assert.equal(f.db.authCalls.length, 0); assert.equal(f.db.calls.length, 0);
  assert.equal(f.db.rows.v3_progress[0].candidate_id, OTHER_CANDIDATE);
  assert.equal((await f.call({ ...body, token: 'wrong' }, null)).status, 401);
  assert.equal((await f.call({ ...body, action: 'deleteCandidate', id: CANDIDATE }, null)).status, 401);
});
