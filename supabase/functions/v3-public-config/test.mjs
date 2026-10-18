import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const PUBLIC_KEY = "sb_publishable_SYNTHETIC_PUBLIC_TEST_ONLY";
const PRIVATE_CANARY = "sb_secret_SYNTHETIC_PRIVATE_TEST_ONLY";
const ERROR_MESSAGE = "Public configuration is unavailable";
const PAGE_ORIGIN = "https://kizan3x3.github.io";

function source(file) {
  return stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"))
    .replace(/^import\s+[^\r\n]+;\s*$/gm, "")
    .replace(/^export\s+(?=(?:async\s+)?function\b|(?:const|let|var)\b)/gm, "");
}

// Execute the actual module and shared CORS helper. The VM receives no process,
// fetch, SDK, real environment variables, or network-capable Deno implementation.
function boot(raw, { envThrows = false, inheritedDefault = false } = {}) {
  const dictionary = arguments.length === 0 ? JSON.stringify({ default: PUBLIC_KEY }) : raw;
  const state = { handler: null, reads: [], logs: [], serveCalls: 0 };
  const context = vm.createContext({
    Request, Response, Headers,
    Deno: {
      env: { get(name) {
        state.reads.push(name);
        if (envThrows) throw new Error(PRIVATE_CANARY);
        return name === "SUPABASE_PUBLISHABLE_KEYS" ? dictionary : undefined;
      } },
      serve(handler) { state.serveCalls++; state.handler = handler; },
    },
    console: Object.fromEntries(["log", "info", "warn", "error", "debug"].map((method) => [method, (...args) => state.logs.push(args)])),
  });
  if (inheritedDefault) vm.runInContext(`Object.prototype.default = ${JSON.stringify(PUBLIC_KEY)};`, context);
  vm.runInContext(`${source("../_shared/cors.ts")}\n${source("index.ts")}`, context, { timeout: 1000 });
  assert.equal(state.serveCalls, 1);
  assert.equal(typeof state.handler, "function");
  assert.deepEqual(state.reads, [], "module initialization must not read credentials");
  state.request = (method = "GET", origin = PAGE_ORIGIN) => state.handler(new Request("https://fixture.invalid/functions/v1/v3-public-config", {
    method,
    headers: origin === null ? {} : { Origin: origin },
  }));
  return state;
}

function commonHeaders(response) {
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(response.headers.get("Allow"), "GET, OPTIONS");
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}

async function unavailable(state) {
  const response = state.request();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), PAGE_ORIGIN);
  commonHeaders(response);
  assert.deepEqual(await response.json(), { error: ERROR_MESSAGE });
  assert.deepEqual(state.reads, ["SUPABASE_PUBLISHABLE_KEYS"]);
  assert.deepEqual(state.logs, []);
}

test("GET returns only the own default publishable key and caches it for five minutes", async () => {
  const state = boot(JSON.stringify({ default: PUBLIC_KEY, other: PRIVATE_CANARY, metadata: { private: PRIVATE_CANARY } }));
  const response = state.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(response.headers.get("Content-Type"), "application/json");
  commonHeaders(response);
  assert.deepEqual(await response.json(), { publishable_key: PUBLIC_KEY });
  assert.deepEqual(state.reads, ["SUPABASE_PUBLISHABLE_KEYS"]);
  assert.deepEqual(state.logs, []);
});

for (const origin of [PAGE_ORIGIN, "http://localhost:5500"]) {
  test(`GET permits the existing trusted CORS origin ${origin}`, async () => {
    const response = boot().request("GET", origin);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    commonHeaders(response);
    assert.deepEqual(await response.json(), { publishable_key: PUBLIC_KEY });
  });
}

for (const origin of [null, "https://untrusted.invalid", "https://kizan3x3.github.io.untrusted.invalid"]) {
  test(`GET does not grant wildcard or untrusted CORS access (${String(origin)})`, () => {
    const response = boot().request("GET", origin);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    commonHeaders(response);
  });
}

for (const [label, raw] of [
  ["missing", undefined], ["empty", ""], ["malformed", `${PRIVATE_CANARY}{`],
  ["null", "null"], ["array", JSON.stringify([PUBLIC_KEY])], ["string", JSON.stringify(PUBLIC_KEY)],
  ["number", "1"], ["boolean", "true"], ["empty object", "{}"],
  ["named key only", JSON.stringify({ named: PUBLIC_KEY })],
  ["secret named key only", JSON.stringify({ named: PRIVATE_CANARY })],
]) {
  test(`${label} dictionary fails closed with a fixed non-cached error`, async () => {
    await unavailable(boot(raw));
  });
}

for (const [label, value] of [
  ["null", null], ["number", 123], ["boolean", true], ["object", {}], ["array", [PUBLIC_KEY]],
  ["empty", ""], ["bare prefix", "sb_publishable_"], ["secret key", PRIVATE_CANARY],
  ["legacy JWT", "eyJhbGciOiJIUzI1NiJ9.SYNTHETIC_TEST_ONLY.signature"],
  ["wrong case", "SB_PUBLISHABLE_SYNTHETIC"], ["leading space", ` ${PUBLIC_KEY}`],
  ["trailing space", `${PUBLIC_KEY} `], ["trailing newline", `${PUBLIC_KEY}\n`],
  ["trailing carriage return", `${PUBLIC_KEY}\r`], ["trailing unicode separator", `${PUBLIC_KEY}\u2028`],
  ["embedded newline", "sb_publishable_SYNTHETIC\nVALUE"], ["tab", `${PUBLIC_KEY}\t`],
  ["dot", "sb_publishable_SYNTHETIC.VALUE"], ["plus", "sb_publishable_SYNTHETIC+VALUE"],
  ["slash", "sb_publishable_SYNTHETIC/VALUE"], ["padding", "sb_publishable_SYNTHETIC="],
  ["unicode", "sb_publishable_合成"],
]) {
  test(`default ${label} value is rejected`, async () => {
    await unavailable(boot(JSON.stringify({ default: value, safeAlternative: PUBLIC_KEY })));
  });
}

test("a prototype-inherited default is not a configured own key", async () => {
  await unavailable(boot("{}", { inheritedDefault: true }));
});

test("environment access exceptions cannot expose their message or cache an error", async () => {
  await unavailable(boot(undefined, { envThrows: true }));
});

for (const origin of [PAGE_ORIGIN, "http://localhost:5500", "https://untrusted.invalid", null]) {
  test(`OPTIONS uses GET/OPTIONS CORS methods without reading the environment (${String(origin)})`, async () => {
    const state = boot(undefined, { envThrows: true });
    const response = state.request("OPTIONS", origin);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), [PAGE_ORIGIN, "http://localhost:5500"].includes(origin) ? origin : null);
    commonHeaders(response);
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.logs, []);
  });
}

for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
  test(`${method} returns 405 and Allow without reading credentials`, async () => {
    const state = boot(undefined, { envThrows: true });
    const response = state.request(method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), PAGE_ORIGIN);
    commonHeaders(response);
    assert.deepEqual(await response.json(), { error: "Method not allowed" });
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.logs, []);
  });
}
