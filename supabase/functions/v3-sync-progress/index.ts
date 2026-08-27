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

interface SyncRequestBody {
  token?: string;
  candidate_code?: string;
  period?: string;
  items?: ProgressItem[];
  records?: SyncRecord[];
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const V3_SYNC_TOKEN = Deno.env.get("V3_SYNC_TOKEN");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
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

  const records: SyncRecord[] = body.records ??
    (body.candidate_code && body.period && body.items
      ? [{ candidate_code: body.candidate_code, period: body.period, items: body.items }]
      : []);

  if (records.length === 0) {
    return jsonResponse({ error: "no records to sync" }, 400);
  }

  const results: Array<{ candidate_code: string; status: string; synced?: number; deleted?: number; changed?: boolean; error?: string }> = [];

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
        results.push({ candidate_code, status: "error", error: touchError.message });
        continue;
      }
    }

    results.push({ candidate_code, status: "ok", synced: syncedCount, deleted: staleNames.length, changed: hasChange });
  }

  const hasError = results.some((r) => r.status === "error");
  return jsonResponse({ results }, hasError ? 207 : 200);
});
