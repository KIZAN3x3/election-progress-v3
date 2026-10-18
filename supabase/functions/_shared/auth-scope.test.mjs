import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

// Run the actual shared functions without loading Deno, SDK imports, or a network client.
function localSource(file) {
  return stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"))
    .replace(/^import\s+[^\r\n]+;\s*$/gm, "")
    .replace(/^export\s+(?=(?:async\s+)?function\b|(?:const|let|var)\b)/gm, "");
}

const shared = new vm.Script(
  `${localSource("prefectures.ts")}\n${localSource("auth.ts")}\n` +
    "({ PREFECTURE_NAMES, isPrefectureCode, prefectureCodeFromName, V3_USER_COLUMNS, getAuthContext, requireAssignedUser, requireAdmin });",
  { filename: "actual-auth-and-prefectures.ts" },
).runInNewContext();

const canonicalPrefectures = [
  ["01", "北海道"], ["02", "青森県"], ["03", "岩手県"], ["04", "宮城県"], ["05", "秋田県"],
  ["06", "山形県"], ["07", "福島県"], ["08", "茨城県"], ["09", "栃木県"], ["10", "群馬県"],
  ["11", "埼玉県"], ["12", "千葉県"], ["13", "東京都"], ["14", "神奈川県"], ["15", "新潟県"],
  ["16", "富山県"], ["17", "石川県"], ["18", "福井県"], ["19", "山梨県"], ["20", "長野県"],
  ["21", "岐阜県"], ["22", "静岡県"], ["23", "愛知県"], ["24", "三重県"], ["25", "滋賀県"],
  ["26", "京都府"], ["27", "大阪府"], ["28", "兵庫県"], ["29", "奈良県"], ["30", "和歌山県"],
  ["31", "鳥取県"], ["32", "島根県"], ["33", "岡山県"], ["34", "広島県"], ["35", "山口県"],
  ["36", "徳島県"], ["37", "香川県"], ["38", "愛媛県"], ["39", "高知県"], ["40", "福岡県"],
  ["41", "佐賀県"], ["42", "長崎県"], ["43", "熊本県"], ["44", "大分県"], ["45", "宮崎県"],
  ["46", "鹿児島県"], ["47", "沖縄県"],
];

