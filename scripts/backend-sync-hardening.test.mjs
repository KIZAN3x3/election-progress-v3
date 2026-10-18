import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Runs actual handlers/helpers with synthetic Auth, DB and logs. No network.
const functionRoot = new URL('../supabase/functions/', import.meta.url);
const files = ['_shared/backend-key.ts', '_shared/auth.ts', '_shared/cors.ts', 'v3-sync-progress/cleanup.ts', 'v3-sync-progress/index.ts'];
const actualCode = (await Promise.all(files.map(async path => {
  const source = await readFile(new URL(path, functionRoot), 'utf8');
  return stripTypeScriptTypes(source.replace(/^import[^\n]+\r?\n/gm, ''), { mode: 'strip' }).replace(/^export /gm, '');
}))).join('\n');
const admin = { id: '10000000-0000-4000-8000-000000000001', role: 'admin', status: 'active' };
const candidateId = '20000000-0000-4000-8000-000000000001';
const poison = 'PRIVATE_REMOTE_DETAIL_MUST_NOT_BE_LOGGED';
const code = 'PRIVATE_CANDIDATE_CODE';
const oldRow = { id: 'old', period: 'PRIVATE_OLD_PERIOD', item_name: 'PRIVATE_ITEM', status: 'PRIVATE_STATUS' };
const newRows = [1,2].map(id => ({ id: String(id), period: 'new', item_name: `item-${id}`, status: '未着手' }));

function fixture({ user = admin, query = () => ({ data: null, error: null }) } = {}){
  const calls = [];
  const logs = [];
  let served;
  const supabase = {
    auth: { getUser: async token => token === 'human-jwt'
      ? { data: { user: { id: admin.id } }, error: null }
      : { data: { user: null }, error: { status: 401 } } },
    from(table){
      const request = { table, operation: 'select', filters: [], values: null, columns: null };
      async function execute(){
        calls.push(request);
        if(table === 'v3_users') return { data: user, error: null };
        return await query(request);
      }
      const builder = {
        select(columns){ request.columns = columns; return builder; },
        insert(values){ request.operation = 'insert'; request.values = values; return builder; },
        update(values){ request.operation = 'update'; request.values = values; return builder; },
        upsert(values, options){ request.operation = 'upsert'; request.values = values; request.options = options; return builder; },
        delete(){ request.operation = 'delete'; return builder; },
        eq(key, value){ request.filters.push(['eq',key,value]); return builder; },
        in(key, value){ request.filters.push(['in',key,value]); return builder; },
        maybeSingle: execute,
        then(resolve, reject){ return execute().then(resolve, reject); }
      };
      return builder;
    }
  };
  new vm.Script(actualCode, { filename: 'actual-sync-handler.js' }).runInNewContext({
    createClient: () => supabase, Request, Response, Headers,
    console: Object.fromEntries(['log','warn','error'].map(level => [level, (...args) => logs.push({ level, args })])),
    Deno: { env: { get: name => ({ SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'fake-server-key', V3_SYNC_TOKEN: 'fake-machine-token' })[name] }, serve: handler => { served = handler; } }
  });
  return {
    calls, logs,
    send(body, { jwt = 'human-jwt', method = 'POST', origin = 'https://kizan3x3.github.io' } = {}){
      const headers = { 'Content-Type': 'application/json', Origin: origin };
      if(jwt) headers.Authorization = `Bearer ${jwt}`;
      return served(new Request('https://supabase.test/functions/v1/v3-sync-progress', { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }));
    }
  };
}

function assertSafeLogs(logs){
  for(const { args } of logs){
    assert.match(args[0], /^SYNC_[A-Z_]+$/);
    assert(args.slice(1).every(value => typeof value === 'number' && Number.isFinite(value)));
  }
  assert(!JSON.stringify(logs).includes(poison));
  for(const value of [code, oldRow.period, oldRow.item_name, oldRow.status]) assert(!JSON.stringify(logs).includes(value));
}

test('candidate deletion issues only one parent DELETE, letting the existing FK cascade atomically', async () => {
  const state = { candidate: true, progress: true };
  const f = fixture({ query: request => {
    assert.equal(request.table, 'v3_candidates');
    assert.equal(request.operation, 'delete');
    state.candidate = false; state.progress = false;
    return { data: null, error: null };
  } });
  const res = await f.send({ action: 'deleteCandidate', id: candidateId });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.deepEqual(state, { candidate: false, progress: false });
  assert.equal(f.calls.filter(call => call.operation === 'delete').length, 1);
});

