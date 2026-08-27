/**
 * 候補者シート（LOCAL_TEMPLATE_ID / NATIONAL_TEMPLATE_ID の
 * コピー先スプレッドシート）に紐づくApps Scriptプロジェクトに
 * 追加するコード。
 *
 * 編集をトリガーに、そのシート自身の進捗データを直接
 * v3-sync-progress Edge Functionへプッシュする（リアルタイム同期）。
 * 既存のGitHub Actions（15分間隔のプル型）は保険として残す前提。
 *
 * ここで定義する識別子はすべて RT_ / rt 接頭辞・接尾辞の _ 付きに
 * しています。このシートには既に「広報物進捗」メニューの
 * onOpen() や、手動反映用の findLabelValue / collectItems /
 * buildRecords 等が存在するはずなので、名前の衝突を避けるためです。
 *
 * ▼ 導入手順（この1ファイルをそのまま貼り付ける前提）
 * 1. 拡張機能 → Apps Script を開き、新しいスクリプトファイルとして
 *    このコードを貼り付ける
 * 2. 「プロジェクトの設定」→「スクリプト プロパティ」で
 *    V3_SYNC_TOKEN に GitHub Secrets の V3_SYNC_TOKEN と同じ値を登録する
 * 3. 既存の onOpen() 関数の中に、以下の1行を追加する
 *      .addItem('① 同期を有効化', 'setupRealtimeSync')
 *    （onOpen()がまだ無い場合は、このファイル末尾のフォールバックを
 *      参照。ただし1プロジェクトに onOpen は1つしか定義できないため、
 *      既存の onOpen がある場合はそちらを編集すること）
 * 4. スプレッドシートを再読み込みし、追加したメニューから
 *    「① 同期を有効化」をクリック（初回のみ承認ダイアログが出る）
 */

const RT_SUPABASE_URL = 'https://hhlqgxmhbpfhjnjmradq.supabase.co';
const RT_SYNC_URL = RT_SUPABASE_URL + '/functions/v1/v3-sync-progress';
const RT_SUPABASE_KEY = 'sb_publishable_UnDHy2FKZHZkUTiSAR8isg_V8B3w4Eb';

const RT_INFO_SHEET_NAME = '選挙情報・SNS情報ページ';
const RT_LIST_SHEET_NAME = '広報物一覧・進捗確認ページ';
const RT_CANDIDATE_ID_LABEL = '候補者ID';

// scripts/sync-sheets.mjs の findLabelValue と同じロジック
function rtFindLabelValue_(rows, label) {
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    for (var c = 0; c < row.length; c++) {
      if (row[c] === label) {
        var raw = row[c + 1];
        return raw ? String(raw).trim() : '';
      }
    }
  }
  return '';
}

// scripts/sync-sheets.mjs の collectItems と同じロジック
function rtCollectItems_(rows) {
  var items = [];
  var currentPeriod = '';

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var colB = row[1];
    var colC = row[2];
    var colD = row[3];

    if (typeof colB === 'string' && colB.indexOf('【') === 0 && !colC && !colD) {
      currentPeriod = colB.replace(/[【】]/g, '');
      continue;
    }

    if (!colB || !currentPeriod) continue;
    if (colB === '広報物') continue;

    if (colC || colD) {
      items.push({
        period: currentPeriod,
        item_name: String(colB).trim(),
        required: String(colC).trim() === '必要',
        status: colD ? String(colD).trim() : ''
      });
    }
  }

  return items;
}

// scripts/sync-sheets.mjs の buildRecords と同じロジック
function rtBuildRecords_(candidateCode, items) {
  var byPeriod = {};
  items.forEach(function (item) {
    if (!byPeriod[item.period]) byPeriod[item.period] = [];
    byPeriod[item.period].push({
      item_name: item.item_name,
      required: item.required,
      status: item.status
    });
  });

  return Object.keys(byPeriod).map(function (period) {
    return {
      candidate_code: candidateCode,
      period: period,
      items: byPeriod[period]
    };
  });
}

