import { google } from "googleapis";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://hhlqgxmhbpfhjnjmradq.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// 候補者一覧のREST読み取り専用（RLSで読み取りがログインユーザーに限られるため）。
// 新形式のsecret key（sb_secret_）はJWTではないので apikey ヘッダーだけで送り、Edge Functionには送らない
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SYNC_URL = process.env.SYNC_URL || `${SUPABASE_URL}/functions/v1/v3-sync-progress`;
const SYNC_TOKEN = process.env.V3_SYNC_TOKEN;
// 複数行のJSONシークレットをそのまま登録するとGitHub Actionsのログマスクが
// { } を誤検知してログを潰すため、base64化した値を優先して受け付ける
const SERVICE_ACCOUNT_KEY_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
const SERVICE_ACCOUNT_KEY_JSON = SERVICE_ACCOUNT_KEY_B64
  ? Buffer.from(SERVICE_ACCOUNT_KEY_B64, "base64").toString("utf-8")
  : process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

const INFO_SHEET_NAME = "選挙情報・SNS情報ページ";
const LIST_SHEET_NAME = "広報物一覧・進捗確認ページ";
const CANDIDATE_ID_LABEL = "候補者ID";
const MODIFIED_TIME_CHECK_CONCURRENCY = 5;
const SYNC_REQUEST_TIMEOUT_MS = 30000;
const SYNC_REQUEST_RETRIES = 1;
const FAILURE_RATIO_THRESHOLD = 0.5;

// 公開Actionsログには固定の分類・HTTPステータス・件数だけを出す。
// 外部APIの例外やレスポンスには個人情報・URL・認証情報が含まれ得る。
class SyncError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function publicErrorSummary(error) {
  const code = error instanceof SyncError ? error.code : "EXTERNAL_ERROR";
  const status = error instanceof SyncError ? error.status : error?.response?.status;
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? `${code}（HTTP ${status}）`
    : code;
}

function requireEnv(value) {
  if (!value) {
    throw new SyncError("MISSING_ENVIRONMENT");
  }
  return value;
}

