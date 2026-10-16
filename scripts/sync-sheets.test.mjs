import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = process.env.SYNC_SCRIPT_UNDER_TEST || fileURLToPath(new URL("./sync-sheets.mjs", import.meta.url));
const canary = "PRIVATE_CANARY_7cf568";

// 実際のエントリーポイントを別プロセスで実行する。Googleとfetchを置き換え、
// 架空データだけを使って正常系・異常系の公開ログと終了コードを確認する。
const fixtureData = `
export const canary = ${JSON.stringify(canary)};
export const scenario = process.env.SYNC_LOG_TEST_SCENARIO;
export const marker = (field) => canary + "_" + field;
export const count = scenario === "half-failed" ? 2 : scenario === "majority-failed" ? 3 : 1;
export const candidates = Array.from({ length: count }, (_, i) => ({
  id: marker("id_" + i), candidate_code: marker("code_" + i), name: marker("name_" + i),
  sheet_id: marker("sheet_" + i), sheet_modified_at: scenario === "skip" ? "2026-10-16T00:00:00Z" : null,
}));
export function externalError() {
  const error = new Error(marker("external_message"));
  error.code = marker("external_code");
  error.response = { status: scenario === "unsafe-status" ? marker("status") : 503, data: marker("response") };
  error.config = { url: marker("url"), headers: { Authorization: marker("credential") } };
  return error;
}
`;

const googleStub = `
import { candidates, marker, scenario, externalError } from "../../fixture-data.mjs";
export const google = {
  auth: { JWT: class { constructor() { if (scenario === "credential-error") throw externalError(); } } },
  drive: () => ({ files: { get: async () => {
    if (scenario === "drive-error") throw externalError();
    return { data: { modifiedTime: "2026-10-16T00:00:00Z" } };
  } } }),
  sheets: () => ({ spreadsheets: { values: { get: async ({ spreadsheetId, range }) => {
    if (scenario === "sheets-error" || scenario === "unsafe-status") throw externalError();
    const candidate = candidates.find((c) => c.sheet_id === spreadsheetId);
    if (!candidate) throw new Error("Unexpected fixture sheet");
    if (range === "選挙情報・SNS情報ページ") return { data: { values: [["候補者ID",
      scenario === "missing-code" ? "" : scenario === "mismatch" ? marker("wrong_code") : candidate.candidate_code,
    ]] } };
    if (range !== "広報物一覧・進捗確認ページ") throw new Error("Unexpected fixture range");
    return { data: { values: scenario === "no-items" ? [] : [
      ["", "【" + marker("period") + "】", "", ""],
      ["", marker("item"), "必要", marker("progress")],
    ] } };
  } } } }),
};
`;

const preload = `
import { appendFileSync } from "node:fs";
import { candidates, marker, scenario, externalError } from "./fixture-data.mjs";
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => originalSetTimeout(fn, delay === 30000 ? delay : 0, ...args);
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.origin !== "https://fixture.invalid") throw new Error("Network access blocked in test");
  appendFileSync(process.env.SYNC_LOG_TEST_TRACE, JSON.stringify({
    path: parsed.pathname, select: parsed.searchParams.get("select"),
    body: options.body ? JSON.parse(options.body) : null, headers: options.headers,
  }) + "\\n");
  if (parsed.pathname === "/rest/v1/v3_candidates") {
    if (scenario === "candidate-http-error") return new Response(marker("rest_error_body"), { status: 403 });
    if (scenario === "candidate-network-error") throw externalError();
    return Response.json(candidates);
  }
  if (parsed.pathname !== "/functions/v1/v3-sync-progress") throw new Error("Unexpected fixture endpoint");
  if (scenario === "sync-http-error") return new Response(marker("sync_error_body"), { status: 403 });
  if (scenario === "temporary-error") return new Response("UNAVAILABLE " + marker("temporary_body"));
  if (scenario === "invalid-json") return new Response(marker("invalid_json"));
  if (scenario === "timeout") throw new DOMException(marker("timeout"), "AbortError");
  const code = JSON.parse(options.body).records[0].candidate_code;
  const failed = scenario === "result-error" ||
    (scenario === "half-failed" && code === candidates[0].candidate_code) ||
    (scenario === "majority-failed" && code !== candidates[2].candidate_code);
  return Response.json({
    cleanup: [{ candidate_code: code, deleted: [{ period: marker("period"), item_name: marker("deleted_item"), status: marker("deleted_status") }],
      warning: marker("warning"), error: marker("cleanup_error") }],
    results: [{ status: failed ? "error" : "ok", candidate_code: code, error: marker("result_detail") }],
  });
};
`;

function runScenario(scenario) {
  const directory = mkdtempSync(join(tmpdir(), "election-sync-log-test-"));
  try {
    const googleDirectory = join(directory, "node_modules", "googleapis");
    mkdirSync(googleDirectory, { recursive: true });
    writeFileSync(join(googleDirectory, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
    writeFileSync(join(googleDirectory, "index.mjs"), googleStub);
    writeFileSync(join(directory, "fixture-data.mjs"), fixtureData);
    writeFileSync(join(directory, "preload.mjs"), preload);
    writeFileSync(join(directory, "sync-sheets.mjs"), readFileSync(scriptPath));
    const tracePath = join(directory, "requests.jsonl");
    // 親プロセスの資格情報を引き継がず、テスト専用の環境だけを渡す。
    const env = {
      PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", TEMP: tmpdir(), TMP: tmpdir(),
      SUPABASE_URL: "https://fixture.invalid", SYNC_URL: "https://fixture.invalid/functions/v1/v3-sync-progress",
      SUPABASE_KEY: canary + "_publishable", SUPABASE_SECRET_KEY: canary + "_secret", V3_SYNC_TOKEN: canary + "_token",
      GOOGLE_SERVICE_ACCOUNT_KEY: scenario === "invalid-credentials" ? canary + "_invalid_json" :
        JSON.stringify({ client_email: canary + "@example.invalid", private_key: canary + "_private_key" }),
      SYNC_LOG_TEST_SCENARIO: scenario, SYNC_LOG_TEST_TRACE: tracePath,
    };
    if (scenario === "missing-env") delete env.V3_SYNC_TOKEN;
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(join(directory, "preload.mjs")).href, join(directory, "sync-sheets.mjs")],
      { env, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "fixture process should finish normally");
    const requests = existsSync(tracePath) ? readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    return { ...result, requests, output: result.stdout + result.stderr };
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("election-sync-log-test-"));
    rmSync(target, { recursive: true, force: true });
  }
}

