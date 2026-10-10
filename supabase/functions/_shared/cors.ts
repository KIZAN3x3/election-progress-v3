// 画面（GitHub Pages）とローカルの確認用サーバーだけにブラウザからの呼び出しを許可する。
// CORS はブラウザだけの制限なので、GitHub Actions・Apps Script からの sync 呼び出しには影響しない
const ALLOWED_ORIGINS = ["https://kizan3x3.github.io", "http://localhost:5500"];

export function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const origin = req.headers.get("Origin") ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// ハンドラーが返したレスポンスに CORS ヘッダーを付ける
export function withCors(req: Request, res: Response): Response {
  for (const [key, value] of Object.entries(corsHeaders(req))) {
    res.headers.set(key, value);
  }
  return res;
}
