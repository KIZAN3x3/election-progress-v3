import { google } from "googleapis";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://hhlqgxmhbpfhjnjmradq.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SYNC_URL = process.env.SYNC_URL || `${SUPABASE_URL}/functions/v1/v3-sync-progress`;
const SYNC_TOKEN = process.env.V3_SYNC_TOKEN;
const SERVICE_ACCOUNT_KEY_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

const INFO_SHEET_NAME = "選挙情報・SNS情報ページ";
const LIST_SHEET_NAME = "広報物一覧・進捗確認ページ";
const CANDIDATE_ID_LABEL = "候補者ID";

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

// GASのfindLabelValueと同じロジック：シート内でラベル文字列を探し、右隣のセルの値を返す
function findLabelValue(rows, label) {
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === label) {
        const raw = row[c + 1];
        return raw ? String(raw).trim() : "";
      }
    }
  }
  return "";
}

// GASのcollectItemsと同じロジック：期間見出し（【...】）で区切りながら項目を集める
function collectItems(rows) {
  const items = [];
  let currentPeriod = "";

  for (const row of rows) {
    const colB = row[1];
    const colC = row[2];
    const colD = row[3];

    if (typeof colB === "string" && colB.indexOf("【") === 0 && !colC && !colD) {
      currentPeriod = colB.replace(/[【】]/g, "");
      continue;
    }

    if (!colB || !currentPeriod) continue;
    if (colB === "広報物") continue;

    if (colC || colD) {
      items.push({
        period: currentPeriod,
        item_name: String(colB).trim(),
        required: String(colC).trim() === "必要",
        status: colD ? String(colD).trim() : "",
      });
    }
  }

  return items;
}

// GASのbuildRecordsと同じロジック：items配列をperiodごとにまとめる
function buildRecords(candidateCode, items) {
  const byPeriod = {};
  items.forEach((item) => {
    if (!byPeriod[item.period]) byPeriod[item.period] = [];
    byPeriod[item.period].push({
      item_name: item.item_name,
      required: item.required,
      status: item.status,
    });
  });

  return Object.keys(byPeriod).map((period) => ({
    candidate_code: candidateCode,
    period,
    items: byPeriod[period],
  }));
}

async function fetchCandidatesWithSheet() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/v3_candidates?select=id,candidate_code,name,sheet_id&sheet_id=not.is.null`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) {
    throw new Error(`候補者一覧の取得に失敗しました（${res.status}）: ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.filter((c) => c.sheet_id && String(c.sheet_id).trim() !== "");
}

async function readSheetValues(sheetsApi, spreadsheetId, sheetName) {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
  });
  return res.data.values || [];
}

async function syncOneCandidate(sheetsApi, candidate) {
  const infoRows = await readSheetValues(sheetsApi, candidate.sheet_id, INFO_SHEET_NAME);
  const listRows = await readSheetValues(sheetsApi, candidate.sheet_id, LIST_SHEET_NAME);

  const sheetCandidateCode = findLabelValue(infoRows, CANDIDATE_ID_LABEL);
  if (!sheetCandidateCode) {
    throw new Error("シート内に候補者IDが見つかりません");
  }
  if (sheetCandidateCode !== candidate.candidate_code) {
    throw new Error(
      `候補者IDが一致しません（DB: ${candidate.candidate_code} / シート: ${sheetCandidateCode}）。sheet_idの登録間違いの可能性があります`
    );
  }

  const items = collectItems(listRows);
  if (items.length === 0) {
    throw new Error("反映する項目が見つかりませんでした");
  }

  const records = buildRecords(sheetCandidateCode, items);

  const res = await fetch(SYNC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ token: SYNC_TOKEN, records }),
  });

  const bodyText = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`同期リクエストが失敗しました（${res.status}）: ${bodyText}`);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`同期レスポンスの解析に失敗しました: ${bodyText}`);
  }

  const errorResult = (body.results || []).find((r) => r.status === "error");
  if (errorResult) {
    throw new Error(`同期処理でエラーが返されました: ${JSON.stringify(errorResult)}`);
  }

  return body;
}

async function main() {
  requireEnv("SUPABASE_KEY", SUPABASE_KEY);
  requireEnv("V3_SYNC_TOKEN", SYNC_TOKEN);
  requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY", SERVICE_ACCOUNT_KEY_JSON);

  const credentials = JSON.parse(SERVICE_ACCOUNT_KEY_JSON);
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheetsApi = google.sheets({ version: "v4", auth });

  const candidates = await fetchCandidatesWithSheet();
  console.log(`対象候補者: ${candidates.length}件`);

  let successCount = 0;
  const failures = [];

  for (const candidate of candidates) {
    try {
      await syncOneCandidate(sheetsApi, candidate);
      successCount++;
      console.log(`OK: ${candidate.candidate_code}（${candidate.name}）`);
    } catch (e) {
      failures.push({ candidate_code: candidate.candidate_code, name: candidate.name, error: e.message });
      console.error(`NG: ${candidate.candidate_code}（${candidate.name}） - ${e.message}`);
    }
  }

  console.log("---");
  console.log(`成功: ${successCount}件 / 失敗: ${failures.length}件`);
  if (failures.length > 0) {
    console.log("失敗した候補者:");
    failures.forEach((f) => console.log(`  - ${f.candidate_code}（${f.name}）: ${f.error}`));
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