function rtGetSyncToken_() {
  return PropertiesService.getScriptProperties().getProperty('V3_SYNC_TOKEN');
}

// 現在のシート内容を組み立てて v3-sync-progress へPOSTする
function pushProgressToSupabaseRealtime_() {
  var token = rtGetSyncToken_();
  if (!token) {
    Logger.log('リアルタイム同期エラー: スクリプトプロパティ V3_SYNC_TOKEN が未設定です');
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var infoSheet = ss.getSheetByName(RT_INFO_SHEET_NAME);
  var listSheet = ss.getSheetByName(RT_LIST_SHEET_NAME);
  if (!infoSheet || !listSheet) {
    Logger.log('リアルタイム同期エラー: シート「' + RT_INFO_SHEET_NAME + '」または「' + RT_LIST_SHEET_NAME + '」が見つかりません');
    return;
  }

  var candidateCode = rtFindLabelValue_(infoSheet.getDataRange().getValues(), RT_CANDIDATE_ID_LABEL);
  if (!candidateCode) {
    Logger.log('リアルタイム同期エラー: シート内に候補者IDが見つかりません');
    return;
  }

  var items = rtCollectItems_(listSheet.getDataRange().getValues());
  if (items.length === 0) {
    Logger.log('リアルタイム同期: 反映する項目が見つかりませんでした（候補者ID: ' + candidateCode + '）');
    return;
  }

  var records = rtBuildRecords_(candidateCode, items);

  var options = {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: {
      Authorization: 'Bearer ' + RT_SUPABASE_KEY
    },
    payload: JSON.stringify({ token: token, records: records }),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(RT_SYNC_URL, options);
    var statusCode = response.getResponseCode();
    if (statusCode >= 200 && statusCode < 300) {
      Logger.log('リアルタイム同期 成功（候補者ID: ' + candidateCode + ', status ' + statusCode + '）');
    } else {
      Logger.log('リアルタイム同期 失敗（候補者ID: ' + candidateCode + ', status ' + statusCode + '）: ' + response.getContentText());
    }
  } catch (err) {
    Logger.log('リアルタイム同期 例外発生（候補者ID: ' + candidateCode + '）: ' + err.message);
  }
}

// インストール型onEditトリガーのハンドラ
// 対象シート（選挙情報・SNS情報ページ / 広報物一覧・進捗確認ページ）の編集時のみ反映する
function onEditRealtimeSync(e) {
  try {
    var sheet = e && e.range ? e.range.getSheet() : null;
    var sheetName = sheet ? sheet.getName() : '';
    if (sheetName !== RT_INFO_SHEET_NAME && sheetName !== RT_LIST_SHEET_NAME) return;

    pushProgressToSupabaseRealtime_();
  } catch (err) {
    Logger.log('onEditRealtimeSyncで例外発生: ' + err.message);
  }
}

// メニューの「① 同期を有効化」から呼ぶセットアップ関数
// 初回実行時にOAuth承認ダイアログが表示される
function setupRealtimeSync() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'onEditRealtimeSync') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('onEditRealtimeSync')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  SpreadsheetApp.getUi().alert('① 同期を有効化しました。以降、シート編集時に自動でSupabaseへ反映されます。');
}

/**
 * フォールバック: このシートにまだ onOpen() が無い場合のみ使う。
 * 既に「広報物進捗」メニュー等を作る onOpen() がある場合は、
 * この関数は使わず、既存の onOpen() の中に
 *   .addItem('① 同期を有効化', 'setupRealtimeSync')
 * を1行追加すること（1プロジェクトに onOpen は1つしか置けない）。
 */
function onOpen_RealtimeSyncFallbackOnly() {
  SpreadsheetApp.getUi()
    .createMenu('リアルタイム同期')
    .addItem('① 同期を有効化', 'setupRealtimeSync')
    .addToUi();
}
