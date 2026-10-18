import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.117.3";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export type ScopedRpcResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; status: number; error: string };

// The RPC rechecks current membership and scope in the same transaction as the operation.
// Never expose PostgREST exception messages, SQL details, or an unexpected response body.
export async function callScopedRpc(
  supabase: SupabaseClient,
  name: "v3_manage_candidate" | "v3_manage_users",
  args: Record<string, unknown>,
): Promise<ScopedRpcResult> {
  const failed: ScopedRpcResult = { ok: false, status: 500, error: "処理に失敗しました。時間をおいて再度お試しください" };
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error || !isObject(data)) return failed;
    if (data.ok === true) return data as { ok: true } & Record<string, unknown>;
    if (data.ok === false && [400, 403, 404, 409].includes(data.status as number) && typeof data.error === "string") {
      return { ok: false, status: data.status as number, error: data.error };
    }
    return failed;
  } catch {
    return failed;
  }
}
