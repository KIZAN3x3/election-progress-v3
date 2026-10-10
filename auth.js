// Googleログイン＋管理者承認制の共通処理（ES モジュール）。
// SUPABASE_URL / SUPABASE_KEY は config.js（通常の <script>）で定義した値を使う。
//   ・ログインは Supabase Auth の Google プロバイダー（PKCE）。戻り先は今のページ
//   ・利用者の状態（未登録・承認待ち・有効・無効）と役割は Edge Function v3-users の me で調べる
//   ・データの読み取りは getSupabase() のクライアント（ログイン中の利用者のトークン付き）で行う
//   ・候補者の登録・編集・削除は syncApi() で v3-sync-progress を JWT 付きで呼ぶ
/* global SUPABASE_URL, SUPABASE_KEY */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';

// Googleへ移動する前に立てる印。戻ってきた直後だけ最終ログイン日時を記録するため
const LOGIN_PENDING_KEY = 'v3:googleLoginPending';
// ログイン画面に出すメッセージ（ほかのページからログイン画面へ戻すとき）
const LOGIN_MESSAGE_KEY = 'v3:loginMessage';
// Googleから戻ってきたときに URL に付くパラメータ
const OAUTH_URL_PARAMS = ['code', 'error', 'error_code', 'error_description'];
// ログイン後に戻すページ（オープンリダイレクトを防ぐため、このアプリのページだけ）
const NEXT_PAGE_PATTERN = /^(list|detail|admin)\.html(\?[^#]*)?$/;

export const ROLE_LABELS = { admin: '管理者', viewer: '閲覧者' };

// 以前のパスワード方式の印を消す
sessionStorage.removeItem('v3_auth');

let client = null;

export function getSupabase(){
  if(!client){
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }
  return client;
}

// LINE・チャットワークなどのアプリ内ブラウザか（Googleはアプリ内ブラウザでのログインを拒否する）
export function isInAppBrowser(){
  const ua = navigator.userAgent || '';
  return /Line\/|FBAN|FBAV|Instagram|Chatwork|MicroMessenger|KAKAOTALK/i.test(ua);
}

export async function startGoogleLogin(){
  sessionStorage.setItem(LOGIN_PENDING_KEY, '1');
  const redirectTo = `${location.origin}${location.pathname}${location.search}`;
  const { error } = await getSupabase().auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if(error){
    sessionStorage.removeItem(LOGIN_PENDING_KEY);
    throw error;
  }
}

// Googleから戻ってきたときに URL に付いた code / error を消す。失敗して戻ってきた場合はメッセージを返す
function consumeOAuthParams(){
  const url = new URL(location.href);
  if(!OAUTH_URL_PARAMS.some(key => url.searchParams.has(key))) return '';
  const failed = url.searchParams.has('error') || url.searchParams.has('error_description');
  for(const key of OAUTH_URL_PARAMS) url.searchParams.delete(key);
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  if(failed){
    sessionStorage.removeItem(LOGIN_PENDING_KEY);
    return 'Googleログインに失敗しました。もう一度お試しください';
  }
  return '';
}

async function accessToken(){
  const { data } = await getSupabase().auth.getSession(); // 期限が近ければ更新済みのものが返る
  return data && data.session ? data.session.access_token : null;
}

async function callFunction(name, body){
  const token = await accessToken();
  const headers = { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' };
  if(token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// Edge Function v3-users を呼ぶ。失敗したら Error（status・data 付き）を投げる
export async function usersApi(action, body = {}){
  const res = await callFunction('v3-users', { ...body, action });
  const data = await res.json().catch(() => ({}));
  if(!res.ok){
    if(res.status === 401 && action !== 'me' && action !== 'login') redirectToLogin();
    const err = new Error(data.error || `エラーが発生しました（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Edge Function v3-sync-progress（候補者の登録・編集・削除）を JWT 付きで呼ぶ。Response をそのまま返す
export async function syncApi(body){
  const res = await callFunction('v3-sync-progress', body);
  if(res.status === 401) redirectToLogin();
  return res;
}

// この端末のセッションだけを消す（ほかの端末のログインは消さない）
export async function signOutLocal(){
  try {
    await getSupabase().auth.signOut({ scope: 'local' });
  } catch (e) {
    console.error('ログアウトに失敗:', e);
  }
}

export async function logout(){
  await signOutLocal();
  location.href = 'index.html';
}

let redirecting = false;

// セッションを消してログイン画面へ戻す。ログイン後は今のページへ戻る
export async function redirectToLogin(message = 'ログインし直してください'){
  if(redirecting) return;
  redirecting = true;
  await signOutLocal();
  sessionStorage.setItem(LOGIN_MESSAGE_KEY, message);
  const page = (location.pathname.split('/').pop() || '') + location.search;
  location.replace('index.html' + (NEXT_PAGE_PATTERN.test(page) ? '?next=' + encodeURIComponent(page) : ''));
}

export function takeLoginMessage(){
  const message = sessionStorage.getItem(LOGIN_MESSAGE_KEY) || '';
  sessionStorage.removeItem(LOGIN_MESSAGE_KEY);
  return message;
}

// ログイン画面の ?next= を、このアプリのページのときだけ返す
export function safeNextPage(){
  const next = new URLSearchParams(location.search).get('next') || '';
  return NEXT_PAGE_PATTERN.test(next) ? next : 'list.html';
}

// ページを開いたときに、セッションがあれば利用者の状態を調べる。
// 返り値: { account: null | { status, email, google_name, user }, message }
export async function loadAccount(){
  const supabase = getSupabase(); // 作成時に URL の ?code= を読み取り、セッションに交換する
  const { data } = await supabase.auth.getSession(); // 交換が終わるまで待ってから返る
  const message = consumeOAuthParams();
  if(!data || !data.session) return { account: null, message };

  if(sessionStorage.getItem(LOGIN_PENDING_KEY)){
    sessionStorage.removeItem(LOGIN_PENDING_KEY);
    try {
      await usersApi('login');
    } catch (e) {
      console.error('最終ログイン日時の記録に失敗:', e); // 記録に失敗してもログインは続ける
    }
  }

  try {
    return { account: await usersApi('me'), message: '' };
  } catch (err) {
    if(err.status === 401){
      // トークンが無効（削除された利用者など）。セッションを捨てる
      await signOutLocal();
      return { account: null, message: 'ログインし直してください' };
    }
    throw err;
  }
}

// ---------- 画面 ----------

const STYLE = `
body.gate-open > :not(.account-gate){display:none !important;}
.account-gate{width:100%;max-width:420px;margin:40px auto;padding:0 16px;}
.account-gate-card{background:var(--surface,#f5f5f5);border-radius:var(--radius,12px);padding:32px 28px;text-align:center;}
.account-gate-title{font-size:18px;font-weight:800;margin-bottom:12px;color:var(--accent2,#e05c00);}
.account-gate-text{font-size:13px;color:var(--text2,#5c5650);line-height:1.7;margin-bottom:10px;}
.account-gate-email{font-size:12px;color:var(--text3,#8c8478);margin-bottom:18px;word-break:break-all;}
.account-gate-form{text-align:left;margin-bottom:12px;}
.account-gate-form label{display:block;font-size:12px;color:var(--text3,#8c8478);margin-bottom:6px;font-weight:600;}
.account-gate-form input{width:100%;background:var(--surface2,#ececec);border:1px solid var(--border,#ddd9d0);border-radius:var(--radius-sm,8px);color:var(--text,#1a1a1a);padding:10px 12px;font-size:14px;font-family:inherit;outline:none;}
.account-gate-form input:focus{border-color:var(--accent,#f77f00);}
.account-gate-error{color:var(--danger,#e74c3c);font-size:13px;min-height:16px;margin:8px 0;}
.account-gate-actions{display:flex;flex-direction:column;gap:8px;}
.account-gate-btn{padding:12px 20px;border-radius:var(--radius-sm,8px);font-size:14px;font-weight:700;cursor:pointer;border:none;width:100%;font-family:inherit;background:var(--accent,#f77f00);color:white;}
.account-gate-btn:hover{background:var(--accent2,#e05c00);}
.account-gate-btn:disabled{opacity:.6;cursor:not-allowed;}
.account-gate-btn.secondary{background:var(--surface2,#ececec);color:var(--text2,#5c5650);}
.account-gate-btn.secondary:hover{background:var(--border,#ddd9d0);}
.app-header{flex-wrap:wrap;}
.app-header h1{margin-right:auto;}
.user-bar{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2,#5c5650);white-space:nowrap;}
.user-bar-role{font-size:11px;font-weight:700;color:var(--accent2,#e05c00);background:#fff1e3;border-radius:999px;padding:2px 8px;}
.user-bar-name{max-width:10em;overflow:hidden;text-overflow:ellipsis;}
.user-bar-logout{background:transparent;border:1px solid var(--border,#ddd9d0);color:var(--text3,#8c8478);border-radius:var(--radius-sm,8px);padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;}
.user-bar-logout:hover{border-color:var(--accent,#f77f00);color:var(--accent2,#e05c00);}
@media (max-width:600px){.user-bar-name{max-width:6em;}}
`;

function injectStyle(){
  if(document.getElementById('auth-style')) return;
  const style = document.createElement('style');
  style.id = 'auth-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function el(tag, className, text){
  const node = document.createElement(tag);
  if(className) node.className = className;
  if(text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick){
  const btn = el('button', className, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

// ページ本体を隠して、カードを1枚だけ出す
function gateCard(title){
  injectStyle();
  document.querySelectorAll('.account-gate').forEach(node => node.remove());
  const gate = el('div', 'account-gate');
  const card = el('div', 'account-gate-card');
  card.appendChild(el('h1', 'account-gate-title', title));
  gate.appendChild(card);
  document.body.appendChild(gate);
  document.body.classList.remove('auth-pending');
  document.body.classList.add('gate-open');
  return card;
}

function logoutButton(){
  return button('ログアウト', 'account-gate-btn secondary', () => logout());
}

function emailLine(account){
  return el('p', 'account-gate-email', account.email ? `ログイン中: ${account.email}` : '');
}

// status が active 以外のときに出す画面（unregistered / pending / disabled）
export function showAccountGate(account){
  if(account.status === 'unregistered'){
    renderRegisterForm(account);
    return;
  }
  if(account.status === 'pending'){
    const card = gateCard('承認待ちです');
    card.appendChild(el('p', 'account-gate-text', '登録を受け付けました。管理者が承認すると、使えるようになります。'));
    card.appendChild(emailLine(account));
    const actions = el('div', 'account-gate-actions');
    actions.append(button('承認されたか確認する', 'account-gate-btn', () => location.reload()), logoutButton());
    card.appendChild(actions);
    return;
  }
  const card = gateCard('このアカウントは利用できません');
  card.appendChild(el('p', 'account-gate-text', 'このアカウントは無効になっています。管理者にお問い合わせください。'));
  card.appendChild(emailLine(account));
  const actions = el('div', 'account-gate-actions');
  actions.appendChild(logoutButton());
  card.appendChild(actions);
}

function renderRegisterForm(account){
  const card = gateCard('利用登録');
  card.appendChild(el('p', 'account-gate-text', '表示名を入力して登録してください。管理者が承認すると、使えるようになります。'));
  card.appendChild(emailLine(account));

  const form = el('form', 'account-gate-form');
  const label = el('label', '', '表示名（ほかの人が見て分かる名前）');
  label.htmlFor = 'registerDisplayName';
  const input = el('input');
  input.id = 'registerDisplayName';
  input.type = 'text';
  input.maxLength = 50;
  input.autocomplete = 'off';
  input.value = (account.google_name || '').slice(0, 50);
  const error = el('div', 'account-gate-error');
  const submit = el('button', 'account-gate-btn', '登録する');
  submit.type = 'submit';
  form.append(label, input, error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const displayName = input.value.trim();
    if(!displayName){
      error.textContent = '表示名を入力してください';
      return;
    }
    submit.disabled = true;
    try {
      await usersApi('register', { display_name: displayName });
      location.reload(); // 読み直すと「承認待ち」の画面になる
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });
  card.appendChild(form);

  const actions = el('div', 'account-gate-actions');
  actions.appendChild(logoutButton());
  card.appendChild(actions);
}

function showFatal(message){
  const card = gateCard('エラー');
  card.appendChild(el('p', 'account-gate-text', message));
  const actions = el('div', 'account-gate-actions');
  actions.append(button('読み直す', 'account-gate-btn', () => location.reload()), logoutButton());
  card.appendChild(actions);
}

// ヘッダー（.app-header）に、ログイン中の表示名・役割・ログアウトボタンを出す
function renderUserBar(user){
  injectStyle();
  const header = document.querySelector('.app-header');
  if(!header) return;
  const bar = el('div', 'user-bar');
  bar.appendChild(el('span', 'user-bar-role', ROLE_LABELS[user.role] || user.role));
  const name = el('span', 'user-bar-name', user.display_name);
  name.title = user.display_name;
  bar.appendChild(name);
  bar.appendChild(button('ログアウト', 'user-bar-logout', () => logout()));
  header.appendChild(bar);
}

// list.html / detail.html / admin.html の入口。有効な利用者なら user を返し、それ以外は画面を切り替えて null を返す
//   ・ログインしていない → ログイン画面へ（ログイン後にこのページへ戻る）
//   ・未登録・承認待ち・無効 → 状態ごとの画面
//   ・adminOnly で管理者でない → list.html へ
export async function requirePageAccess({ adminOnly = false } = {}){
  let result;
  try {
    result = await loadAccount();
  } catch (e) {
    console.error(e);
    showFatal('ログイン状態を確認できませんでした。時間をおいて再度お試しください');
    return null;
  }
  if(!result.account){
    await redirectToLogin(result.message || 'ログインしてください');
    return null;
  }
  const account = result.account;
  if(account.status !== 'active'){
    showAccountGate(account);
    return null;
  }
  if(adminOnly && account.user.role !== 'admin'){
    location.replace('list.html');
    return null;
  }
  renderUserBar(account.user);
  document.body.classList.remove('auth-pending');
  return account.user;
}
