import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as scope from '../prefecture-scope.js';

const root = new URL('../', import.meta.url);
const source = async path => readFile(new URL(path, root), 'utf8');
const tokyoAdmin = { id: 'self', role: 'admin', prefecture_code: '13', display_name: 'テスト管理者' };
const ownCandidate = { id: 'own', candidate_code: 'own-1', name: '担当県の候補者', election_name: 'テスト選挙', prefecture: '東京都' };
const otherCandidate = { id: 'other', candidate_code: 'other-1', name: '他県の候補者', election_name: '他県選挙', prefecture: '大阪府' };

// 外部DOMライブラリやCDNを実行せず、実際の画面スクリプトのDOM/API呼出を検査する。
class Element {
  constructor(tag, ownerDocument){
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.value = '';
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.classList = {
      add: value => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), value])].join(' '); },
      remove: value => { this.className = this.className.split(' ').filter(x => x !== value).join(' '); },
      contains: value => this.className.split(' ').includes(value)
    };
  }
  appendChild(child){ child.parentNode = this; this.children.push(child); return child; }
  append(...children){ children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children){ this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this._html = ''; this.append(...children); }
  remove(){ if(this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  set textContent(value){ this.replaceChildren(); this._text = String(value); }
  get textContent(){ return (this._text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value){ this.replaceChildren(); this._html = String(value); }
  get innerHTML(){ return this._html || ''; }
  addEventListener(type, handler){ this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  async click(){ for(const handler of this.listeners.get('click') || []) await handler({ preventDefault(){}, stopPropagation(){} }); }
}

function documentFor(html = ''){
  const doc = {};
  doc.createElement = tag => new Element(tag, doc);
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.body.className = 'auth-pending';
  function walk(node){ return [node, ...node.children.flatMap(walk)]; }
  const all = () => [...walk(doc.head), ...walk(doc.body)];
  doc.getElementById = id => all().find(node => node.id === id) || null;
  doc.querySelectorAll = selector => all().filter(node => selector.startsWith('.') && node.classList.contains(selector.slice(1)));
  doc.querySelector = selector => doc.querySelectorAll(selector)[0] || null;
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)){
    const node = doc.createElement(match[1]); node.id = match[2]; doc.body.appendChild(node);
  }
  if(html.includes('class="app-header"')){
    const header = doc.createElement('div'); header.className = 'app-header'; doc.body.appendChild(header);
  }
  return doc;
}

function browserContext(doc){
  const stored = new Map();
  const redirects = [];
  const location = { href: 'https://example.test/app/index.html', origin: 'https://example.test', pathname: '/app/index.html', search: '', replace: value => redirects.push(value), reload: () => redirects.push('reload') };
  return {
    document: doc, location, redirects, window: {}, URL, URLSearchParams,
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    history: { replaceState(){} }, navigator: { userAgent: 'Test browser' }, console: { log(){}, error(){} },
    confirm: () => true, alert(){}, ...scope
  };
}

function withoutImports(code){ return code.replace(/^import[^\n]+;\r?$/gm, ''); }

async function runAuth(account, doc = documentFor('<div class="app-header"></div>')){
  const context = browserContext(doc);
  const calls = [];
  context.SUPABASE_URL = 'https://supabase.test';
  context.SUPABASE_KEY = 'test-publishable';
  context.createClient = () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'fake-jwt' } } }), signOut: async () => ({ error: null }) } });
  context.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => account };
  };
  const code = withoutImports(await source('auth.js')).replace(/\bexport (function|async function|const) /g, '$1 ');
  const api = await new vm.Script(`(async()=>{${code}\nreturn {requirePageAccess,showAccountGate,loadAccount};})()`).runInNewContext(context);
  return { api, context, calls };
}

function fakeSupabase(candidates, progress = []){
  const queries = [];
  return {
    queries,
    from(table){
      const query = { table, filters: [], start: 0, end: Infinity };
      queries.push(query);
      const builder = {
        select(columns){ query.columns = columns; return builder; },
        eq(column, value){ query.filters.push([column, value]); return builder; },
        order(){ return builder; },
        range(start, end){ query.start = start; query.end = end; return builder; },
        then(resolve, reject){
          // 県RLSを意図的に模擬しない。他県が返る故障時にもUIが表示しないことを検査する。
          let rows = table === 'v3_candidates' ? candidates : progress;
          rows = rows.filter(row => query.filters.every(([column, value]) => row[column] === value));
          return Promise.resolve({ data: rows.slice(query.start, query.end + 1), error: null }).then(resolve, reject);
        }
      };
      return builder;
    }
  };
}

