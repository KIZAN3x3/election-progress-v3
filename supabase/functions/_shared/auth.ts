import type { SupabaseClient, User } from "jsr:@supabase/supabase-js@2";

export interface V3User {
  id: string;
  email: string | null;
  display_name: string;
  status: "pending" | "active" | "disabled";
  role: "admin" | "viewer";
  approved_at: string | null;
  approved_by: string | null;
  last_login_at: string | null;
  created_at: string;
}

export const V3_USER_COLUMNS =
  "id, email, display_name, status, role, approved_at, approved_by, last_login_at, created_at";

export type AuthResult =
  | { ok: true; authUser: User; appUser: V3User | null }
  | { ok: false; status: number; error: string };

function getBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Authorization: Bearer <アクセストークン> を Supabase Auth で照合し、v3_users の行を取得する。
//   ・トークンなし → 401「ログインしてください」
//   ・トークンが無効・期限切れ → 401「ログインし直してください」
//   ・v3_users に行がない（未登録）→ ok: true, appUser: null
export async function getAuthContext(supabase: SupabaseClient, req: Request): Promise<AuthResult> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: "ログインしてください" };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    const status = error && (error.status ?? 0) >= 500 ? 500 : 401;
    return {
      ok: false,
      status,
      error: status === 500 ? "ログイン情報の確認に失敗しました。時間をおいて再度お試しください" : "ログインし直してください",
    };
  }

  const { data: appUser, error: appUserError } = await supabase
    .from("v3_users")
    .select(V3_USER_COLUMNS)
    .eq("id", data.user.id)
    .maybeSingle();
  if (appUserError) {
    return { ok: false, status: 500, error: "利用者情報の取得に失敗しました。時間をおいて再度お試しください" };
  }

  return { ok: true, authUser: data.user, appUser: (appUser as V3User | null) ?? null };
}

// 有効（active）な管理者（admin）だけを通す。承認待ち・無効・未登録・閲覧者は 403
export function requireAdmin(
  auth: AuthResult,
): { ok: true; actor: V3User } | { ok: false; status: number; error: string } {
  if (!auth.ok) return auth;
  const user = auth.appUser;
  if (!user || user.status !== "active") {
    return { ok: false, status: 403, error: "このアカウントは現在利用できません" };
  }
  if (user.role !== "admin") {
    return { ok: false, status: 403, error: "管理者のみ操作できます" };
  }
  return { ok: true, actor: user };
}
