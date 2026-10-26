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
const row = (period, item_name = '合成項目', status = '未実施', required = true) =>
  ({ period, item_name, status, required });

async function fixture({ candidates = [candidate], progress = [], search = `?id=${id}`,
  candidateError = null, progressError = null, list = [{ id }], listError = null } = {}) {
  const content = { innerHTML: '<div class="loading">読み込み中...</div>' };
  const backLink = { href: 'list.html' };
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
        // 前後の候補者用の一覧取得（list.html と同じページング）
        range(from, to) {
          request.range = [from, to];
          queries.push(request);
          return Promise.resolve({ data: listError ? null : (from === 0 ? list : []), error: listError });
        },
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
    PREFECTURES: ['東京都', '愛知県'],
    document: { getElementById(elementId) {
      assert.ok(['content', 'backLink'].includes(elementId));
      return elementId === 'content' ? content : backLink;
    } },
    getSupabase: () => sdk,
    // Keep bootstrap closed so each test can await the actual render directly.
    requirePageAccess: async () => { accessChecks++; return null; },
    fetch: () => { throw new Error('Unexpected network request'); },
    console: { error: (...args) => logs.push(args) },
  });
  const api = await vm.runInContext(`(async () => {\n${statusSource}\n${detailSource}\nreturn { render };\n})()`,
    context, { timeout: 1000, filename: 'actual-detail-renderer.js' });
  return { content, backLink, queries, logs, api, accessChecks };
}

const periodTitles = html => [...html.matchAll(/<div class="period-title">([^<]*)<\/div>/g)].map(match => match[1]);

test('ordinary headings keep their existing order, item order and status badges', async () => {
  const f = await fixture({ progress: [
    row('追加B', '追加B項目', '未実施', false), row('選挙期間', '選挙項目', '納品済み'),
    row('政治活動期間', '政治項目1'), row('追加A', '追加A項目', '未実施', false),
    row('政治活動期間', '政治項目2', '原稿作成中'),
  ] });
  await f.api.render();
  const html = f.content.innerHTML;
  assert.deepEqual(periodTitles(html), ['政治活動期間', '選挙期間', '追加A', '追加B']);
  assert.ok(html.indexOf('政治項目1') < html.indexOf('政治項目2'));
  assert.match(html, /stage-badge stage-todo/);
  assert.match(html, /stage-badge stage-doing/);
  assert.match(html, /stage-badge stage-done/);
  assert.equal((html.match(/class="required-badge"/g) || []).length, 3);
  assert.equal((html.match(/stage-badge stage-unneeded/g) || []).length, 2);
  assert.match(html, /合成候補者/);
  assert.match(html, /合成選挙/);
});

const itemRows = html => [...html.matchAll(/<div class="item-row">([\s\S]*?)<\/div>\s*<\/div>/g)].map(match => match[1]);

