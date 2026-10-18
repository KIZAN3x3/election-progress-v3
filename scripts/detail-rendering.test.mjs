import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual inline renderer and status mapping. All DOM, access and
// read-only SDK responses are synthetic; no SDK import, network or secrets.
const root = new URL('../', import.meta.url);
const detailHtml = readFileSync(new URL('detail.html', root), 'utf8');
const statusSource = readFileSync(new URL('status-map.js', root), 'utf8');
const detailSource = detailHtml.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import[^\n]+\r?\n/gm, '');
const id = '10000000-0000-4000-8000-000000000001';
const candidate = { id, name: '合成候補者', election_name: '合成選挙' };
const row = (period, item_name = '合成項目', status = '未実施', required = false) =>
  ({ period, item_name, status, required });

async function fixture({ candidates = [candidate], progress = [], search = `?id=${id}`,
  candidateError = null, progressError = null } = {}) {
  const content = { innerHTML: '<div class="loading">読み込み中...</div>' };
  const queries = [];
  const logs = [];
  let accessChecks = 0;
  const sdk = {
    from(table) {
      assert.ok(['v3_candidates', 'v3_progress'].includes(table));
      const request = { table, filters: [], order: [] };
      const builder = {
        select(columns) { request.columns = columns; return builder; },
        eq(column, value) { request.filters.push([column, value]); return builder; },
        order(column, options) { request.order.push([column, options]); return builder; },
        then(resolve, reject) {
          queries.push(request);
          return Promise.resolve(table === 'v3_candidates'
            ? { data: candidates, error: candidateError }
            : { data: progress, error: progressError }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const context = vm.createContext({
    URLSearchParams,
    location: { search },
    document: { getElementById(elementId) { assert.equal(elementId, 'content'); return content; } },
    getSupabase: () => sdk,
    // Keep bootstrap closed so each test can await the actual render directly.
    requirePageAccess: async () => { accessChecks++; return null; },
    fetch: () => { throw new Error('Unexpected network request'); },
    console: { error: (...args) => logs.push(args) },
  });
  const api = await vm.runInContext(`(async () => {\n${statusSource}\n${detailSource}\nreturn { render };\n})()`,
    context, { timeout: 1000, filename: 'actual-detail-renderer.js' });
  return { content, queries, logs, api, accessChecks };
}

const periodTitles = html => [...html.matchAll(/<div class="period-title">([^<]*)<\/div>/g)].map(match => match[1]);

test('ordinary headings keep their existing order, item order and status badges', async () => {
  const f = await fixture({ progress: [
    row('追加B', '追加B項目'), row('選挙期間', '選挙項目', '納品済み', true),
    row('政治活動期間', '政治項目1'), row('追加A', '追加A項目'),
    row('政治活動期間', '政治項目2', '原稿作成中'),
  ] });
  await f.api.render();
  const html = f.content.innerHTML;
  assert.deepEqual(periodTitles(html), ['政治活動期間', '選挙期間', '追加A', '追加B']);
  assert.ok(html.indexOf('政治項目1') < html.indexOf('政治項目2'));
  assert.match(html, /stage-badge stage-todo/);
  assert.match(html, /stage-badge stage-doing/);
  assert.match(html, /stage-badge stage-done/);
  assert.equal((html.match(/class="required-badge"/g) || []).length, 1);
  assert.match(html, /合成候補者/);
  assert.match(html, /合成選挙/);
});

for (const period of ['__proto__', 'constructor', 'toString']) {
  test(`a heading named ${period} renders as ordinary text`, async () => {
    const f = await fixture({ progress: [row(period, '合成項目1'), row(period, '合成項目2')] });
    await f.api.render();
    assert.deepEqual(periodTitles(f.content.innerHTML), [period]);
    assert.equal((f.content.innerHTML.match(/class="item-row"/g) || []).length, 2);
    assert.match(f.content.innerHTML, /合成項目1/);
    assert.match(f.content.innerHTML, /合成項目2/);
  });
}

test('prototype-named and regular headings coexist without losing any rows', async () => {
  const periods = ['constructor', '選挙期間', '__proto__', '政治活動期間', 'toString'];
  const f = await fixture({ progress: periods.map((period, index) => row(period, `項目${index}`)) });
  await f.api.render();
  const titles = periodTitles(f.content.innerHTML);
  assert.deepEqual(titles.slice(0, 2), ['政治活動期間', '選挙期間']);
  assert.deepEqual(new Set(titles), new Set(periods));
  assert.equal((f.content.innerHTML.match(/class="item-row"/g) || []).length, periods.length);
});

test('candidate and sheet-provided text remains HTML-escaped', async () => {
  const text = '<img src=x onerror="synthetic()">&\'合成';
  const escaped = '&lt;img src=x onerror=&quot;synthetic()&quot;&gt;&amp;&#39;合成';
  const f = await fixture({
    candidates: [{ id, name: text, election_name: text }],
    progress: [row(text, text, text)],
  });
  await f.api.render();
  assert.equal((f.content.innerHTML.match(/&lt;img/g) || []).length, 5);
  assert.equal(f.content.innerHTML.includes('<img'), false);
  assert.equal(f.content.innerHTML.split(escaped).length - 1, 5);
  assert.match(f.content.innerHTML, /stage-badge stage-doing/);
});

test('normal reads retain the candidate filters and progress ordering', async () => {
  const f = await fixture({ progress: [row('選挙期間')] });
  assert.equal(f.accessChecks, 1);
  assert.equal(f.queries.length, 0);
  await f.api.render();
  assert.equal(f.queries.length, 2);
  const [candidatesQuery, progressQuery] = f.queries;
  assert.equal(candidatesQuery.table, 'v3_candidates');
  assert.equal(candidatesQuery.columns, 'id,name,election_name');
  assert.deepEqual(candidatesQuery.filters, [['id', id]]);
  assert.equal(progressQuery.table, 'v3_progress');
  assert.equal(progressQuery.columns, 'item_name,period,required,status');
  assert.deepEqual(progressQuery.filters, [['candidate_id', id]]);
  assert.equal(progressQuery.order[0][0], 'sort_order');
  assert.equal(progressQuery.order[0][1].ascending, true);
  assert.equal(progressQuery.order[0][1].nullsFirst, false);
});

test('closed access gate does not request or render candidate data', async () => {
  const f = await fixture({ progress: [row('選挙期間')] });
  assert.equal(f.accessChecks, 1);
  assert.equal(f.queries.length, 0);
  assert.match(f.content.innerHTML, /読み込み中/);
  assert.equal(f.content.innerHTML.includes(candidate.name), false);
});

test('missing candidate ID does not query the SDK', async () => {
  const f = await fixture({ search: '' });
  await f.api.render();
  assert.equal(f.queries.length, 0);
  assert.match(f.content.innerHTML, /候補者idが指定されていません/);
});

test('missing candidate retains the existing empty state', async () => {
  const f = await fixture({ candidates: [] });
  await f.api.render();
  assert.match(f.content.innerHTML, /候補者が見つかりません/);
});

test('candidate with no progress retains its identity and empty state', async () => {
  const f = await fixture();
  await f.api.render();
  assert.match(f.content.innerHTML, /合成候補者/);
  assert.match(f.content.innerHTML, /進捗データがありません/);
});

for (const failure of ['candidateError', 'progressError']) {
  test(`${failure} retains the existing fixed read error state`, async () => {
    const f = await fixture({ [failure]: { message: 'synthetic read failure' } });
    await f.api.render();
    assert.match(f.content.innerHTML, /データの読み込みに失敗しました/);
    assert.equal(f.content.innerHTML.includes(candidate.name), false);
    assert.equal(f.logs.length, 1);
  });
}