function appUser(overrides = {}) {
  return {
    id: "trusted-auth-user-id",
    email: "fixture@example.invalid",
    display_name: "合成利用者",
    status: "active",
    role: "viewer",
    prefecture_code: "13",
    approved_at: null,
    approved_by: null,
    last_login_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function authenticated(user = appUser()) {
  return {
    ok: true,
    authUser: {
      id: "trusted-auth-user-id",
      user_metadata: { role: "admin", prefecture_code: "47" },
    },
    appUser: user,
  };
}

function assertDenied(result, status) {
  assert.equal(result.ok, false);
  assert.equal(result.status, status);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
  assert.equal(Object.hasOwn(result, "actor"), false);
  assert.equal(Object.hasOwn(result, "appUser"), false);
}

function fixtureClient({ authData, authError = null, dbUser = appUser(), dbError = null } = {}) {
  const calls = [];
  const verifiedUser = {
    id: "trusted-auth-user-id",
    user_metadata: { id: "untrusted-metadata-id", role: "admin", prefecture_code: "47" },
  };
  const client = {
    auth: {
      async getUser(token) {
        calls.push(["getUser", token]);
        return { data: authData === undefined ? { user: verifiedUser } : authData, error: authError };
      },
    },
    from(table) {
      calls.push(["from", table]);
      return {
        select(columns) {
          calls.push(["select", columns]);
          return {
            eq(column, value) {
              calls.push(["eq", column, value]);
              return {
                async maybeSingle() {
                  calls.push(["maybeSingle"]);
                  return { data: dbUser, error: dbError };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls, verifiedUser };
}

function request(authorization = "Bearer synthetic-access-token") {
  const headers = { "Content-Type": "application/json", "X-User-Id": "untrusted-header-id" };
  if (authorization !== null) headers.Authorization = authorization;
  return new Request("https://fixture.invalid/?id=untrusted-query-id&prefecture_code=47", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "untrusted-body-id", role: "admin", prefecture_code: "47" }),
  });
}

test("all 47 official Japanese prefectures map to their canonical two-digit codes", () => {
  assert.deepEqual(Array.from(shared.PREFECTURE_NAMES), canonicalPrefectures.map(([, name]) => name));
  for (const [code, name] of canonicalPrefectures) {
    assert.equal(shared.prefectureCodeFromName(name), code, name);
    assert.equal(shared.prefectureCodeFromName(`  ${name}  `), code, `ASCII-space-padded ${name}`);
    assert.equal(shared.isPrefectureCode(code), true, code);
  }
});

test("only canonical Japanese names assign a prefecture; unknown values never imply nationwide access", () => {
  for (const value of [
    "", " ", "東京", "愛知", "大阪", "Tokyo", "Aichi", "東京都庁", "全国", "全都道府県", "*", "all",
    "01", "13", "47", "JP-13", "東 京都", "東京都\u0000", "__proto__", "constructor",
    "\t東京都", "東京都\t", "\n東京都", "東京都\n", "\r東京都", "東京都\r",
    "\u3000東京都", "東京都\u3000", "\u00a0東京都", "東京都\u00a0",
    null, undefined, 13, {}, ["東京都"], new String("東京都"),
  ]) {
    assert.equal(shared.prefectureCodeFromName(value), null, `rejected name ${String(value)}`);
  }
});

test("prefecture codes require exactly two ASCII digits in the closed range 01 through 47", () => {
  for (const value of [
    "", "0", "00", "1", "013", "48", "49", "99", "100", "JP-13", "全国", "*", "all", "１３",
    " 13", "13 ", "13\t", "13\n", "13\r", "13\r\n", "13\u2028", "13\u2029", "13\u0000",
    null, undefined, 13, {}, ["13"], new String("13"),
  ]) {
    assert.equal(shared.isPrefectureCode(value), false, `rejected code ${JSON.stringify(value)}`);
  }
});

test("active assigned viewers can use assigned access but cannot administer", () => {
  const auth = authenticated(appUser({ role: "viewer" }));
  const assigned = shared.requireAssignedUser(auth);
  assert.equal(assigned.ok, true);
  assert.equal(assigned.actor, auth.appUser);
  assertDenied(shared.requireAdmin(auth), 403);
});

test("active admins also need a canonical prefecture and keep their DB assignment", () => {
  for (const [code] of canonicalPrefectures) {
    const auth = authenticated(appUser({ role: "admin", prefecture_code: code }));
    for (const authorize of [shared.requireAssignedUser, shared.requireAdmin]) {
      const result = authorize(auth);
      assert.equal(result.ok, true, code);
      assert.equal(result.actor, auth.appUser);
      assert.equal(result.actor.prefecture_code, code);
    }
  }
});

test("pending, disabled, and missing app users are denied regardless of claimed admin metadata", () => {
  const accounts = [null];
  for (const status of ["pending", "disabled", "unknown", undefined]) {
    for (const role of ["viewer", "admin"]) accounts.push(appUser({ status, role }));
  }
  for (const user of accounts) {
    const auth = authenticated(user);
    assertDenied(shared.requireAssignedUser(auth), 403);
    assertDenied(shared.requireAdmin(auth), 403);
  }
});

test("unassigned or malformed DB scopes are denied for both roles, with no national admin exception", () => {
  for (const prefecture_code of [null, undefined, "", "00", "48", "1", "JP-13", "全国", "*", "all", "１３", "13 ", "13\n", 13]) {
    for (const role of ["viewer", "admin"]) {
      const auth = authenticated(appUser({ role, prefecture_code }));
      assertDenied(shared.requireAssignedUser(auth), 403);
      assertDenied(shared.requireAdmin(auth), 403);
    }
  }
});

test("authorization errors propagate without constructing an actor", () => {
  for (const status of [401, 403, 500]) {
    const failure = { ok: false, status, error: "synthetic-denial" };
    assert.equal(shared.requireAssignedUser(failure), failure);
    assert.equal(shared.requireAdmin(failure), failure);
  }
});

test("getAuthContext verifies the bearer token and selects the app user by verified Auth ID only", async () => {
  const dbUser = appUser({ role: "viewer", prefecture_code: "13" });
  const { client, calls, verifiedUser } = fixtureClient({ dbUser });
  const result = await shared.getAuthContext(client, request());
  assert.equal(result.ok, true);
  assert.equal(result.authUser, verifiedUser);
  assert.equal(result.appUser, dbUser);
  assert.equal(result.appUser.prefecture_code, "13");
  assert.equal(result.appUser.role, "viewer");
  assert.deepEqual(calls, [
    ["getUser", "synthetic-access-token"],
    ["from", "v3_users"],
    ["select", shared.V3_USER_COLUMNS],
    ["eq", "id", "trusted-auth-user-id"],
    ["maybeSingle"],
  ]);
  assert.ok(shared.V3_USER_COLUMNS.split(",").map((column) => column.trim()).includes("prefecture_code"));
});

test("bearer scheme is case insensitive while the token reaches getUser unchanged", async () => {
  const { client, calls } = fixtureClient();
  const result = await shared.getAuthContext(client, request("bEaReR\tfixture-token"));
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["getUser", "fixture-token"]);
});

test("missing or malformed bearer credentials return 401 without Auth or DB calls", async () => {
  for (const authorization of [null, "", "Basic fixture-token", "Bearer", "Bearer ", "Bearer token extra"]) {
    const { client, calls } = fixtureClient();
    assertDenied(await shared.getAuthContext(client, request(authorization)), 401);
    assert.deepEqual(calls, [], String(authorization));
  }
});

test("invalid JWTs and missing Auth users return 401 without querying v3_users", async () => {
  for (const options of [
    { authError: { status: 401, message: "synthetic-auth-error" } },
    { authError: { status: 403, message: "synthetic-auth-error" } },
    { authData: { user: null } },
    { authData: null },
    { authData: {} },
  ]) {
    const { client, calls } = fixtureClient(options);
    const result = await shared.getAuthContext(client, request());
    assertDenied(result, 401);
    assert.deepEqual(calls, [["getUser", "synthetic-access-token"]]);
    assert.equal(result.error.includes("synthetic-auth-error"), false);
  }
});

test("Auth service errors fail closed with 500 and no app user lookup", async () => {
  const { client, calls } = fixtureClient({ authError: { status: 503, message: "synthetic-upstream-detail" } });
  const result = await shared.getAuthContext(client, request());
  assertDenied(result, 500);
  assert.equal(result.error.includes("synthetic-upstream-detail"), false);
  assert.deepEqual(calls, [["getUser", "synthetic-access-token"]]);
});

test("a missing DB registration is represented by null and is rejected by both access guards", async () => {
  const { client } = fixtureClient({ dbUser: null });
  const result = await shared.getAuthContext(client, request());
  assert.equal(result.ok, true);
  assert.equal(result.appUser, null);
  assertDenied(shared.requireAssignedUser(result), 403);
  assertDenied(shared.requireAdmin(result), 403);
});

test("DB lookup errors fail closed even when data also contains a privileged app user", async () => {
  const { client } = fixtureClient({
    dbUser: appUser({ role: "admin", prefecture_code: "13" }),
    dbError: { message: "synthetic-db-private-detail", code: "FIXTURE_DB_ERROR" },
  });
  const result = await shared.getAuthContext(client, request());
  assertDenied(result, 500);
  assert.equal(result.error.includes("synthetic-db-private-detail"), false);
  assert.equal(result.error.includes("FIXTURE_DB_ERROR"), false);
  assert.equal(shared.requireAssignedUser(result), result);
  assert.equal(shared.requireAdmin(result), result);
});
