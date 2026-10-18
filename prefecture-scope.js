// 画面の表示・入力補助。アクセスの許可はDBのRLSとEdge Functionが判定する。
export const PREFECTURE_NAMES = Object.freeze([
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県',
  '埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県',
  '岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
  '鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県',
  '佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'
]);

export function prefectureNameForCode(code){
  if(typeof code !== 'string' || code.length !== 2 || !/^(0[1-9]|[1-3][0-9]|4[0-7])$/.test(code)) return null;
  return PREFECTURE_NAMES[Number(code) - 1];
}

export function assignedPrefecture(user){
  return prefectureNameForCode(user?.prefecture_code);
}

export function candidateInScope(candidate, user){
  const assigned = assignedPrefecture(user);
  return !!assigned && typeof candidate?.prefecture === 'string'
    && candidate.prefecture.replace(/^ +| +$/g, '') === assigned;
}

export function candidatesInScope(rows, user){
  return Array.isArray(rows) ? rows.filter(row => candidateInScope(row, user)) : [];
}

// 閲覧者・管理者とも担当県を固定する。値の改変は送信直前にも検査する。
export function setPrefectureSelect(select, user){
  const name = assignedPrefecture(user);
  select.replaceChildren();
  if(name){
    const option = select.ownerDocument.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = name || '';
  select.disabled = true;
  return name;
}
