import { createClient, type User } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, withCors } from "../_shared/cors.ts";
import { getAuthContext, requireAdmin, V3_USER_COLUMNS, type V3User } from "../_shared/auth.ts";

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
// 更新は「判定に使った status・role」を条件に入れ、判定のあとで変わっていたら 409 を返す。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ROLES = ["admin", "viewer"] as const;
const CONFLICT_MESSAGE = "ほかの管理者が先に変更しました。一覧を読み直してください";

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

async function handleList() {
  const { data, error } = await supabase
    .from("v3_users")
    .select(V3_USER_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) return jsonResponse({ error: "利用者一覧の取得に失敗しました" }, 500);
  return jsonResponse({ users: data ?? [] }, 200);
}

async function loadTarget(targetId: unknown): Promise<V3User | Response> {
  if (typeof targetId !== "string" || !targetId) {
    return jsonResponse({ error: "target_id を指定してください" }, 400);
  }
  const { data, error } = await supabase
    .from("v3_users")
    .select(V3_USER_COLUMNS)
    .eq("id", targetId)
    .maybeSingle();
  if (error) return jsonResponse({ error: "利用者の取得に失敗しました" }, 500);
  if (!data) return jsonResponse({ error: "利用者が見つかりません" }, 404);
  return data as V3User;
}

// 対象が有効な管理者のとき、ほかに有効な管理者が1人もいなければエラーを返す（最後の1人を無効化・降格・削除させない）
async function guardLastAdmin(target: V3User, message: string): Promise<Response | null> {
  if (target.status !== "active" || target.role !== "admin") return null;
  const { count, error } = await supabase
    .from("v3_users")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("role", "admin")
    .neq("id", target.id);
  if (error) return jsonResponse({ error: "管理者の人数の確認に失敗しました" }, 500);
  if (!count) return jsonResponse({ error: message }, 400);
  return null;
}

// 判定に使った status・role を条件に入れて更新する。0行なら判定のあとで変わったので 409
async function updateIfUnchanged(target: V3User, updates: Partial<V3User>) {
  const { data, error } = await supabase
    .from("v3_users")
    .update(updates)
    .eq("id", target.id)
    .eq("status", target.status)
    .eq("role", target.role)
    .select("id");
  if (error) return jsonResponse({ error: "更新に失敗しました" }, 500);
  if (!data || data.length === 0) return jsonResponse({ error: CONFLICT_MESSAGE }, 409);
  return jsonResponse({ ok: true }, 200);
}

async function handleAdminAction(action: string, actor: V3User, body: RequestBody) {
  if (action === "list") return await handleList();

  const target = await loadTarget(body.target_id);
  if (target instanceof Response) return target;
  const isSelf = target.id === actor.id;

  if (action === "approve") {
    if (!isRole(body.role)) return jsonResponse({ error: "役割（admin / viewer）を指定してください" }, 400);
    if (target.status !== "pending") return jsonResponse({ error: CONFLICT_MESSAGE }, 409);
    return await updateIfUnchanged(target, {
      status: "active",
      role: body.role,
      approved_at: new Date().toISOString(),
      approved_by: actor.id,
    });
  }

  if (action === "disable") {
    if (isSelf) return jsonResponse({ error: "自分自身は無効化できません" }, 400);
    if (target.status === "disabled") return jsonResponse({ error: CONFLICT_MESSAGE }, 409);
    const guard = await guardLastAdmin(target, "最後の管理者は無効化できません");
    if (guard) return guard;
    return await updateIfUnchanged(target, { status: "disabled" });
  }

  if (action === "enable") {
    if (target.status !== "disabled") return jsonResponse({ error: CONFLICT_MESSAGE }, 409);
    const updates: Partial<V3User> = { status: "active" };
    // 承認前に無効化された人は、ここで承認したことにする
    if (!target.approved_at) {
      updates.approved_at = new Date().toISOString();
      updates.approved_by = actor.id;
    }
    return await updateIfUnchanged(target, updates);
  }

  if (action === "set_role") {
    if (!isRole(body.role)) return jsonResponse({ error: "役割（admin / viewer）を指定してください" }, 400);
    if (isSelf) return jsonResponse({ error: "自分自身の役割は変更できません" }, 400);
    if (target.status !== "active") return jsonResponse({ error: CONFLICT_MESSAGE }, 409);
    if (target.role === body.role) return jsonResponse({ error: "すでにその役割です" }, 400);
    if (body.role === "viewer") {
      const guard = await guardLastAdmin(target, "最後の管理者は降格できません");
      if (guard) return guard;
    }
    return await updateIfUnchanged(target, { role: body.role });
  }

  if (action === "delete") {
    if (isSelf) return jsonResponse({ error: "自分自身は削除できません" }, 400);
    const guard = await guardLastAdmin(target, "最後の管理者は削除できません");
    if (guard) return guard;

    const { data, error } = await supabase
      .from("v3_users")
      .delete()
      .eq("id", target.id)
      .eq("status", target.status)
      .eq("role", target.role)
      .select("id");
    if (error) return jsonResponse({ error: "削除に失敗しました" }, 500);
    if (!data || data.length === 0) return jsonResponse({ error: CONFLICT_MESSAGE }, 409);

    const { error: authError } = await supabase.auth.admin.deleteUser(target.id);
    if (authError) {
      // v3_users は消えているので、次にログインすると登録画面に戻る。Googleのログイン情報は Authentication 画面から削除する
      return jsonResponse({
        ok: true,
        auth_deleted: false,
        warning: "利用者は削除しましたが、ログイン情報（auth.users）の削除に失敗しました。Supabase の Authentication 画面から削除してください",
      }, 200);
    }
    return jsonResponse({ ok: true, auth_deleted: true }, 200);
  }

  return jsonResponse({ error: `unknown action: ${action}` }, 400);
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
  const action = typeof body.action === "string" ? body.action : "";

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
  } catch (e) {
    console.error(e);
    return withCors(req, jsonResponse({ error: "internal error" }, 500));
  }
});
