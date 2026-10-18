import { corsHeaders } from "../_shared/cors.ts";

const CONFIGURATION_ERROR = "Public configuration is unavailable";
const PUBLISHABLE_PREFIX = "sb_publishable_";

function publishableKey(): string {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const keys: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
  if (keys === null || typeof keys !== "object" || Array.isArray(keys) || !Object.hasOwn(keys, "default")) {
    throw new Error(CONFIGURATION_ERROR);
  }
  const key: unknown = (keys as Record<string, unknown>).default;
  if (typeof key !== "string" || !key.startsWith(PUBLISHABLE_PREFIX) ||
    key.length <= PUBLISHABLE_PREFIX.length || /[^A-Za-z0-9_-]/.test(key)) {
    throw new Error(CONFIGURATION_ERROR);
  }
  return key;
}

export function handleRequest(req: Request): Response {
  // Use corsHeaders directly: withCors would restore the shared POST-only methods.
  const headers: Record<string, string> = {
    ...corsHeaders(req),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Allow": "GET, OPTIONS",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  headers["Content-Type"] = "application/json";
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  try {
    const key = publishableKey();
    headers["Cache-Control"] = "public, max-age=300";
    return new Response(JSON.stringify({ publishable_key: key }), { status: 200, headers });
  } catch {
    // JSON parsing and environment errors can contain key material; return no details.
    return new Response(JSON.stringify({ error: CONFIGURATION_ERROR }), { status: 503, headers });
  }
}

Deno.serve(handleRequest);