test('failed parent DELETE cannot delete progress in an earlier independent request', async () => {
  const state = { candidate: true, progress: true };
  const f = fixture({ query: request => {
    if(request.table === 'v3_progress' && request.operation === 'delete') state.progress = false;
    return { data: null, error: { message: poison } };
  } });
  const res = await f.send({ action: 'deleteCandidate', id: candidateId });
  assert.equal(res.status, 500);
  assert.deepEqual(state, { candidate: true, progress: true });
  assert.equal(f.calls.filter(call => call.table === 'v3_progress').length, 0);
  assertSafeLogs(f.logs);
});

for(const [label, user, jwt, expected] of [
  ['missing JWT',admin,null,401], ['invalid JWT',admin,'invalid',401],
  ['viewer',{ ...admin,role:'viewer' },'human-jwt',403],
  ['pending admin',{ ...admin,status:'pending' },'human-jwt',403],
  ['disabled admin',{ ...admin,status:'disabled' },'human-jwt',403]
]) test(`candidate deletion still rejects ${label}`, async () => {
  const f = fixture({ user });
  assert.equal((await f.send({ action:'deleteCandidate',id:candidateId,token:'fake-machine-token' }, { jwt })).status, expected);
  assert.equal(f.calls.filter(call => call.table !== 'v3_users').length, 0);
});

test('mixed-prefecture bulk creation preserves existing nationwide administrator behavior and result contract', async () => {
  const f = fixture({ query: request => {
    if(request.operation === 'select') return { data: null, error: null };
    assert.equal(request.operation, 'insert');
    return { data: null, error: null };
  } });
  const res = await f.send({ action:'createCandidate',candidates:[
    { candidate_code:'one',name:'テスト1',election_name:'選挙',prefecture:'東京都' },
    { candidate_code:'two',name:'テスト2',election_name:'選挙',prefecture:'大阪府' }
  ] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).results.map(row => row.status), ['ok','ok']);
  assert.deepEqual(f.calls.filter(call => call.operation === 'insert').map(call => call.values.prefecture), ['東京都','大阪府']);
});

test('a human JWT cannot replace the machine sync token', async () => {
  const f = fixture();
  assert.equal((await f.send({ action:'sync',records:[] })).status, 401);
  assert.equal(f.calls.length, 0);
});

test('unknown action with a machine token does not execute writes', async () => {
  const f = fixture();
  assert.equal((await f.send({ action:'unexpected',token:'fake-machine-token' }, { jwt:null })).status, 400);
  assert.equal(f.calls.length, 0);
});

function cleanupFixture(mode){
  let touches = 0;
  return fixture({ query: request => {
    if(request.table === 'v3_candidates' && request.operation === 'select') return { data: { id:candidateId }, error:null };
    if(request.operation === 'upsert') return { data:null,error:null };
    if(request.table === 'v3_candidates' && request.operation === 'update'){
      if(request.values.sheet_modified_at) return { data:null,error:mode === 'modified-error' ? { message:poison } : null };
      touches++;
      return { data:null,error:mode === 'touch-error' && touches > 1 ? { message:poison } : null };
    }
    if(request.operation === 'select' && request.columns === 'item_name, required, status') return { data:[],error:null };
    if(request.operation === 'select'){
      if(mode === 'read-error') return { data:null,error:{ message:poison } };
      if(mode === 'throw') throw new Error(poison);
      return { data:mode === 'skip' ? [oldRow,newRows[0]] : [oldRow,...newRows],error:null };
    }
    if(request.operation === 'delete') return mode === 'delete-error'
      ? { data:null,error:{ message:poison } } : { data:[oldRow],error:null };
    throw new Error('unexpected synthetic query');
  } });
}

