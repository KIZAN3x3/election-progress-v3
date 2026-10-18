import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Actual classic config, auth module and index init; only synthetic responses.
// No real SDK, network, environment variables or production credentials enter the VM.
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const configSource = read('config.js');
const authSource = read('auth.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const KEY = 'sb_publishable_SYNTHETIC_PUBLIC_CONFIG';
const PRIVATE = 'SYNTHETIC_PRIVATE_RESPONSE';
const ERROR = '接続設定を取得できませんでした。ページを再読み込みしてください';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

async function fixture(configResponse = Response.json({ publishable_key: KEY }), options = {}) {
  const timers = new Map();
  const stored = new Map();
  const local = new Map();
  const state = { requests: [], clients: [], sessions: 0, signIns: 0, signOuts: 0, logs: [], redirects: [] };
  let nextTimer = 1;
  const client = { auth: {
    getSession: async () => { state.sessions++; return { data: { session: options.session ? { access_token: 'SYNTHETIC_USER_JWT' } : null } }; },
    signInWithOAuth: async () => { state.signIns++; return { error: null }; },
    signOut: async () => { state.signOuts++; return { error: null }; },
  } };
  const elements = new Map();
  const element = () => ({ textContent: '', hidden: true, disabled: false, addEventListener(){} });
  const context = vm.createContext({
    AbortController,
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, init) => {
      state.requests.push({ url, init });
      if(url.endsWith('/functions/v1/v3-public-config')) return await configResponse;
      if(url.endsWith('/functions/v1/v3-users')) return Response.json({ status: 'active', user: { id: 'synthetic-user', role: 'viewer' } });
      if(url.endsWith('/functions/v1/v3-sync-progress')) return Response.json({ results: [] });
      throw new Error('Unexpected fixture endpoint');
    },
    createClient: (url, key, clientOptions) => { state.clients.push({ url, key, options: clientOptions }); return client; },
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    localStorage: { get length(){ return local.size; }, key: index => [...local.keys()][index] ?? null,
      removeItem: key => { if(options.storageDenied) throw new Error(PRIVATE); local.delete(key); } },
    location: { origin: 'https://example.invalid', pathname: '/app/index.html', search: '', href: 'https://example.invalid/app/index.html', replace: value => state.redirects.push(value) },
    history: { replaceState(){} }, URL, URLSearchParams, navigator: { userAgent: 'Synthetic browser' },
    document: { getElementById: id => { if(!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    console: { error: (...args) => state.logs.push(args), log: (...args) => state.logs.push(args) },
  });
  vm.runInContext(configSource, context);
  const api = await vm.runInContext(`(async()=>{${authSource}\nreturn {getSupabase,loadAccount,startGoogleLogin,usersApi,syncApi,signOutLocal,isInAppBrowser,takeLoginMessage,safeNextPage,showAccountGate};})()`, context);
  return { context, state, api, stored, local, elements, timers,
    ready: () => vm.runInContext('SUPABASE_CONFIG_READY', context),
    key: () => vm.runInContext('SUPABASE_KEY', context),
    expire: () => { for(const timer of [...timers.values()]) timer.fn(); },
  };
}

test('classic config obtains one public key using an anonymous GET', async () => {
  const f = await fixture();
  assert.equal(await f.ready(), true);
  assert.equal(f.key(), KEY);
  assert.equal(f.state.requests.length, 1);
  const request = f.state.requests[0];
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.mode, 'cors');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.headers, undefined);
  assert.equal(request.init.signal.aborted, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.state.clients.length, 0);
});
test('loadAccount waits for config and preserves the synchronous cached client API', async () => {
  const response = deferred(); const f = await fixture(response.promise);
  assert.throws(() => f.api.getSupabase(), { message: ERROR });
  const pending = f.api.loadAccount();
  assert.equal(f.state.clients.length, 0); assert.equal(f.state.sessions, 0);
  response.resolve(Response.json({ publishable_key: KEY }));
  assert.equal((await pending).account, null);
  assert.equal(f.state.clients[0].key, KEY);
  assert.equal(f.api.getSupabase(), f.api.getSupabase());
  assert.equal(f.state.clients.length, 1);
  assert.equal(f.state.clients[0].options.auth.flowType, 'pkce');
  assert.equal(f.state.clients[0].options.auth.persistSession, true);
});
test('Google login and API calls wait for the same configuration', async () => {
  const response = deferred(); const f = await fixture(response.promise, { session: true });
  const login = f.api.startGoogleLogin();
  const account = f.api.usersApi('me');
  assert.equal(f.state.signIns, 0); assert.equal(f.state.clients.length, 0);
  response.resolve(Response.json({ publishable_key: KEY }));
  await login; await account;
  assert.equal(f.state.signIns, 1); assert.equal(f.state.clients.length, 1);
  const call = f.state.requests.find(request => request.url.endsWith('/v3-users'));
  assert.equal(call.init.headers.apikey, KEY);
  assert.equal(call.init.headers.Authorization, 'Bearer SYNTHETIC_USER_JWT');
  assert.deepEqual(JSON.parse(call.init.body), { action: 'me' });
});
test('sync API and local signout retain their contracts after waiting', async () => {
  const response = deferred(); const f = await fixture(response.promise, { session: true });
  const sync = f.api.syncApi({ action: 'updateCandidate', id: 'synthetic-id' });
  const signout = f.api.signOutLocal();
  assert.equal(f.state.signOuts, 0);
  response.resolve(Response.json({ publishable_key: KEY }));
  assert.equal((await sync).status, 200); await signout;
  assert.equal(f.state.signOuts, 1);
  const call = f.state.requests.find(request => request.url.endsWith('/v3-sync-progress'));
  assert.deepEqual(JSON.parse(call.init.body), { action: 'updateCandidate', id: 'synthetic-id' });
});

const invalidPayloads = [null, [], {}, { publishable_key: '' }, { publishable_key: 'sb_publishable_' },
  { publishable_key: 'sb_secret_SYNTHETIC_SECRET' }, { publishable_key: 'SYNTHETIC_LEGACY_JWT' },
  { publishable_key: `${KEY}\n` }, { publishable_key: ` ${KEY}` }, { publishable_key: {} },
  Object.create({ publishable_key: KEY })];
for(const [index, payload] of invalidPayloads.entries()) {
  test(`invalid public configuration ${index + 1} fails without creating a client`, async () => {
    const f = await fixture({ ok: true, json: async () => payload });
    assert.equal(await f.ready(), false); assert.equal(f.key(), null);
    await assert.rejects(f.api.loadAccount(), { message: ERROR });
    await assert.rejects(f.api.startGoogleLogin(), { message: ERROR });
    assert.equal(f.state.clients.length, 0);
    assert.equal(f.stored.has('v3:googleLoginPending'), false);
    assert.deepEqual(f.state.logs, []);
  });
}
for(const [label, response] of [
  ['HTTP failure', new Response(PRIVATE, { status: 503 })],
  ['invalid JSON', new Response(PRIVATE, { status: 200 })],
]) {
  test(`${label} becomes a fixed auth error without exposing the response`, async () => {
    const f = await fixture(response);
    assert.equal(await f.ready(), false);
    await assert.rejects(f.api.usersApi('me'), { message: ERROR });
    assert.deepEqual(f.state.logs, []); assert.equal(f.state.clients.length, 0);
  });
}
test('network failure including a CORS rejection is contained without external messages', async () => {
  const response = deferred(); const f = await fixture(response.promise);
  response.resolve(Promise.reject(new TypeError(PRIVATE)));
  assert.equal(await f.ready(), false);
  await assert.rejects(f.api.loadAccount(), { message: ERROR });
  assert.deepEqual(f.state.logs, []);
});
test('the overall deadline settles even when fetch ignores abort; late data cannot install a key', async () => {
  const response = deferred(); const f = await fixture(response.promise);
  const loading = f.api.loadAccount();
  assert.equal([...f.timers.values()][0].delay, 8000);
  f.expire();
  await assert.rejects(loading, { message: ERROR });
  assert.equal(await f.ready(), false);
  assert.equal(f.state.requests[0].init.signal.aborted, true);
  response.resolve(Response.json({ publishable_key: KEY }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.key(), null); assert.equal(f.state.clients.length, 0);
});
test('the deadline also bounds response-body parsing', async () => {
  const body = deferred(); const f = await fixture({ ok: true, json: () => body.promise });
  f.expire();
  assert.equal(await f.ready(), false);
  await assert.rejects(f.api.loadAccount(), { message: ERROR });
  body.resolve({ publishable_key: KEY });
  await Promise.resolve(); assert.equal(f.key(), null);
});
for(const scenario of ['HTTP failure', 'timeout']) {
  test(`local signout removes only this project's stored session when config has ${scenario}`, async () => {
    const response = deferred(); const f = await fixture(scenario === 'timeout' ? response.promise : new Response(PRIVATE, { status: 503 }));
    const key = `sb-${new URL(f.state.requests[0].url).hostname.split('.')[0]}-auth-token`;
    const authKeys = [key, key + '-user', key + '-code-verifier', key + '-flows-code-verifier', key + '-flow-synthetic-code-verifier'];
    authKeys.forEach(name => f.local.set(name, PRIVATE));
    f.local.set('unrelated-preference', 'keep');
    f.local.set('sb-other-project-auth-token', PRIVATE);
    f.stored.set('v3:googleLoginPending', '1');
    const logout = f.api.signOutLocal();
    if(scenario === 'timeout') f.expire();
    assert.equal(await logout, true);
    assert.equal(f.state.clients.length, 0); assert.equal(f.state.signOuts, 0);
    authKeys.forEach(name => assert.equal(f.local.has(name), false));
    assert.equal(f.local.get('unrelated-preference'), 'keep');
    assert.equal(f.local.has('sb-other-project-auth-token'), true);
    assert.equal(f.stored.has('v3:googleLoginPending'), false);
  });
}
test('local storage failure is reported as failure with no sensitive error output', async () => {
  const f = await fixture(new Response(PRIVATE, { status: 503 }), { storageDenied: true });
  assert.equal(await f.api.signOutLocal(), false);
  assert.equal(f.state.logs.flat().some(value => String(value).includes(PRIVATE)), false);
});
for(const scenario of ['success', 'timeout', 'HTTP failure']) {
  test(`actual index init handles configuration ${scenario}`, async () => {
    const response = deferred();
    const f = await fixture(scenario === 'success' ? Response.json({ publishable_key: KEY }) :
      scenario === 'HTTP failure' ? new Response(PRIVATE, { status: 503 }) : response.promise);
    Object.assign(f.context, f.api);
    const html = read('index.html');
    const module = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
      .replace(/^import .*;\r?\n/gm, '').replace(/\binit\(\);\s*$/, 'await init();');
    const init = vm.runInContext(`(async()=>{${module}})()`, f.context);
    if(scenario === 'timeout') f.expire();
    await init;
    assert.equal(f.elements.get('googleLoginBtn').hidden, false);
    assert.equal(f.elements.get('googleLoginBtn').disabled, false);
    assert.equal(f.elements.get('loginError').textContent, scenario === 'success' ? '' :
      'ログイン状態を確認できませんでした。時間をおいて再度お試しください');
    assert.equal(f.state.clients.length, scenario === 'success' ? 1 : 0);
    assert.equal(f.state.logs.flat().some(value => String(value).includes(PRIVATE)), false);
  });
}
test('all protected page entry points load the matched versioned config and auth', () => {
  for(const page of ['index.html', 'admin.html', 'list.html', 'detail.html']) {
    const html = read(page);
    assert.equal(html.includes('src="config.js?v=public-config-1"'), true);
    assert.equal(html.includes("from './auth.js?v=public-config-1';"), true);
  }
});