test('required items show 必須 and their status; 不要 items show only a gray 不要 badge', async () => {
  const f = await fixture({ progress: [
    row('選挙期間', '必要項目', '未実施', true),
    row('選挙期間', '不要項目', '未実施', false),
    row('選挙期間', '不要だが進行中の項目', '原稿作成中', false),
  ] });
  await f.api.render();
  const [needed, unneeded, unneededWithStatus] = itemRows(f.content.innerHTML);
  assert.match(needed, /class="required-badge">必須</);
  assert.match(needed, /stage-badge stage-todo">未実施/);
  assert.doesNotMatch(needed, /stage-unneeded/);
  for (const item of [unneeded, unneededWithStatus]) {
    assert.match(item, /<div class="stage-badge stage-unneeded">不要/);
    assert.doesNotMatch(item, /required-badge|stage-todo|stage-doing|stage-done|未実施|原稿作成中/);
  }
});

test('the 不要 badge style is distinct from the 未着手・着手中・完了 colors', () => {
  const style = detailHtml.match(/\.stage-unneeded\{([^}]*)\}/)[1];
  for (const stageColor of ['var(--todo)', 'var(--doing)', 'var(--done)']) {
    assert.equal(style.includes(stageColor), false);
  }
  assert.match(style, /color:var\(--text3\)/);
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
  // 詳細の2件に加え、前後の候補者用の一覧取得（空のページが返るまでページング）
  assert.equal(f.queries.filter(q => !q.range).length, 2);
  assert.ok(f.queries.some(q => q.range));
  const [candidatesQuery, progressQuery] = f.queries.filter(q => !q.range);
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

// ---------- 一覧に戻る・前後の候補者 ----------

const ids = ['10000000-0000-4000-8000-00000000000a', id, '10000000-0000-4000-8000-00000000000c'];
const navLinks = html => [...html.matchAll(/<a class="nav-btn" href="([^"]*)">([^<]*)<\/a>/g)]
  .map(match => [match[2], match[1].replaceAll('&amp;', '&')]);
const disabledNav = html => [...html.matchAll(/<span class="nav-btn disabled" aria-disabled="true">([^<]*)<\/span>/g)]
  .map(match => match[1]);
const listQuery = f => f.queries.find(q => q.range);

test('back link returns to the filtered list URL passed from the list', async () => {
  const back = 'list.html?' + new URLSearchParams({ pref: '愛知県' });
  const f = await fixture({ search: '?' + new URLSearchParams({ id, back }) });
  assert.equal(f.backLink.href, back);
});

for (const back of ['https://example.com/list.html', '//example.com/list.html', 'javascript:alert(1)',
  'admin.html', 'list.html#x', 'xlist.html', '']) {
  test(`back value ${JSON.stringify(back)} falls back to list.html`, async () => {
    const f = await fixture({ search: '?' + new URLSearchParams({ id, back }) });
    assert.equal(f.backLink.href, 'list.html');
  });
}

test('direct visit without back keeps list.html and navigates the unfiltered list', async () => {
  const f = await fixture({ list: ids.map(id => ({ id })) });
  await f.api.render();
  assert.equal(f.backLink.href, 'list.html');
  const q = listQuery(f);
  assert.equal(q.table, 'v3_candidates');
  assert.equal(q.columns, 'id');
  assert.deepEqual(q.filters, []);
  assert.deepEqual(q.order.map(o => [o[0], o[1].ascending]), [['name', true], ['id', true]]);
  assert.deepEqual(navLinks(f.content.innerHTML), [
    ['← 前の候補者', `detail.html?id=${ids[0]}`],
    ['次の候補者 →', `detail.html?id=${ids[2]}`],
  ]);
  assert.match(f.content.innerHTML, /2 \/ 3/);
});

test('prev/next keep the list filter and pass the same back URL along', async () => {
  const back = 'list.html?' + new URLSearchParams({ pref: '愛知県' });
  const f = await fixture({ search: '?' + new URLSearchParams({ id, back }), list: ids.map(id => ({ id })) });
  await f.api.render();
  assert.deepEqual(listQuery(f).filters, [['prefecture', '愛知県']]);
  const links = navLinks(f.content.innerHTML);
  assert.equal(links.length, 2);
  for (const [, href] of links) assert.equal(new URLSearchParams(href.split('?')[1]).get('back'), back);
  assert.equal(new URLSearchParams(links[0][1].split('?')[1]).get('id'), ids[0]);
  assert.equal(new URLSearchParams(links[1][1].split('?')[1]).get('id'), ids[2]);
});

test('an unknown prefecture in back is not used as a filter', async () => {
  const back = 'list.html?' + new URLSearchParams({ pref: '架空県' });
  const f = await fixture({ search: '?' + new URLSearchParams({ id, back }) });
  await f.api.render();
  assert.deepEqual(listQuery(f).filters, []);
});

test('first and last candidates disable the button at that end', async () => {
  const first = await fixture({ list: [{ id }, { id: ids[2] }] });
  await first.api.render();
  assert.deepEqual(disabledNav(first.content.innerHTML), ['← 前の候補者']);
  assert.deepEqual(navLinks(first.content.innerHTML).map(link => link[0]), ['次の候補者 →']);

  const last = await fixture({ list: [{ id: ids[0] }, { id }] });
  await last.api.render();
  assert.deepEqual(disabledNav(last.content.innerHTML), ['次の候補者 →']);
});

test('candidate outside the list or a failed list read only disables navigation', async () => {
  const outside = await fixture({ list: [{ id: ids[0] }, { id: ids[2] }], progress: [row('選挙期間')] });
  await outside.api.render();
  assert.deepEqual(disabledNav(outside.content.innerHTML), ['← 前の候補者', '次の候補者 →']);
  assert.match(outside.content.innerHTML, /合成候補者/);

  const failed = await fixture({ listError: { message: 'synthetic list failure' }, progress: [row('選挙期間')] });
  await failed.api.render();
  assert.deepEqual(disabledNav(failed.content.innerHTML), ['← 前の候補者', '次の候補者 →']);
  assert.match(failed.content.innerHTML, /class="item-row"/);
  assert.equal(failed.logs.length, 1);
});
