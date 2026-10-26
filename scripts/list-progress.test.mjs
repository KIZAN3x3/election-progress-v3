import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// list.html のインラインスクリプトをそのまま実行し、進捗率の表示を確かめる。
// DOM・認証・SDKの応答はすべて架空のもので、ネットワークや秘密情報は使わない。
const root = new URL('../', import.meta.url);
const listHtml = readFileSync(new URL('list.html', root), 'utf8');
const statusSource = readFileSync(new URL('status-map.js', root), 'utf8');
const listSource = listHtml.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import[^\n]+\r?\n/gm, '');

const candidate = (id, name) => ({ id, candidate_code: `code-${id}`, name, election_name: '合成選挙',
  prefecture: '東京都', sheet_id: null, last_updated_at: null });
const progress = (candidate_id, required, status) => ({ candidate_id, required, status });

async function fixture({ candidates, rows, search = '', prefectures = [], stored = {}, scrollY = 0 }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', value: '', style: {}, listeners: {},
      appendChild() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  const storage = new Map(Object.entries(stored));
  const sessionStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const location = { search, href: `list.html${search}` };
  const replaced = [];
  const scrolls = [];
  const window = { scrollY, scrollTo: (x, y) => scrolls.push([x, y]), addEventListener() {} };
  const queries = [];
  const sdk = {
    from(table) {
      const request = { table };
      const builder = {
        select(columns) { request.columns = columns; return builder; },
        order() { return builder; },
        range(from) {
          queries.push(request);
          const data = table === 'v3_candidates' ? candidates : rows;
          return Promise.resolve({ data: from === 0 ? data : [], error: null });
        },
      };
      return builder;
    },
  };
  const context = vm.createContext({
    window,
    location,
    history: { state: null, replaceState: (state, title, url) => replaced.push(url) },
    sessionStorage,
    URLSearchParams,
    document: { getElementById: element, createElement: () => ({}) },
    PREFECTURES: prefectures,
    getSupabase: () => sdk,
    // 起動処理は止め、各テストで render を直接待つ
    requirePageAccess: async () => null,
    syncApi: () => { throw new Error('Unexpected API call'); },
    fetch: () => { throw new Error('Unexpected network request'); },
    console,
  });
  const api = await vm.runInContext(`(async () => {\n${statusSource}\n${listSource}\nreturn { render };\n})()`,
    context, { timeout: 1000, filename: 'actual-list-renderer.js' });
  await api.render();
  return { html: element('candidateList').innerHTML, queries, api, element, window, location, replaced, scrolls, storage };
}

// 候補者カードごとに [進捗率の表示, バーの幅] を取り出す
const rates = html => [...html.matchAll(/style="width:([^"]*)"><\/div><\/div>\s*<div class="rate-num">([^<]*)<\/div>/g)]
  .map(match => [match[2], match[1]]);

test('progress reads include the required column', async () => {
  const { queries } = await fixture({ candidates: [], rows: [] });
  const progressQuery = queries.find(q => q.table === 'v3_progress');
  assert.equal(progressQuery.columns, 'candidate_id,required,status');
});

test('only required items count toward both numerator and denominator', async () => {
  const { html } = await fixture({
    candidates: [candidate('a', '候補A')],
    rows: [
      progress('a', true, '納品済み'),
      progress('a', true, '未実施'),
      progress('a', true, '原稿作成中'),
      progress('a', true, '登録済み'),
      // 不要項目は未着手でも完了でも進捗率に影響しない
      progress('a', false, '未実施'),
      progress('a', false, '未実施'),
      progress('a', false, '納品済み'),
    ],
  });
  assert.deepEqual(rates(html), [['50%', '50%']]);
});

test('required, unneeded and blank-sheet cases (synced as true/false/true) compute as expected', async () => {
  const { html } = await fixture({
    candidates: [candidate('need', '必要のみ'), candidate('mixed', '混在')],
    rows: [
      progress('need', true, '納品済み'),
      progress('need', true, '納品済み'),
      // 「必要」と、空欄（同期でrequired=trueになる）の未着手、「不要」の未着手
      progress('mixed', true, '納品済み'),
      progress('mixed', true, '未実施'),
      progress('mixed', false, '未実施'),
    ],
  });
  assert.deepEqual(rates(html), [['100%', '100%'], ['50%', '50%']]);
});

