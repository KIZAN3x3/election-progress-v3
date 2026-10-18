import { createClient, type User } from "jsr:@supabase/supabase-js@2.117.3";
import { corsHeaders, withCors } from "../_shared/cors.ts";
import { getAuthContext, requireAdmin, V3_USER_COLUMNS, type V3User } from "../_shared/auth.ts";
import { callScopedRpc, isObject, isUuid } from "../_shared/scoped-rpc.ts";

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
// 管理操作はRPC内でも実行者と対象の現在の担当県を照合する。担当県の変更APIは設けない。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ROLES = ["admin", "viewer"] as const;
const ADMIN_ACTIONS = ["list", "approve", "disable", "enable", "set_role", "delete"];

interface RequestBody {
  action?: string;
  display_name?: unknown;
  target_id?: unknown;
  role?: unknown;
  cursor?: unknown;
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

function isRole(value: unknown): value is V3User["role"] {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
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
      status: "pending",
      role: "viewer",
      prefecture_code: null,
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

async function handleAdminAction(action: string, actor: V3User, body: RequestBody) {
  if (!ADMIN_ACTIONS.includes(action)) return jsonResponse({ error: "操作が正しくありません" }, 400);
  if (action !== "list" && !isUuid(body.target_id)) return jsonResponse({ error: "利用者IDが正しくありません" }, 400);
  if ((action === "approve" || action === "set_role") && !isRole(body.role)) {
    return jsonResponse({ error: "役割（admin / viewer）を指定してください" }, 400);
  }
  if (action === "list" && body.cursor != null && !isUuid(body.cursor)) {
    return jsonResponse({ error: "一覧の取得位置が正しくありません" }, 400);
  }
  const result = await callScopedRpc(supabase, "v3_manage_users", {
    p_actor_id: actor.id,
    p_action: action,
    p_target_id: action === "list" ? null : body.target_id,
    p_role: action === "approve" || action === "set_role" ? body.role : null,
    p_after_id: action === "list" ? body.cursor ?? null : null,
    p_limit: 200,
  });
  if (!result.ok) return jsonResponse({ error: result.error }, result.status);
  if (action === "list") {
    if (!Array.isArray(result.users) || (result.next_cursor != null && !isUuid(result.next_cursor))) {
      return jsonResponse({ error: "利用者一覧の取得に失敗しました" }, 500);
    }
    return jsonResponse({ users: result.users, next_cursor: result.next_cursor ?? null }, 200);
  }
  if (action !== "delete") return jsonResponse({ ok: true }, 200);

  // Only the ID returned by the scoped transaction may reach the privileged Auth API.
  if (!isUuid(result.deleted_user_id) || result.deleted_user_id.toLowerCase() !== (body.target_id as string).toLowerCase()) {
    return jsonResponse({ error: "削除結果の確認に失敗しました" }, 500);
  }
  try {
    const { error } = await supabase.auth.admin.deleteUser(result.deleted_user_id);
    if (!error) return jsonResponse({ ok: true, auth_deleted: true }, 200);
  } catch { /* Membership is already removed; keep the existing manual cleanup fallback. */ }
  return jsonResponse({
    ok: true,
    auth_deleted: false,
    warning: "利用者は削除しましたが、ログイン情報（auth.users）の削除に失敗しました。Supabase の Authentication 画面から削除してください",
  }, 200);
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  let body: RequestBody;
  try {
    const parsed = await req.json();
    if (!isObject(parsed)) return jsonResponse({ error: "invalid json body" }, 400);
    body = parsed as RequestBody;
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!["me", "register", "login", ...ADMIN_ACTIONS].includes(action)) {
    return jsonResponse({ error: "操作が正しくありません" }, 400);
  }

  const auth = await getAuthContext(supabase, req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (action === "me") return jsonResponse(accountResponse(auth.authUser, auth.appUser), 200);
  if (action === "register") return await handleRegister(auth.authUser, auth.appUser, body);
  if (action === "login") return await handleLogin(auth.appUser);

  const admin = requireAdmin(auth);
  if (!admin.ok) return jsonResponse({ error: admin.error }, admin.status);
  return await handleAdminAction(action, admin.actor, body);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  try {
    return withCors(req, await handle(req));
  } catch {
    console.error("v3-users request failed");
    return withCors(req, jsonResponse({ error: "internal error" }, 500));
  }
});
