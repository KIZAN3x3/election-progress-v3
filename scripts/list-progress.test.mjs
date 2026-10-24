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

async function fixture({ candidates, rows }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', value: '', style: {},
      appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
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
    window: {},
    document: { getElementById: element, createElement: () => ({}) },
    PREFECTURES: [],
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
  return { html: element('candidateList').innerHTML, queries };
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