for(const [mode, classification] of [
  ['success','SYNC_CLEANUP_DELETED'], ['skip','SYNC_CLEANUP_SKIPPED'],
  ['read-error','SYNC_CLEANUP_READ_FAILED'], ['delete-error','SYNC_CLEANUP_DELETE_FAILED'],
  ['touch-error','SYNC_CANDIDATE_TOUCH_FAILED'], ['modified-error','SYNC_MODIFIED_AT_UPDATE_FAILED'],
  ['throw','SYNC_REQUEST_FAILED']
]) test(`cleanup ${mode}: logs contain only fixed classifications/counts`, async () => {
  const f = cleanupFixture(mode);
  const res = await f.send({ token:'fake-machine-token',fullSheet:true,modifiedTime:'2026-10-18T00:00:00Z',records:[
    { candidate_code:code,period:'new',items:[{ item_name:'item-1',status:'未着手' }] }
  ] }, { jwt:null });
  assert.equal(res.status, mode === 'throw' ? 500 : ['read-error','delete-error'].includes(mode) ? 207 : 200);
  assert(f.logs.some(log => log.args[0] === classification));
  assertSafeLogs(f.logs);
  const data = await res.json();
  if(mode === 'success'){
    assert.equal(data.cleanup[0].deleted[0].item_name, oldRow.item_name);
    assert.equal(data.results[0].status, 'ok');
  }
  if(mode === 'skip') assert(data.cleanup[0].warning.includes(oldRow.period));
  if(mode === 'throw') assert.deepEqual(data, { error:'internal error' });
  if(['read-error','delete-error'].includes(mode)){
    assert(data.cleanup[0].error);
    assert.equal(f.calls.filter(call => call.values?.sheet_modified_at).length, 0);
  }
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://kizan3x3.github.io');
});

test('unexpected handler failures are caught without logging arbitrary exception contents', async () => {
  const f = fixture({ query: () => { throw new Error(poison); } });
  const res = await f.send({ action:'deleteCandidate',id:candidateId });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error:'internal error' });
  assert.deepEqual(f.logs.map(log => log.args[0]), ['SYNC_REQUEST_FAILED']);
  assertSafeLogs(f.logs);
});

const validRecord = () => ({ candidate_code:code,period:'new',items:[{ item_name:'new-item',required:true,status:'未着手' }] });

for(const body of [null, [], 'text', 1]) test(`invalid top-level JSON ${JSON.stringify(body)} is a fixed 400 before DB access`, async () => {
  const f = fixture();
  const res = await f.send(body, { jwt:null });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error:'invalid json body' });
  assert.equal(f.calls.length, 0);
});

for(const [label, fields] of [
  ['records object',{ records:{} }], ['empty records',{ records:[] }], ['null record',{ records:[validRecord(),null] }],
  ['numeric code',{ records:[{ ...validRecord(),candidate_code:2 }] }],
  ['missing period',{ records:[{ ...validRecord(),period:undefined }] }],
  ['empty items',{ records:[{ ...validRecord(),items:[] }] }],
  ['null item',{ records:[validRecord(),{ ...validRecord(),period:'later',items:[null] }] }],
  ['blank item name',{ records:[{ ...validRecord(),items:[{ item_name:' ',status:'' }] }] }],
  ['non-string status',{ records:[{ ...validRecord(),items:[{ item_name:'item',status:3 }] }] }],
  ['non-boolean required',{ records:[{ ...validRecord(),items:[{ item_name:'item',required:'true',status:'' }] }] }],
  ['duplicate item',{ records:[{ ...validRecord(),items:[{ item_name:'same',status:'' },{ item_name:'same',status:'完了' }] }] }],
  ['duplicate candidate/period',{ records:[validRecord(),validRecord()] }],
  ['invalid fullSheet',{ records:[validRecord()],fullSheet:'true' }],
  ['invalid modifiedTime',{ records:[validRecord()],modifiedTime:'not-a-date' }]
]) test(`entire payload validation rejects ${label} before reads, writes or cleanup`, async () => {
  const f = fixture();
  const res = await f.send({ token:'fake-machine-token',fullSheet:true,modifiedTime:'2026-10-18T00:00:00Z',...fields }, { jwt:null });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error:'invalid sync payload' });
  assert.equal(f.calls.length, 0);
  assertSafeLogs(f.logs);
});

