import { createClient, type User } from "jsr:@supabase/supabase-js@2.117.3";
import { corsHeaders, withCors } from "../_shared/cors.ts";
import { getAuthContext, requireAdmin, V3_USER_COLUMNS, type V3User } from "../_shared/auth.ts";
import { getBackendKey } from "../_shared/backend-key.ts";

// Googleログインの利用者（v3_users）に関する API。POST の body の action で分岐する。
//   me       : 自分の状態（unregistered / pending / active / disabled）
//   register : 初回登録（表示名。status='pending'、role='viewer'）
//   login    : 最終ログイン日時の記録（Googleから戻った直後に1回だけ呼ぶ）
//   以下は有効な管理者のみ
//   list     : 利用者一覧
//   approve  : 承認（target_id, role）。pending → active
//   disable  : 無効化（target_id）。pending / active → disabled
//   enable   : 再有効化（target_id）。disabled → active
//   set_role : 役割の変更（target_id, role）。active の人だけ
//   delete   : 削除（target_id）。v3_users → auth.users の順に削除
// どれも Authorization: Bearer <Supabaseのアクセストークン> が必要。
// 管理操作はDB内で現在の認可・管理者人数・更新を1つのトランザクションにする。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const supabase = createClient(SUPABASE_URL, getBackendKey(Deno.env.get), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ADMIN_ACTIONS = new Set(["list", "approve", "disable", "enable", "set_role", "delete"]);

interface RequestBody {
  action?: string;
  display_name?: unknown;
  target_id?: unknown;
  role?: unknown;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 前後の空白を除き、連続する空白を1つにそろえる。1〜50文字でなければ null
function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 50 ? name : null;
}

function googleName(authUser: User): string {
  const meta = authUser.user_metadata ?? {};
  return String(meta.full_name ?? meta.name ?? "");
}

function accountResponse(authUser: User, appUser: V3User | null) {
  return {
    status: appUser ? appUser.status : "unregistered",
    email: authUser.email ?? null,
    google_name: googleName(authUser),
    user: appUser,
  };
}

async function handleRegister(authUser: User, appUser: V3User | null, body: RequestBody) {
  if (appUser) {
    return jsonResponse({ error: "すでに登録されています" }, 409);
  }
  const displayName = normalizeDisplayName(body.display_name);
  if (!displayName) {
    return jsonResponse({ error: "表示名は1〜50文字で入力してください" }, 400);
  }

  const { data, error } = await supabase
    .from("v3_users")
    .insert({
      id: authUser.id,
      email: authUser.email ?? null,
      display_name: displayName,
      last_login_at: new Date().toISOString(),
    })
    .select(V3_USER_COLUMNS)
    .single();
  if (error) {
    // 23505 = 一意制約違反（同時に2回登録した場合）
    if (error.code === "23505") return jsonResponse({ error: "すでに登録されています" }, 409);
    return jsonResponse({ error: "登録に失敗しました。時間をおいて再度お試しください" }, 500);
  }
  return jsonResponse(accountResponse(authUser, data as V3User), 201);
}

async function handleLogin(appUser: V3User | null) {
  if (appUser) {
    const { error } = await supabase
      .from("v3_users")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", appUser.id);
    if (error) return jsonResponse({ error: "最終ログイン日時の記録に失敗しました" }, 500);
  }
  return jsonResponse({ ok: true }, 200);
}

interface AdminResult {
  ok: boolean;
  status?: number;
  error?: string;
  users?: V3User[];
  auth_deleted?: boolean;
  warning?: string;
}

async function handleAdminAction(action: string, actorId: string, body: RequestBody) {
  if (!ADMIN_ACTIONS.has(action)) return jsonResponse({ error: "unknown action" }, 400);
  if (action !== "list" && (typeof body.target_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.target_id))) {
    return jsonResponse({ error: "target_id を指定してください" }, 400);
  }
  const { data, error } = await supabase.rpc("v3_manage_users_atomic", {
    // This identity comes only from auth.getUser(token), never from the body.
    p_actor_id: actorId,
    p_action: action,
    p_target_id: action === "list" ? null : body.target_id,
    p_role: typeof body.role === "string" ? body.role : null,
  });
  if (error || !data || typeof data !== "object" || typeof data.ok !== "boolean") {
    return jsonResponse({ error: "利用者の管理に失敗しました。時間をおいて再度お試しください" }, 500);
  }
  const result = data as AdminResult;
  if (!result.ok) {
    const status = result.status;
    if (typeof status !== "number" || ![400, 403, 404, 409].includes(status) || typeof result.error !== "string") {
      return jsonResponse({ error: "利用者の管理に失敗しました。時間をおいて再度お試しください" }, 500);
    }
    return jsonResponse({ error: result.error }, status);
  }
  if (action === "list") {
    if (!Array.isArray(result.users)) return jsonResponse({ error: "利用者一覧の取得に失敗しました" }, 500);
    return jsonResponse({ users: result.users }, 200);
  }
  if (action === "delete") {
    if (typeof result.auth_deleted !== "boolean") return jsonResponse({ error: "削除に失敗しました" }, 500);
    return jsonResponse({ ok: true, auth_deleted: result.auth_deleted,
      ...(result.auth_deleted ? {} : { warning: result.warning }) }, 200);
  }
  return jsonResponse({ ok: true }, 200);
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";

  const auth = await getAuthContext(supabase, req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (action === "me") return jsonResponse(accountResponse(auth.authUser, auth.appUser), 200);
  if (action === "register") return await handleRegister(auth.authUser, auth.appUser, body);
  if (action === "login") return await handleLogin(auth.appUser);

  const admin = requireAdmin(auth);
  if (!admin.ok) return jsonResponse({ error: admin.error }, admin.status);
  return await handleAdminAction(action, auth.authUser.id, body);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  try {
    return withCors(req, await handle(req));
  } catch {
    console.error("v3-users internal error");
    return withCors(req, jsonResponse({ error: "internal error" }, 500));
  }
});
