// シートから消えた見出し（period）の行を掃除するかどうかを決める（DB には触れない純粋な関数）。
// sync で「シート全体」（fullSheet: true）を受け取ったときだけ、候補者ごとに呼ぶ。

export interface ExistingProgressRow {
  id: string;
  period: string;
  item_name: string;
  status: string | null;
}

export type CleanupPlan =
  | { action: "none" }
  | { action: "delete"; rows: ExistingProgressRow[] }
  | { action: "skip"; reason: string; warning: boolean; rows: ExistingProgressRow[] };

// 削除対象がその候補者の現在の行数のこの割合以上なら、削除せずに警告する
export const CLEANUP_MAX_RATIO = 0.5;

// existingRows: その候補者の v3_progress の現在の行（upsert 後に読んだもの）
// receivedPeriods: 今回受け取った records に含まれる period
// receivedItemCount: 今回受け取った records の項目数の合計
export function planOrphanCleanup(
  existingRows: ExistingProgressRow[],
  receivedPeriods: Set<string>,
  receivedItemCount: number,
): CleanupPlan {
  // (a) 項目が1件も無いシートは読み取りの失敗などが考えられるので、掃除しない
  if (receivedItemCount === 0 || receivedPeriods.size === 0) {
    return { action: "skip", reason: "受け取った項目が0件のため掃除しません", warning: false, rows: [] };
  }

  const orphans = existingRows.filter((row) => !receivedPeriods.has(row.period));
  if (orphans.length === 0) return { action: "none" };

  // (b) 消す行が多すぎるときは、見出しの書き換えミスなどの可能性があるので止める
  if (orphans.length >= existingRows.length * CLEANUP_MAX_RATIO) {
    return {
      action: "skip",
      reason: `削除対象が ${orphans.length}/${existingRows.length} 行（${Math.round(CLEANUP_MAX_RATIO * 100)}%以上）のため削除しませんでした。シートの見出しを確認してください`,
      warning: true,
      rows: orphans,
    };
  }

  return { action: "delete", rows: orphans };
}