test('upsert failure retains stale progress and cannot reach cleanup or advance the cursor', async () => {
  let oldRowPresent = true;
  const f = fixture({ query: request => {
    if(request.table === 'v3_candidates' && request.operation === 'select') return { data:{ id:candidateId },error:null };
    if(request.operation === 'select') return { data:[{ item_name:'old-item',required:true,status:'未着手' }],error:null };
    if(request.operation === 'upsert') return { data:null,error:{ message:poison } };
    if(request.operation === 'delete') oldRowPresent = false;
    return { data:null,error:null };
  } });
  const res = await f.send({ token:'fake-machine-token',fullSheet:true,modifiedTime:'2026-10-18T00:00:00Z',records:[validRecord()] }, { jwt:null });
  assert.equal(res.status, 207);
  assert.equal(oldRowPresent, true);
  assert.equal(f.calls.filter(call => call.operation === 'delete').length, 0);
  assert.equal(f.calls.filter(call => call.values?.sheet_modified_at).length, 0);
  assert.equal(f.calls.filter(call => call.columns === 'id, period, item_name, status').length, 0);
});

test('replacement upsert precedes stale deletion and a later delete failure prevents cleanup/cursor', async () => {
  const f = fixture({ query: request => {
    if(request.table === 'v3_candidates' && request.operation === 'select') return { data:{ id:candidateId },error:null };
    if(request.operation === 'select') return { data:[{ item_name:'old-item',required:true,status:'未着手' }],error:null };
    if(request.operation === 'delete') return { data:null,error:{ message:poison } };
    return { data:null,error:null };
  } });
  const res = await f.send({ token:'fake-machine-token',fullSheet:true,modifiedTime:'2026-10-18T00:00:00Z',records:[validRecord()] }, { jwt:null });
  assert.equal(res.status, 207);
  assert.deepEqual(f.calls.filter(call => ['upsert','delete'].includes(call.operation)).map(call => call.operation), ['upsert','delete']);
  assert.equal(f.calls.filter(call => call.values?.sheet_modified_at).length, 0);
  assert.equal(f.calls.filter(call => call.columns === 'id, period, item_name, status').length, 0);
});

test('valid legacy payload and arbitrary reserved period names retain their existing success contract', async () => {
  const run = async body => {
    const f = fixture({ query: request => request.table === 'v3_candidates' && request.operation === 'select'
      ? { data:{ id:candidateId },error:null } : { data:request.operation === 'select' ? [] : null,error:null } });
    const res = await f.send({ token:'fake-machine-token',...body }, { jwt:null });
    assert.equal(res.status, 200);
    return { f,data:await res.json() };
  };
  const legacy = await run({ ...validRecord(),modifiedTime:null });
  assert.equal(legacy.data.results[0].status, 'ok');
  const periods = ['__proto__','constructor','toString',' 任意の見出し\n'];
  const { f,data } = await run({ records:periods.map(period => ({ ...validRecord(),period })) });
  assert.equal(data.results.length, periods.length);
  assert.deepEqual(f.calls.filter(call => call.operation === 'upsert').map(call => call.values[0].period), periods);
});

for(const failure of ['error','not_found']) for(const failedLookup of [1,2]) test(`candidate lookup ${failure} in period ${failedLookup} cannot be hidden by the other successful period`, async () => {
  let lookups = 0;
  const f = fixture({ query: request => {
    if(request.table === 'v3_candidates' && request.operation === 'select'){
      lookups++;
      if(lookups === failedLookup) return { data:null,error:failure === 'error' ? { message:poison } : null };
      return { data:{ id:candidateId },error:null };
    }
    return { data:request.operation === 'select' ? [] : null,error:null };
  } });
  const res = await f.send({ token:'fake-machine-token',fullSheet:true,modifiedTime:'2026-10-18T00:00:00Z',
    records:[{ ...validRecord(),period:'one' },{ ...validRecord(),period:'two' }] }, { jwt:null });
  assert.equal(res.status, failure === 'error' ? 207 : 200);
  const data = await res.json();
  assert.equal(data.results.filter(row => row.status === 'ok').length, 1);
  assert.equal(data.results.filter(row => row.status === failure).length, 1);
  assert(data.cleanup[0].skipped);
  assert.equal(f.calls.filter(call => call.columns === 'id, period, item_name, status').length, 0);
  assert.equal(f.calls.filter(call => call.operation === 'delete').length, 0);
  assert.equal(f.calls.filter(call => call.values?.sheet_modified_at).length, 0);
});