test('candidates with no required items show - and an empty bar', async () => {
  const { html } = await fixture({
    candidates: [candidate('allUnneeded', '全部不要'), candidate('noRows', '進捗なし'), candidate('ok', '通常')],
    rows: [
      progress('allUnneeded', false, '納品済み'),
      progress('allUnneeded', false, '未実施'),
      progress('ok', true, '未実施'),
    ],
  });
  assert.deepEqual(rates(html), [['-', '0%'], ['-', '0%'], ['0%', '0%']]);
});

test('non-boolean required values are not counted as required', async () => {
  const { html } = await fixture({
    candidates: [candidate('a', '候補A')],
    rows: [progress('a', null, '未実施'), progress('a', 'true', '未実施'), progress('a', true, '納品済み')],
  });
  assert.deepEqual(rates(html), [['100%', '100%']]);
});

// ---------- 絞り込み条件の保持・スクロール位置 ----------

const PREFS = ['東京都', '愛知県'];
const cardNames = html => [...html.matchAll(/<div class="candidate-name">([^<]*)<\/div>/g)].map(match => match[1]);
const placed = (id, name, prefecture) => ({ ...candidate(id, name), prefecture });
const mixed = [placed('t', '東京の候補', '東京都'), placed('a', '愛知の候補', '愛知県')];

test('pref in the URL selects the filter and filters the first render', async () => {
  const f = await fixture({ candidates: mixed, rows: [], prefectures: PREFS,
    search: '?' + new URLSearchParams({ pref: '愛知県' }) });
  assert.equal(f.element('prefectureFilter').value, '愛知県');
  assert.deepEqual(cardNames(f.html), ['愛知の候補']);
  // 読み込み時は URL を書き換えない（Googleログインの ?code= を消さないため）
  assert.deepEqual(f.replaced, []);
});

test('unknown pref in the URL is ignored and all candidates are shown', async () => {
  const f = await fixture({ candidates: mixed, rows: [], prefectures: PREFS, search: '?pref=%E6%9E%B6%E7%A9%BA%E7%9C%8C' });
  assert.equal(f.element('prefectureFilter').value, '');
  assert.deepEqual(cardNames(f.html), ['東京の候補', '愛知の候補']);
});

test('changing the filter replaces the URL without adding history', async () => {
  const f = await fixture({ candidates: mixed, rows: [], prefectures: PREFS });
  const select = f.element('prefectureFilter');
  select.value = '東京都';
  select.listeners.change();
  select.value = '';
  select.listeners.change();
  assert.deepEqual(f.replaced, ['list.html?' + new URLSearchParams({ pref: '東京都' }), 'list.html']);
  assert.deepEqual(cardNames(f.element('candidateList').innerHTML), ['東京の候補', '愛知の候補']);
});

test('opening a candidate passes the filtered list URL and saves the scroll position', async () => {
  const f = await fixture({ candidates: mixed, rows: [], prefectures: PREFS, scrollY: 420,
    search: '?' + new URLSearchParams({ pref: '愛知県' }) });
  assert.match(f.html, /onclick="openDetail\('a'\)"/);
  f.window.openDetail('a');
  const back = 'list.html?' + new URLSearchParams({ pref: '愛知県' });
  assert.equal(f.location.href, 'detail.html?' + new URLSearchParams({ id: 'a', back }));
  assert.deepEqual(JSON.parse(f.storage.get('v3:listScroll')), { url: back, y: 420 });
  assert.equal(f.storage.has('v3_auth'), false);
});

test('scroll is restored once after the first render for the same list URL', async () => {
  const back = 'list.html?' + new URLSearchParams({ pref: '愛知県' });
  const f = await fixture({ candidates: mixed, rows: [], prefectures: PREFS, search: back.slice('list.html'.length),
    stored: { 'v3:listScroll': JSON.stringify({ url: back, y: 300 }) } });
  assert.deepEqual(f.scrolls, [[0, 300]]);
  assert.equal(f.storage.has('v3:listScroll'), false);
  // 編集・削除のあとの再描画では戻さない
  await f.api.render();
  assert.deepEqual(f.scrolls, [[0, 300]]);
});

test('saved scroll for a different filter is discarded without scrolling', async () => {
  const f = await fixture({ candidates: mixed, rows: [], prefectures: PREFS,
    stored: { 'v3:listScroll': JSON.stringify({ url: 'list.html?pref=x', y: 300 }) } });
  assert.deepEqual(f.scrolls, []);
  assert.equal(f.storage.has('v3:listScroll'), false);
});
