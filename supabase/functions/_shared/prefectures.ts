// Candidate rows contain the official Japanese name; user assignments use JIS codes.
// Neither unknown names nor missing assignments imply nationwide access.
export const PREFECTURE_NAMES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
  "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
  "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const;

export function isPrefectureCode(value: unknown): value is string {
  return typeof value === "string" && value.length === 2 && /^(?:0[1-9]|[1-3][0-9]|4[0-7])$/.test(value);
}

export function prefectureCodeFromName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Match PostgreSQL btrim(text): remove ASCII spaces, not tabs or other Unicode whitespace.
  const index = (PREFECTURE_NAMES as readonly string[]).indexOf(value.replace(/^ +| +$/g, ""));
  return index < 0 ? null : String(index + 1).padStart(2, "0");
}