function assertPrivate(result) {
  assert.ok(!result.output.includes(canary), "stdout and stderr must not contain fixture personal data, response bodies, or credentials");
}

test("successful sync keeps payloads and counts while hiding personal data and cleanup details", () => {
  const result = runScenario("success");
  assertPrivate(result);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /成功: 1件 \/ 失敗: 0件 \/ スキップ: 0件/);
  assert.match(result.output, /見出しの掃除: 1件削除/);
  assert.match(result.output, /見出しの掃除（警告）: 1件/);
  assert.match(result.output, /見出しの掃除（エラー）: 1件/);
  const read = result.requests.find((r) => r.path === "/rest/v1/v3_candidates");
  assert.ok(read);
  assert.ok(!read.select.split(",").includes("name"), "names are no longer needed for synchronization");
  assert.deepEqual(read.headers, { apikey: canary + "_secret" });
  const write = result.requests.find((r) => r.path === "/functions/v1/v3-sync-progress");
  assert.ok(write);
  assert.equal(write.headers.Authorization, "Bearer " + canary + "_publishable");
  assert.equal(write.body.token, canary + "_token");
  assert.equal(write.body.fullSheet, true);
  assert.equal(write.body.modifiedTime, "2026-10-16T00:00:00Z");
  assert.deepEqual(write.body.records, [{ candidate_code: canary + "_code_0", period: canary + "_period",
    items: [{ item_name: canary + "_item", required: true, status: canary + "_progress" }] }]);
});

for (const [scenario, expected] of [
  ["sheets-error", "EXTERNAL_ERROR（HTTP 503）"], ["unsafe-status", "EXTERNAL_ERROR"],
  ["sync-http-error", "SYNC_REQUEST_FAILED（HTTP 403）"], ["temporary-error", "SYNC_REQUEST_FAILED（HTTP 200）"],
  ["invalid-json", "INVALID_SYNC_RESPONSE"], ["result-error", "SYNC_RESULT_ERROR"], ["timeout", "SYNC_TIMEOUT"],
  ["missing-code", "CANDIDATE_CODE_MISSING"], ["mismatch", "CANDIDATE_CODE_MISMATCH"], ["no-items", "NO_PROGRESS_ITEMS"],
]) {
  test(`${scenario} hides sensitive details and retains a safe failure category`, () => {
    const result = runScenario(scenario);
    assertPrivate(result);
    assert.equal(result.status, 1);
    assert.ok(result.output.includes(expected));
    assert.match(result.output, /成功: 0件 \/ 失敗: 1件 \/ スキップ: 0件/);
    if (scenario === "sync-http-error" || scenario === "temporary-error") {
      assert.equal(result.requests.filter((r) => r.path === "/functions/v1/v3-sync-progress").length, 2);
    }
  });
}

for (const [scenario, expected] of [
  ["candidate-http-error", "CANDIDATES_FETCH_FAILED（HTTP 403）"], ["candidate-network-error", "EXTERNAL_ERROR（HTTP 503）"],
  ["credential-error", "EXTERNAL_ERROR（HTTP 503）"], ["invalid-credentials", "EXTERNAL_ERROR"], ["missing-env", "MISSING_ENVIRONMENT"],
]) {
  test(`${scenario} hides fatal error objects and credentials`, () => {
    const result = runScenario(scenario);
    assertPrivate(result);
    assert.equal(result.status, 1);
    assert.ok(result.output.includes("致命的エラー: " + expected));
    assert.equal(result.requests.filter((r) => r.path === "/functions/v1/v3-sync-progress").length, 0);
  });
}

test("Drive failures stay private and still fall back to full synchronization", () => {
  const result = runScenario("drive-error");
  assertPrivate(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /modifiedTime取得に失敗: EXTERNAL_ERROR（HTTP 503）/);
  assert.match(result.output, /成功: 1件 \/ 失敗: 0件 \/ スキップ: 0件/);
});

test("unchanged sheets are skipped without a sync request", () => {
  const result = runScenario("skip");
  assertPrivate(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /成功: 0件 \/ 失敗: 0件 \/ スキップ: 1件/);
  assert.equal(result.requests.filter((r) => r.path === "/functions/v1/v3-sync-progress").length, 0);
});

for (const [scenario, exitCode, success, failures] of [["half-failed", 0, 1, 1], ["majority-failed", 1, 1, 2]]) {
  test(`${scenario} preserves the greater-than-50-percent failure threshold`, () => {
    const result = runScenario(scenario);
    assertPrivate(result);
    assert.equal(result.status, exitCode);
    assert.ok(result.output.includes(`成功: ${success}件 / 失敗: ${failures}件 / スキップ: 0件`));
  });
}
