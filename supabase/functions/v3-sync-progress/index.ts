import { createClient } from "jsr:@supabase/supabase-js@2";

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
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
    const sheetId = input.sheet_id || null;

    if (!candidateCode || !name || !electionName || !prefecture) {
      results.push({ candidate_code: candidateCode ?? "", status: "error", error: "必須項目が不足しています" });
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
  if (body.sheet_id !== undefined) update.sheet_id = body.sheet_id;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  let body: SyncRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  if (!V3_SYNC_TOKEN || body.token !== V3_SYNC_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const action = body.action ?? "sync";

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
  return jsonResponse({ results }, hasError ? 207 : 200);
});
