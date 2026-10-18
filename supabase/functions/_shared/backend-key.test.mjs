import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Only actual source and synthetic credentials enter these VMs. No process,
// fetch, SDK, inherited environment, or production credentials are available.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const plain = (source) => source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const helper = plain(read("backend-key.ts"));
const getBackendKey = vm.runInNewContext(stripTypeScriptTypes(`${helper}\ngetBackendKey;`));
const FIXED_ERROR = "Backend credential configuration is invalid";
const LEGACY = "SYNTHETIC_LEGACY_CREDENTIAL";
const ROTATED = "sb_secret_SYNTHETIC_ROTATED_CREDENTIAL";
const OLD_DEFAULT = "sb_secret_SYNTHETIC_OLD_DEFAULT";
const SELECTOR = "v3-backend-rotation-test";

function select(values) {
  const reads = [];
  return { reads, run: () => getBackendKey((name) => { reads.push(name); return values[name]; }) };
}
function named(raw, extra = {}) {
  return select({ V3_BACKEND_KEY_NAME: SELECTOR, SUPABASE_SECRET_KEYS: raw,
    SUPABASE_SERVICE_ROLE_KEY: LEGACY, ...extra });
}
function fixedFailure(run) {
  assert.throws(run, (error) => error.message === FIXED_ERROR && error.cause === undefined);
}

test("unset selector keeps legacy compatibility without reading new/default keys", () => {
  const fixture = select({ SUPABASE_SERVICE_ROLE_KEY: LEGACY,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: OLD_DEFAULT }) });
  assert.equal(fixture.run(), LEGACY);
  assert.deepEqual(fixture.reads, ["V3_BACKEND_KEY_NAME", "SUPABASE_SERVICE_ROLE_KEY"]);
});
test("unset selector cannot automatically choose a default secret", () => {
  fixedFailure(select({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: OLD_DEFAULT }) }).run);
});
test("named key is selected without reading legacy or selecting default", () => {
  const fixture = named(JSON.stringify({ default: OLD_DEFAULT, [SELECTOR]: ROTATED }));
  assert.equal(fixture.run(), ROTATED);
  assert.deepEqual(fixture.reads, ["V3_BACKEND_KEY_NAME", "SUPABASE_SECRET_KEYS"]);
});