async function runPage(page, { user = tokyoAdmin, candidates = [], progress = [], usersApi, account, search = '' } = {}){
  const html = await source(page);
  const doc = documentFor(html);
  const context = browserContext(doc);
  context.location.search = search;
  const supabase = fakeSupabase(candidates, progress);
  const writes = [];
  const gates = [];
  Object.assign(context, {
    requirePageAccess: async () => user,
    getSupabase: () => supabase,
    syncApi: async body => { writes.push(body); return { ok: true, json: async () => ({ results: (body.candidates || [body]).map(row => ({ candidate_code: row.candidate_code, status: 'ok' })) }) }; },
    usersApi: usersApi || (async () => ({ users: [], next_cursor: null })),
    ROLE_LABELS: { admin: '管理者', viewer: '閲覧者' },
    loadAccount: async () => ({ account, message: '' }),
    startGoogleLogin: async () => {}, showAccountGate: value => gates.push(value),
    isInAppBrowser: () => false, takeLoginMessage: () => '', safeNextPage: () => 'list.html',
    mapStatusStage: value => value
  });
  const module = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const code = withoutImports(module).replace(/\binit\(\);\s*$/, 'await init();');
  await new vm.Script(`(async()=>{${code}\n})()`, { filename: page }).runInNewContext(context);
  return { doc, context, supabase, writes, gates };
}

test('47都道府県コードは既存配列と一致し、無効・非正規コードを拒否する', async () => {
  const legacy = vm.runInNewContext(`${await source('prefectures.js')}\nPREFECTURES`);
  assert.deepEqual(Array.from(legacy), Array.from(scope.PREFECTURE_NAMES));
  for(let index = 0; index < 47; index++) assert.equal(scope.prefectureNameForCode(String(index + 1).padStart(2, '0')), legacy[index]);
  for(const code of [null, undefined, 13, '1', '00', '48', '99', '13\n', '13 ', ' 13', '１３', '<script>']) assert.equal(scope.prefectureNameForCode(code), null);
});

test('県の比較は正式名とASCII空白のみ許可し、adminにも全国例外を作らない', () => {
  assert.equal(scope.candidateInScope({ prefecture: ' 東京都 ' }, tokyoAdmin), true);
  for(const prefecture of ['東京', '13', '大阪府', '\t東京都', '東京都\n', '\u00a0東京都', '東京都\u3000', null]) assert.equal(scope.candidateInScope({ prefecture }, tokyoAdmin), false);
  assert.equal(scope.candidateInScope(ownCandidate, { role: 'admin', prefecture_code: null }), false);
});

test('実auth: 担当県未設定のactive adminは業務画面を開かず、再確認とログアウトを表示', async () => {
  for(const prefecture_code of [null, undefined, '48', '13\n']){
    const { api, context } = await runAuth({ status: 'active', email: 'test@example.invalid', user: { ...tokyoAdmin, prefecture_code } });
    assert.equal(await api.requirePageAccess({ adminOnly: true }), null);
    assert.equal(context.document.body.classList.contains('gate-open'), true);
    assert.match(context.document.body.textContent, /担当する都道府県の設定をお待ちください。管理者にお問い合わせください/);
    assert.match(context.document.body.textContent, /設定されたか確認する/);
    assert.match(context.document.body.textContent, /ログアウト/);
    assert.equal(context.redirects.length, 0);
  }
});

test('実auth: 割当済み利用者は担当県を表示し、表示名をHTMLとして扱わない', async () => {
  const user = { ...tokyoAdmin, display_name: '<img src=x onerror=alert(1)>' };
  const { api, context } = await runAuth({ status: 'active', user });
  assert.equal((await api.requirePageAccess()).id, user.id);
  assert.equal(context.document.querySelector('.user-bar-prefecture').textContent, '担当：東京都');
  const name = context.document.querySelector('.user-bar-name');
  assert.equal(name.textContent, user.display_name);
  assert.equal(name.children.length, 0);
});

test('実index: activeでも県未割当は自動遷移せず、割当後だけ一覧へ遷移する', async () => {
  const waiting = await runPage('index.html', { account: { status: 'active', user: { ...tokyoAdmin, prefecture_code: null } } });
  assert.equal(waiting.context.redirects.length, 0);
  assert.equal(waiting.gates.length, 1);
  const ready = await runPage('index.html', { account: { status: 'active', user: tokyoAdmin } });
  assert.deepEqual(ready.context.redirects, ['list.html']);
});

test('実list: 他県を表示せず、担当県だけの固定選択肢にし、県の改変を送信しない', async () => {
  const page = await runPage('list.html', { candidates: [ownCandidate, otherCandidate] });
  assert.match(page.doc.getElementById('candidateList').innerHTML, /担当県の候補者/);
  assert.doesNotMatch(page.doc.getElementById('candidateList').innerHTML, /他県の候補者/);
  for(const id of ['prefectureFilter', 'editPrefecture']){
    const select = page.doc.getElementById(id);
    assert.equal(select.disabled, true);
    assert.equal(select.children.length, 1);
    assert.equal(select.value, '東京都');
  }
  page.context.window.openEditModal('other');
  await page.context.window.deleteCandidate('other');
  assert.equal(page.writes.length, 0);
  page.context.window.openEditModal('own');
  page.doc.getElementById('editPrefecture').value = '大阪府';
  await page.context.window.saveEdit();
  assert.equal(page.writes.length, 0);
  assert.match(page.doc.getElementById('editMessage').textContent, /担当する都道府県/);
  page.doc.getElementById('editPrefecture').value = '東京都';
  await page.context.window.saveEdit();
  assert.equal(page.writes[0].prefecture, '東京都');
});

