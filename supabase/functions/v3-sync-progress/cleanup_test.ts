import { assertEquals } from "jsr:@std/assert@1";
import { type ExistingProgressRow, planOrphanCleanup } from "./cleanup.ts";

function rows(spec: Record<string, number>): ExistingProgressRow[] {
  const out: ExistingProgressRow[] = [];
  for (const [period, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++) {
      out.push({ id: `${period}-${i}`, period, item_name: `item${i}`, status: "未着手" });
    }
  }
  return out;
}

const BOTH = new Set(["政治活動期間", "選挙期間"]);

Deno.test("残骸が無ければ何もしない", () => {
  const plan = planOrphanCleanup(rows({ 政治活動期間: 15, 選挙期間: 15 }), BOTH, 30);
  assertEquals(plan.action, "none");
});

Deno.test("消えた見出しの行だけを削除対象にする", () => {
  const plan = planOrphanCleanup(rows({ 政治活動期間: 15, 選挙期間: 15, 旧見出し: 3 }), BOTH, 30);
  assertEquals(plan.action, "delete");
  if (plan.action !== "delete") return;
  assertEquals(plan.rows.length, 3);
  assertEquals(plan.rows.every((r) => r.period === "旧見出し"), true);
});

Deno.test("(a) 受け取った項目が0件なら掃除しない", () => {
  const plan = planOrphanCleanup(rows({ 政治活動期間: 15, 選挙期間: 15 }), new Set(), 0);
  assertEquals(plan.action, "skip");
  if (plan.action !== "skip") return;
  assertEquals(plan.warning, false);
  assertEquals(plan.rows.length, 0);
});

Deno.test("(a) period はあっても項目の合計が0件なら掃除しない", () => {
  const plan = planOrphanCleanup(rows({ 政治活動期間: 15, 選挙期間: 15 }), new Set(["政治活動期間"]), 0);
  assertEquals(plan.action, "skip");
});

Deno.test("(b) 削除対象がちょうど50%なら削除せず警告する", () => {
  // 見出しを「政治活動期間」→「政治活動期間（前半）」に書き換えた場合など
  const plan = planOrphanCleanup(rows({ 政治活動期間: 15, 選挙期間: 15 }), new Set(["選挙期間", "政治活動期間（前半）"]), 30);
  assertEquals(plan.action, "skip");
  if (plan.action !== "skip") return;
  assertEquals(plan.warning, true);
  assertEquals(plan.rows.length, 15);
});

Deno.test("(b) 削除対象が50%を超えるなら削除せず警告する", () => {
  const plan = planOrphanCleanup(rows({ 政治活動期間: 15, 選挙期間: 15 }), new Set(["新しい見出し"]), 5);
  assertEquals(plan.action, "skip");
  if (plan.action !== "skip") return;
  assertEquals(plan.warning, true);
  assertEquals(plan.rows.length, 30);
});

Deno.test("(b) 50%未満なら削除する（境界のすぐ下）", () => {
  // 現在 35 行のうち 17 行（48.6%）が残骸
  const plan = planOrphanCleanup(rows({ 政治活動期間: 18, 旧見出し: 17 }), new Set(["政治活動期間"]), 18);
  assertEquals(plan.action, "delete");
});

Deno.test("(c) 削除対象の行に period・item_name・status が入っている", () => {
  const plan = planOrphanCleanup(rows({ 政治活動期間: 15, 選挙期間: 15, 旧見出し: 2 }), BOTH, 30);
  if (plan.action !== "delete") throw new Error("delete のはず");
  for (const r of plan.rows) {
    assertEquals(typeof r.period, "string");
    assertEquals(typeof r.item_name, "string");
    assertEquals("status" in r, true);
  }
});