// 指数バックオフ付きのリトライ処理を行う共通関数
// 503/404などGoogle API側の一時的な不調を吸収するために使用する
async function withRetry(fn, retries = 3, initialDelayMs = 1000) {
  let delay = initialDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) {
        throw e;
      }
      console.log(`  リトライします（${attempt + 1}/${retries}）: ${publicErrorSummary(e)}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
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
  const byPeriod = Object.create(null);
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
    `${SUPABASE_URL}/rest/v1/v3_candidates?select=id,candidate_code,sheet_id,sheet_modified_at&sheet_id=not.is.null`,
    { headers: { apikey: SUPABASE_SECRET_KEY } }
  );
  if (!res.ok) {
    throw new SyncError("CANDIDATES_FETCH_FAILED", res.status);
  }
  const rows = await res.json();
  const candidates = rows.filter((c) => c.sheet_id && String(c.sheet_id).trim() !== "");
  // RLSなどで読めなくなった場合に、何もせず成功扱いになるのを防ぐ
  if (candidates.length === 0) {
    throw new SyncError("NO_CANDIDATES");
  }
  return candidates;
}

// 軽量にmodifiedTimeだけ取得する。取得失敗時はnullを返し、呼び出し側で
// フェイルセーフに「要同期」扱いにする（本読み込み側で本来のエラーが可視化される）
async function fetchModifiedTime(driveApi, sheetId) {
  try {
    const res = await withRetry(() =>
      driveApi.files.get({ fileId: sheetId, fields: "modifiedTime", supportsAllDrives: true })
    );
    return res.data.modifiedTime || null;
  } catch (e) {
    console.error(`  modifiedTime取得に失敗: ${publicErrorSummary(e)}`);
    return null;
  }
}

// 並列数を絞りつつ全候補者ぶんのmodifiedTimeを取得する
async function fetchModifiedTimes(driveApi, candidates) {
  const result = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      const modifiedTime = await fetchModifiedTime(driveApi, candidate.sheet_id);
      result.set(candidate.id, modifiedTime);
    }
  }

  const workers = Array.from({ length: Math.min(MODIFIED_TIME_CHECK_CONCURRENCY, candidates.length) }, worker);
  await Promise.all(workers);
  return result;
}

async function readSheetValues(sheetsApi, spreadsheetId, sheetName) {
  const res = await withRetry(() =>
    sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName,
    })
  );
  return res.data.values || [];
}

async function syncOneCandidate(sheetsApi, candidate, modifiedTime) {
  const infoRows = await readSheetValues(sheetsApi, candidate.sheet_id, INFO_SHEET_NAME);
  const listRows = await readSheetValues(sheetsApi, candidate.sheet_id, LIST_SHEET_NAME);

  const sheetCandidateCode = findLabelValue(infoRows, CANDIDATE_ID_LABEL);
  if (!sheetCandidateCode) {
    throw new SyncError("CANDIDATE_CODE_MISSING");
  }
  if (sheetCandidateCode !== candidate.candidate_code) {
    throw new SyncError("CANDIDATE_CODE_MISMATCH");
  }

  const items = collectItems(listRows);
  if (items.length === 0) {
    throw new SyncError("NO_PROGRESS_ITEMS");
  }

  const records = buildRecords(sheetCandidateCode, items);

  const bodyText = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(SYNC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        // fullSheet: シートの全 period を送っているので、シートから消えた見出しの行を掃除してよい
        body: JSON.stringify({ token: SYNC_TOKEN, records, modifiedTime, fullSheet: true }),
        signal: controller.signal,
      });

      const text = await res.text();
      // 一時的なエラー（Supabase Edge Functionの一時停止など）はリトライ対象とする
      const isTemporaryError = /UNAVAILABLE|DEGRADED/.test(text);
      if (res.status < 200 || res.status >= 300 || isTemporaryError) {
        throw new SyncError("SYNC_REQUEST_FAILED", res.status);
      }

      return text;
    } catch (e) {
      if (e.name === "AbortError") {
        throw new SyncError("SYNC_TIMEOUT");
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }, SYNC_REQUEST_RETRIES);

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new SyncError("INVALID_SYNC_RESPONSE");
  }

  logCleanup(body.cleanup);

  const errorResult = (body.results || []).find((r) => r.status === "error");
  if (errorResult) {
    throw new SyncError("SYNC_RESULT_ERROR");
  }
  if (Array.isArray(body.cleanup) && body.cleanup.some((result) => result?.error)) {
    throw new SyncError("SYNC_CLEANUP_FAILED");
  }

  return body;
}

// シートから消えた見出しの行の掃除結果をログに出す（削除・警告・エラーがあったときだけ）
function logCleanup(cleanup) {
  if (!Array.isArray(cleanup)) return;
  let deletedCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  for (const c of cleanup) {
    if (Array.isArray(c?.deleted)) deletedCount += c.deleted.length;
    if (c?.warning) warningCount++;
    if (c?.error) errorCount++;
  }
  if (deletedCount) console.log(`  見出しの掃除: ${deletedCount}件削除`);
  if (warningCount) console.warn(`  見出しの掃除（警告）: ${warningCount}件`);
  if (errorCount) console.error(`  見出しの掃除（エラー）: ${errorCount}件`);
}

async function main() {
  requireEnv(SUPABASE_KEY);
  requireEnv(SUPABASE_SECRET_KEY);
  requireEnv(SYNC_TOKEN);
  requireEnv(SERVICE_ACCOUNT_KEY_JSON);

  const credentials = JSON.parse(SERVICE_ACCOUNT_KEY_JSON);
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ],
  });
  const sheetsApi = google.sheets({ version: "v4", auth });
  const driveApi = google.drive({ version: "v3", auth });

  const candidates = await fetchCandidatesWithSheet();
  console.log(`対象候補者: ${candidates.length}件`);

  const modifiedTimes = await fetchModifiedTimes(driveApi, candidates);

  const toSync = [];
  let skippedCount = 0;
  for (const candidate of candidates) {
    const modifiedTime = modifiedTimes.get(candidate.id);
    // modifiedTime取得に失敗した場合はフェイルセーフに同期対象とする
    if (!modifiedTime) {
      toSync.push({ ...candidate, _fetchedModifiedTime: modifiedTime });
      continue;
    }

    const fetchedMs = Date.parse(modifiedTime);
    const storedMs = candidate.sheet_modified_at ? Date.parse(candidate.sheet_modified_at) : NaN;
    // sheet_modified_at未設定、またはDrive側が新しい場合のみ要同期とする
    const changed = Number.isNaN(storedMs) || fetchedMs > storedMs;
    if (changed) {
      toSync.push({ ...candidate, _fetchedModifiedTime: modifiedTime });
    } else {
      skippedCount++;
    }
  }
  console.log(`変更なし（スキップ）: ${skippedCount}件 / 要同期: ${toSync.length}件`);

  let successCount = 0;
  const failures = [];

  for (const [index, candidate] of toSync.entries()) {
    try {
      const modifiedTime = candidate._fetchedModifiedTime || (await fetchModifiedTime(driveApi, candidate.sheet_id));
      await syncOneCandidate(sheetsApi, candidate, modifiedTime);
      successCount++;
      console.log(`OK: 対象 ${index + 1}/${toSync.length}`);
    } catch (e) {
      const error = publicErrorSummary(e);
      failures.push({ position: index + 1, error });
      console.error(`NG: 対象 ${index + 1}/${toSync.length} - ${error}`);
    }
  }

  console.log("---");
  console.log(`成功: ${successCount}件 / 失敗: ${failures.length}件 / スキップ: ${skippedCount}件`);
  if (failures.length > 0) {
    console.log("失敗した処理（番号は今回の実行内のみ）:");
    failures.forEach((f) => console.log(`  - 対象 ${f.position}: ${f.error}`));
  }

  // 一過性の失敗でランが埋まらないよう、失敗率が閾値を超えた場合のみ全体を失敗扱いにする
  if (toSync.length > 0 && failures.length / toSync.length > FAILURE_RATIO_THRESHOLD) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`致命的エラー: ${publicErrorSummary(e)}`);
  process.exit(1);
});