test('実list: viewerから編集・削除関数を直接呼んでも送信しない', async () => {
  const page = await runPage('list.html', { user: { ...tokyoAdmin, role: 'viewer' }, candidates: [ownCandidate] });
  page.context.window.openEditModal('own');
  await page.context.window.saveEdit();
  await page.context.window.deleteCandidate('own');
  assert.equal(page.writes.length, 0);
});

test('実detail: URLの他県IDでは候補者も進捗も表示・追加取得しない', async () => {
  const page = await runPage('detail.html', { candidates: [otherCandidate], search: '?id=other' });
  assert.match(page.doc.getElementById('content').innerHTML, /候補者が見つかりません/);
  assert.doesNotMatch(page.doc.getElementById('content').innerHTML, /他県/);
  assert.equal(page.supabase.queries.filter(query => query.table === 'v3_progress').length, 0);
});

test('実detail: ASCII空白が残る担当県候補者は閲覧できる', async () => {
  const page = await runPage('detail.html', { candidates: [{ ...ownCandidate, prefecture: ' 東京都 ' }], search: '?id=own' });
  assert.match(page.doc.getElementById('content').innerHTML, /担当県の候補者/);
  assert.equal(page.supabase.queries.filter(query => query.table === 'v3_progress').length, 1);
});

test('実admin: 単体登録の県改変を拒否し、成功後も担当県を固定する', async () => {
  const page = await runPage('admin.html');
  for(const [id, value] of [['candidateCode','test-1'], ['candidateName','テスト'], ['electionName','テスト選挙']]) page.doc.getElementById(id).value = value;
  const select = page.doc.getElementById('prefecture');
  assert.equal(select.disabled, true);
  assert.equal(select.children.length, 1);
  select.value = '大阪府';
  await page.context.window.submitCandidate();
  assert.equal(page.writes.length, 0);
  assert.match(page.doc.getElementById('formMessage').textContent, /担当する都道府県/);
  select.value = '東京都';
  await page.context.window.submitCandidate();
  assert.equal(page.writes[0].prefecture, '東京都');
  assert.equal(select.value, '東京都');
});

test('実admin: 一括登録では担当県のみ送信し、他県・略称・Unicode空白行を除外', async () => {
  const page = await runPage('admin.html');
  page.doc.getElementById('bulkText').value = [
    'own-1\tテスト1\t選挙1\t 東京都 \t',
    'other-1\tテスト2\t選挙2\t大阪府\t',
    'short-1\tテスト3\t選挙3\t東京\t',
    'space-1\tテスト4\t選挙4\t\u00a0東京都\t'
  ].join('\n');
  await page.context.window.submitBulk();
  assert.equal(page.writes.length, 1);
  assert.equal(page.writes[0].candidates.length, 1);
  assert.equal(page.writes[0].candidates[0].prefecture, '東京都');
  assert.equal(page.writes[0].candidates[0].candidate_code, 'own-1');
  assert.match(page.doc.getElementById('bulkResult').innerHTML, /3件は形式エラー/);
});

test('実admin: 利用者一覧は全ページを取得し、他県の応答を表示しない', async () => {
  const calls = [];
  const usersApi = async (action, body) => {
    calls.push({ action, body });
    return body.cursor
      ? { users: [{ id: 'two', status: 'active', role: 'viewer', prefecture_code: '13', display_name: '2ページ目' }], next_cursor: null }
      : { users: [{ id: 'one', status: 'active', role: 'viewer', prefecture_code: '13', display_name: '1ページ目' }, { id: 'outside', status: 'active', role: 'viewer', prefecture_code: '27', display_name: '他県の利用者' }], next_cursor: 'next-id' };
  };
  const page = await runPage('admin.html', { usersApi });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.cursor, 'next-id');
  const text = page.doc.getElementById('usersList').textContent;
  assert.match(text, /1ページ目/);
  assert.match(text, /2ページ目/);
  assert.doesNotMatch(text, /他県の利用者/);
});

test('実admin: 同じ一覧cursorが繰り返されたら停止して取得失敗を表示する', async () => {
  let calls = 0;
  const page = await runPage('admin.html', { usersApi: async () => { calls++; return { users: [], next_cursor: 'same' }; } });
  assert.equal(calls, 2);
  assert.match(page.doc.getElementById('usersList').textContent, /利用者一覧の取得に失敗しました/);
});