for (const [label, raw] of [
  ["missing dictionary", undefined], ["empty dictionary text", ""],
  ["malformed dictionary", "SYNTHETIC_PRIVATE_PARSE_ERROR{"],
  ["null dictionary", "null"], ["array dictionary", "[]"],
  ["string dictionary", '"SYNTHETIC_PRIVATE_VALUE"'], ["numeric dictionary", "1"],
  ["boolean dictionary", "true"], ["absent selected key", "{}"],
  ["default-only dictionary", JSON.stringify({ default: OLD_DEFAULT })],
]) {
  test(`${label} fails closed despite available legacy key`, () => {
    const fixture = named(raw);
    fixedFailure(fixture.run);
    assert.equal(fixture.reads.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
  });
}
for (const [label, value] of [
  ["null", null], ["number", 123], ["object", {}], ["array", [ROTATED]],
  ["empty", ""], ["bare prefix", "sb_secret_"], ["legacy key", LEGACY],
  ["publishable key", "sb_publishable_SYNTHETIC"],
  ["leading space", ` ${ROTATED}`], ["trailing newline", `${ROTATED}\n`],
  ["embedded newline", "sb_secret_SYNTHETIC\nVALUE"], ["invalid character", "sb_secret_SYNTHETIC!"],
]) {
  test(`selected ${label} value fails with a fixed error`, () => {
    fixedFailure(named(JSON.stringify({ [SELECTOR]: value })).run);
  });
}
for (const value of ["", " ", ` ${SELECTOR}`, `${SELECTOR}\n`]) {
  test(`explicit invalid selector ${JSON.stringify(value)} never enables legacy fallback`, () => {
    const fixture = named(JSON.stringify({ [SELECTOR]: ROTATED }), { V3_BACKEND_KEY_NAME: value });
    fixedFailure(fixture.run);
    assert.equal(fixture.reads.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
  });
}
test("inherited dictionary properties cannot select credentials", () => {
  const fixture = named("{}", { V3_BACKEND_KEY_NAME: "toString" });
  fixedFailure(fixture.run);
});
test("an environment access failure is redacted", () => {
  fixedFailure(() => getBackendKey(() => { throw new Error("SYNTHETIC_PRIVATE_ENV_ERROR"); }));
});
for (const value of [undefined, "", " ", `${LEGACY}\n`]) {
  test(`unavailable/invalid legacy credential fails safely (${JSON.stringify(value)})`, () => {
    fixedFailure(select({ SUPABASE_SERVICE_ROLE_KEY: value }).run);
  });
}

function boot(route, credentials) {
  const state = { clients: [], handler: null, verifiedTokens: [], queries: 0, logs: [] };
  const source = [helper, plain(read("auth.ts")), plain(read("cors.ts")),
    ...(route === "v3-sync-progress" ? [plain(read("../v3-sync-progress/cleanup.ts"))] : []),
    plain(read(`../${route}/index.ts`))].join("\n");
  const fixture = { SUPABASE_URL: "https://fixture.invalid", V3_SYNC_TOKEN: "SYNTHETIC_SYNC_TOKEN", ...credentials };
  vm.runInNewContext(stripTypeScriptTypes(source), {
    Request, Response, Headers,
    Deno: { env: { get: (name) => fixture[name] }, serve: (handler) => { state.handler = handler; } },
    createClient: (url, key, options) => {
      state.clients.push({ url, key, options });
      return { auth: { getUser: async (token) => {
        state.verifiedTokens.push(token);
        return { data: { user: null }, error: { status: 401 } };
      } }, from: () => { state.queries++; throw new Error("Unexpected database access in fixture"); } };
    },
    console: { error: (...args) => state.logs.push(args), log: (...args) => state.logs.push(args) },
  }, { timeout: 1000 });
  return state;
}
const request = (body, authorization) => new Request("https://fixture.invalid/function", {
  method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
  body: JSON.stringify(body),
});
for (const route of ["v3-sync-progress", "v3-users"]) {
  test(`${route} actual entry point selects legacy while selector is unset`, () => {
    const state = boot(route, { SUPABASE_SERVICE_ROLE_KEY: LEGACY });
    assert.equal(state.clients.length, 1);
    assert.equal(state.clients[0].key, LEGACY);
    assert.equal(typeof state.handler, "function");
  });
  test(`${route} actual entry point selects the named secret`, () => {
    const state = boot(route, { V3_BACKEND_KEY_NAME: SELECTOR,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: OLD_DEFAULT, [SELECTOR]: ROTATED }),
      SUPABASE_SERVICE_ROLE_KEY: LEGACY });
    assert.equal(state.clients[0].key, ROTATED);
    assert.equal(state.queries, 0);
    assert.deepEqual(state.logs, []);
  });
  test(`${route} cannot start with missing named credentials, even when legacy exists`, () => {
    fixedFailure(() => boot(route, { V3_BACKEND_KEY_NAME: SELECTOR,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: OLD_DEFAULT }), SUPABASE_SERVICE_ROLE_KEY: LEGACY }));
  });
  test(`${route} keeps user JWT verification after selecting a secret`, async () => {
    const state = boot(route, { V3_BACKEND_KEY_NAME: SELECTOR,
      SUPABASE_SECRET_KEYS: JSON.stringify({ [SELECTOR]: ROTATED }) });
    const body = route === "v3-users" ? { action: "me" } : { action: "createCandidate" };
    assert.equal((await state.handler(request(body))).status, 401);
    assert.equal((await state.handler(request(body, "Bearer SYNTHETIC_INVALID_USER_JWT"))).status, 401);
    assert.deepEqual(state.verifiedTokens, ["SYNTHETIC_INVALID_USER_JWT"]);
    assert.equal(state.queries, 0);
  });
}
test("named backend key does not replace or bypass the sync token", async () => {
  const state = boot("v3-sync-progress", { V3_BACKEND_KEY_NAME: SELECTOR,
    SUPABASE_SECRET_KEYS: JSON.stringify({ [SELECTOR]: ROTATED }) });
  assert.equal((await state.handler(request({ records: [] }))).status, 401);
  assert.equal((await state.handler(request({ token: ROTATED, records: [] }))).status, 401);
  const validTokenInvalidPayload = await state.handler(request({ token: "SYNTHETIC_SYNC_TOKEN", records: [] }));
  assert.equal(validTokenInvalidPayload.status, 400);
  assert.deepEqual(await validTokenInvalidPayload.json(), { error: "invalid sync payload" });
  assert.equal(state.queries, 0);
  assert.deepEqual(state.verifiedTokens, []);
});
