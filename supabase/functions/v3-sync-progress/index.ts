import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, withCors } from "../_shared/cors.ts";
import { getAuthContext, requireAdmin } from "../_shared/auth.ts";
import { type ExistingProgressRow, planOrphanCleanup } from "./cleanup.ts";

interface ProgressItem {
  item_name: string;
  required?: boolean;
  status: string;
}

interface SyncRecord {
  candidate_code: string;
  period: string;
  items: ProgressItem[];
}

interface CreateCandidateInput {
  candidate_code?: string;
  name?: string;
  election_name?: string;
  prefecture?: string;
  sheet_id?: string | null;
}

interface SyncRequestBody {
  token?: string;
  action?: "sync" | "createCandidate" | "deleteCandidate" | "updateCandidate";
  // sync / createCandidate (single)
  candidate_code?: string;
  period?: string;
  items?: ProgressItem[];
  records?: SyncRecord[];
  modifiedTime?: string;
  // true = records が候補者のシート全体（全 period）。このときだけ、records に無い period の行を掃除する
  fullSheet?: boolean;
  // createCandidate (single or bulk)
  name?: string;
  election_name?: string;
  prefecture?: string;
  sheet_id?: string | null;
  candidates?: CreateCandidateInput[];
  // deleteCandidate / updateCandidate
  id?: string;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const V3_SYNC_TOKEN = Deno.env.get("V3_SYNC_TOKEN");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// admin.html/list.htmlの誤操作で候補者シートにマスターシートのIDが
// 登録されるのを防ぐためのガード（クライアント側チェックのバイパス対策）
const MASTER_SHEET_ID = "1q4Vimnn6BHqxCpfcCcRsmvWCvC4J6jGP6avLoOu-mGk";
const SHEET_URL_PATTERN = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

function extractSheetId(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = String(input).trim();
  if (!trimmed) return "";
  const match = trimmed.match(SHEET_URL_PATTERN);
  return match ? match[1] : trimmed;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleCreateCandidate(body: SyncRequestBody) {
  const inputs: CreateCandidateInput[] = Array.isArray(body.candidates)
    ? body.candidates
    : [{
        candidate_code: body.candidate_code,
        name: body.name,
        election_name: body.election_name,
        prefecture: body.prefecture,
        sheet_id: body.sheet_id,
      }];

  const results: Array<{ candidate_code: string; status: string; error?: string; reason?: string }> = [];

  for (const input of inputs) {
    const candidateCode = input.candidate_code?.trim();
    const name = input.name?.trim();
    const electionName = input.election_name?.trim();
    const prefecture = input.prefecture?.trim();
    const sheetId = extractSheetId(input.sheet_id) || null;

    if (!candidateCode || !name || !electionName || !prefecture) {
      results.push({ candidate_code: candidateCode ?? "", status: "error", error: "必須項目が不足しています" });
      continue;
    }

    if (sheetId === MASTER_SHEET_ID) {
      results.push({
        candidate_code: candidateCode,
        status: "error",
        error: "マスターシートのIDです",
        reason: "master_sheet",
      });
      continue;
    }

    const { data: existing, error: existingError } = await supabase
      .from("v3_candidates")
      .select("id")
      .eq("candidate_code", candidateCode)
      .maybeSingle();

    if (existingError) {
      results.push({ candidate_code: candidateCode, status: "error", error: existingError.message });
      continue;
    }

    if (existing) {
      results.push({
        candidate_code: candidateCode,
        status: "error",
        error: "この候補者IDは既に登録されています",
        reason: "duplicate",
      });
      continue;
    }

    const { error: insertError } = await supabase
      .from("v3_candidates")
      .insert({
        candidate_code: candidateCode,
        name,
        election_name: electionName,
        prefecture,
        sheet_id: sheetId,
      });

    if (insertError) {
      results.push({ candidate_code: candidateCode, status: "error", error: insertError.message });
      continue;
    }

    results.push({ candidate_code: candidateCode, status: "ok" });
  }

  const hasError = results.some((r) => r.status === "error");
  return jsonResponse({ results }, hasError ? 207 : 200);
}

async function handleDeleteCandidate(body: SyncRequestBody) {
  const id = body.id;
  if (!id) {
    return jsonResponse({ error: "id is required" }, 400);
  }

  const { error: progressError } = await supabase
    .from("v3_progress")
    .delete()
    .eq("candidate_id", id);

  if (progressError) {
    return jsonResponse({ error: progressError.message }, 500);
  }

  const { error: candidateError } = await supabase
    .from("v3_candidates")
    .delete()
    .eq("id", id);

  if (candidateError) {
    return jsonResponse({ error: candidateError.message }, 500);
  }

  return jsonResponse({ status: "ok" }, 200);
}

async function handleUpdateCandidate(body: SyncRequestBody) {
  const id = body.id;
  if (!id) {
    return jsonResponse({ error: "id is required" }, 400);
  }

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.election_name !== undefined) update.election_name = body.election_name;
  if (body.prefecture !== undefined) update.prefecture = body.prefecture;
  if (body.sheet_id !== undefined) {
    const sheetId = extractSheetId(body.sheet_id) || null;
    if (sheetId === MASTER_SHEET_ID) {
      return jsonResponse({ error: "マスターシートのIDです" }, 400);
    }
    update.sheet_id = sheetId;
  }

  if (Object.keys(update).length === 0) {
    return jsonResponse({ error: "no fields to update" }, 400);
  }

  const { error } = await supabase
    .from("v3_candidates")
    .update(update)
    .eq("id", id);

  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  return jsonResponse({ status: "ok" }, 200);
}

// 画面からの候補者の登録・編集・削除。トークンではなく、ログイン中の利用者の JWT を照合し、
// v3_users で status=active かつ role=admin の人だけ許可する
const ADMIN_ACTIONS = ["createCandidate", "deleteCandidate", "updateCandidate"];

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  let body: SyncRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  const action = body.action ?? "sync";

  if (ADMIN_ACTIONS.includes(action)) {
    const admin = requireAdmin(await getAuthContext(supabase, req));
    if (!admin.ok) {
      return jsonResponse({ error: admin.error }, admin.status);
    }
  } else if (!V3_SYNC_TOKEN || body.token !== V3_SYNC_TOKEN) {
    // sync（action 省略時を含む）と未知の action は、今までどおりトークンで照合する
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (action === "createCandidate") {
    return await handleCreateCandidate(body);
  }

  if (action === "deleteCandidate") {
    return await handleDeleteCandidate(body);
  }

  if (action === "updateCandidate") {
    return await handleUpdateCandidate(body);
  }

  if (action !== "sync") {
    return jsonResponse({ error: `unknown action: ${action}` }, 400);
  }

  const records: SyncRecord[] = body.records ??
    (body.candidate_code && body.period && body.items
      ? [{ candidate_code: body.candidate_code, period: body.period, items: body.items }]
      : []);

  if (records.length === 0) {
    return jsonResponse({ error: "no records to sync" }, 400);
  }

  const results: Array<{ candidate_code: string; status: string; synced?: number; deleted?: number; changed?: boolean; error?: string }> = [];
  const candidateSyncOk = new Map<string, boolean>();
  // 見出しの掃除用：候補者コード → id と、受け取った period・項目数
  const candidateIdByCode = new Map<string, string>();
  const receivedByCode = new Map<string, { periods: Set<string>; itemCount: number }>();
  for (const record of records) {
    if (!record.candidate_code || !record.period || !Array.isArray(record.items)) continue;
    const received = receivedByCode.get(record.candidate_code) ?? { periods: new Set<string>(), itemCount: 0 };
    received.periods.add(record.period);
    received.itemCount += record.items.length;
    receivedByCode.set(record.candidate_code, received);
  }

  for (const record of records) {
    const { candidate_code, period, items } = record;

    if (!candidate_code || !period || !Array.isArray(items)) {
      results.push({ candidate_code: candidate_code ?? "", status: "error", error: "missing candidate_code, period, or items" });
      continue;
    }

    const { data: candidate, error: candidateError } = await supabase
      .from("v3_candidates")
      .select("id")
      .eq("candidate_code", candidate_code)
      .maybeSingle();

    if (candidateError) {
      results.push({ candidate_code, status: "error", error: candidateError.message });
      continue;
    }

    if (!candidate) {
      results.push({ candidate_code, status: "not_found" });
      continue;
    }
    candidateIdByCode.set(candidate_code, candidate.id);

    const itemNameSet = new Set(items.map((item) => item.item_name));

    const { data: existingRows, error: existingError } = await supabase
      .from("v3_progress")
      .select("item_name, required, status")
      .eq("candidate_id", candidate.id)
      .eq("period", period);

    if (existingError) {
      candidateSyncOk.set(candidate.id, false);
      results.push({ candidate_code, status: "error", error: existingError.message });
      continue;
    }

    const existingByName = new Map(
      (existingRows ?? []).map((row) => [row.item_name, { required: row.required, status: row.status }]),
    );

    const staleNames = (existingRows ?? [])
      .map((row) => row.item_name)
      .filter((name) => !itemNameSet.has(name));

    let hasChange = staleNames.length > 0;
    for (const item of items) {
      const newRequired = item.required ?? true;
      const existing = existingByName.get(item.item_name);
      if (!existing || existing.required !== newRequired || existing.status !== item.status) {
        hasChange = true;
      }
    }

    if (staleNames.length > 0) {
      const { error: deleteError } = await supabase
        .from("v3_progress")
        .delete()
        .eq("candidate_id", candidate.id)
        .eq("period", period)
        .in("item_name", staleNames);

      if (deleteError) {
        candidateSyncOk.set(candidate.id, false);
        results.push({ candidate_code, status: "error", error: deleteError.message });
        continue;
      }
    }

    let syncedCount = 0;
    if (items.length > 0) {
      const rows = items.map((item, index) => ({
        candidate_id: candidate.id,
        period,
        item_name: item.item_name,
        required: item.required ?? true,
        status: item.status,
        sort_order: index,
        updated_at: new Date().toISOString(),
      }));

      const { error: upsertError } = await supabase
        .from("v3_progress")
        .upsert(rows, { onConflict: "candidate_id,period,item_name" });

      if (upsertError) {
        candidateSyncOk.set(candidate.id, false);
        results.push({ candidate_code, status: "error", error: upsertError.message });
        continue;
      }
      syncedCount = rows.length;
    }

    if (hasChange) {
      const { error: touchError } = await supabase
        .from("v3_candidates")
        .update({ last_updated_at: new Date().toISOString() })
        .eq("id", candidate.id);

      if (touchError) {
        candidateSyncOk.set(candidate.id, false);
        results.push({ candidate_code, status: "error", error: touchError.message });
        continue;
      }
    }

    if (!candidateSyncOk.has(candidate.id)) {
      candidateSyncOk.set(candidate.id, true);
    }
    results.push({ candidate_code, status: "ok", synced: syncedCount, deleted: staleNames.length, changed: hasChange });
  }

  // シートから消えた見出し（period）の行の掃除。シート全体を受け取ったとき（fullSheet: true）だけ、
  // その候補者のすべての record の upsert が成功したあとに行う
  const cleanup: CleanupResult[] = [];
  if (body.fullSheet === true) {
    for (const [candidateCode, received] of receivedByCode) {
      const candidateId = candidateIdByCode.get(candidateCode);
      if (!candidateId) continue;
      if (candidateSyncOk.get(candidateId) !== true) {
        cleanup.push({ candidate_code: candidateCode, deleted: [], skipped: "同期に失敗した period があるため掃除しません" });
        continue;
      }
      const result = await cleanupOrphanPeriods(candidateCode, candidateId, received.periods, received.itemCount);
      if (result) cleanup.push(result);
    }
  }

  if (body.modifiedTime) {
    const idsToUpdate = [...candidateSyncOk.entries()]
      .filter(([, ok]) => ok)
      .map(([id]) => id);

    if (idsToUpdate.length > 0) {
      const { error: modifiedAtError } = await supabase
        .from("v3_candidates")
        .update({ sheet_modified_at: body.modifiedTime })
        .in("id", idsToUpdate);

      if (modifiedAtError) {
        console.error("sheet_modified_at update failed:", modifiedAtError.message);
      }
    }
  }

  const hasError = results.some((r) => r.status === "error");
  return jsonResponse(cleanup.length > 0 ? { results, cleanup } : { results }, hasError ? 207 : 200);
}

interface CleanupResult {
  candidate_code: string;
  deleted: Array<{ candidate_code: string; period: string; item_name: string; status: string | null }>;
  skipped?: string;
  warning?: string;
  error?: string;
}

// 1候補者分の掃除。何もすることが無ければ null
async function cleanupOrphanPeriods(
  candidateCode: string,
  candidateId: string,
  receivedPeriods: Set<string>,
  receivedItemCount: number,
): Promise<CleanupResult | null> {
  const { data: existingRows, error: existingError } = await supabase
    .from("v3_progress")
    .select("id, period, item_name, status")
    .eq("candidate_id", candidateId);
  if (existingError) {
    console.error(`[cleanup] ${candidateCode}: 現在の行の取得に失敗: ${existingError.message}`);
    return { candidate_code: candidateCode, deleted: [], error: existingError.message };
  }

  const plan = planOrphanCleanup((existingRows ?? []) as ExistingProgressRow[], receivedPeriods, receivedItemCount);
  if (plan.action === "none") return null;

  if (plan.action === "skip") {
    if (plan.warning) {
      const periods = [...new Set(plan.rows.map((r) => r.period))].join(", ");
      console.warn(`[cleanup] ${candidateCode}: ${plan.reason}（対象の見出し: ${periods}）`);
      return { candidate_code: candidateCode, deleted: [], warning: `${plan.reason}（対象の見出し: ${periods}）` };
    }
    return { candidate_code: candidateCode, deleted: [], skipped: plan.reason };
  }

  const { data: deletedRows, error: deleteError } = await supabase
    .from("v3_progress")
    .delete()
    .eq("candidate_id", candidateId)
    .in("id", plan.rows.map((r) => r.id))
    .select("period, item_name, status");
  if (deleteError) {
    console.error(`[cleanup] ${candidateCode}: 削除に失敗: ${deleteError.message}`);
    return { candidate_code: candidateCode, deleted: [], error: deleteError.message };
  }

  const deleted = (deletedRows ?? []).map((r) => ({
    candidate_code: candidateCode,
    period: r.period as string,
    item_name: r.item_name as string,
    status: r.status as string | null,
  }));
  console.log(`[cleanup] ${candidateCode}: シートから消えた見出しの行を ${deleted.length} 件削除: ${JSON.stringify(deleted)}`);

  if (deleted.length > 0) {
    const { error: touchError } = await supabase
      .from("v3_candidates")
      .update({ last_updated_at: new Date().toISOString() })
      .eq("id", candidateId);
    if (touchError) console.error(`[cleanup] ${candidateCode}: last_updated_at の更新に失敗: ${touchError.message}`);
  }
  return { candidate_code: candidateCode, deleted };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  return withCors(req, await handle(req));
});
