// ZenTao MCP connector for ChatGPT — Cloudflare Worker, no dependencies.
//
// API facts verified live against ZenTao 21.7 (2026-09-21):
//   - login:   POST {base}/api.php/v1/tokens          JSON {account, password} -> 201 {token}
//   - auth:    header "Token: <token>" on every call; 401 means re-login
//   - reads:   GET /products, /projects, /executions, /products/{id}/stories,
//              /products/{id}/bugs, /executions/{id}/tasks  (query: limit, page)
//   - writes:  ALL write requests must use a JSON body:
//              PUT ignores form-urlencoded entirely (PHP does not populate $_POST
//              for PUT), and on POST the task-create parser silently drops some
//              fields sent as form data (e.g. assignedTo). JSON works everywhere:
//              POST /products/{id}/stories, /executions/{id}/tasks,
//              POST /projects/{id}/executions,
//              PUT  /stories/{id}, /tasks/{id}, /executions/{id},
//              PUT  /stories/{id}/close
//   - quirks:  story create/update on products with forced review require
//              "reviewer"; task create requires "estStarted" (we default to today)
//   - delete:  DELETE /stories/{id}, /tasks/{id}, /executions/{id} -> {message:"success"}
//              (intentionally NOT exposed as MCP tools)
//   - v2 API (/api.php/v2) is NOT enabled on 21.7 despite the docs; it returns empty HTML 200.

const API_VERSION = '2025-06-18';

// Per-account credential resolution. Two modes:
//   single-user: URL /mcp/<MCP_SECRET> uses ZT_ACCOUNT / ZT_PASSWORD
//   multi-user:  URL /mcp/<ZT_SECRET_<ACCOUNT>> logs into that ZenTao account
//                with the password from ZT_USER_<ACCOUNT> (falls back to
//                ZT_PASSWORD when the account equals ZT_ACCOUNT). Each
//                teammate registers their own ChatGPT connector with their own
//                secret URL, so bugs they create carry their own openedBy.
const tokenCache = new Map(); // account -> API token
const webSessions = new Map(); // account -> web session cookie

// Static env secrets first (ZT_SECRET_<ACCOUNT> / MCP_SECRET), then the
// ZT_USERS KV store filled by the self-service registration page.
async function resolveUser(env, secret) {
  if (!secret) return null;
  if (env.MCP_SECRET && secret === env.MCP_SECRET) {
    if (!env.ZT_ACCOUNT || !env.ZT_PASSWORD) return null;
    return { account: env.ZT_ACCOUNT, password: env.ZT_PASSWORD };
  }
  for (const key of Object.keys(env)) {
    if (!key.startsWith('ZT_SECRET_') || env[key] !== secret) continue;
    const account = key.slice('ZT_SECRET_'.length).toLowerCase();
    const password = env['ZT_USER_' + key.slice('ZT_SECRET_'.length)]
      ?? (account === env.ZT_ACCOUNT ? env.ZT_PASSWORD : undefined);
    if (!password) return null;
    return { account, password };
  }
  // self-service registered users (AES-GCM encrypted credentials in KV)
  if (env.ZT_USERS) {
    try {
      const blob = await env.ZT_USERS.get('s:' + secret);
      if (blob) {
        const key = await getRegKey(env);
        if (key) {
          const cred = await decryptCred(key, blob);
          if (cred && cred.account && cred.password) return cred;
        }
      }
    } catch { /* fall through to reject */ }
  }
  return null;
}

// Optional product -> default-project map for bug creation, e.g. {"7":93}.
// Keeps the "bugs must hang off a project" rule without hardcoding tenant IDs.
function projectMap(env) {
  try {
    const raw = JSON.parse(env.ZT_PRODUCT_PROJECT_MAP || '{}');
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (Number.isFinite(Number(v))) out[String(k)] = Number(v);
    return out;
  } catch { return {}; }
}
function projectMapDesc(env) {
  return Object.entries(projectMap(env)).map(([p, pr]) => `产品${p}->项目${pr}`).join('、');
}

const apiBase = (env) => env.ZT_BASE.replace(/\/+$/, '') + '/api.php/v1';
const W_BASE = (env) => env.ZT_BASE.replace(/\/+$/, '');
const todayCN = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
// ZenTao (this deployment) rejects task creation without a deadline; default to
// today+7 when the caller does not provide one (overridable via update_task).
const plusDaysCN = (n) => new Date(Date.now() + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mcpResult(id, result) {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

function mcpError(id, code, message) {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// ZenTao client
// ---------------------------------------------------------------------------

async function zentaoLogin(env, user) {
  const res = await fetch(apiBase(env) + '/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: user.account, password: user.password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    tokenCache.delete(user.account);
    throw new Error(`禅道登录失败（HTTP ${res.status}）: ${JSON.stringify(body).slice(0, 300)}，账号 ${user.account} 的凭据可能不正确`);
  }
  tokenCache.set(user.account, body.token);
  return body.token;
}

async function ztFetch(env, user, path, { method = 'GET', body, query } = {}, allowRetry = true) {
  let token = tokenCache.get(user.account);
  if (!token) token = await zentaoLogin(env, user);
  const url = new URL(apiBase(env) + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { Token: token };
  const init = { method, headers };
  if (body) {
    const clean = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null && v !== '') clean[k] = v;
    }
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(clean);
  }
  const res = await fetch(url, init);
  // Origin flakiness (CF 520/522 = origin connection issues): retry once, but
  // only where the request is known-idempotent (GETs and the token login).
  // 522 specifically means the request never reached the origin.
  const retryable5xx = res.status === 522 || res.status === 520;
  if (retryable5xx && (method === 'GET' || /\/tokens$/.test(path)) && allowRetry) {
    await new Promise(r => setTimeout(r, 1000));
    return ztFetch(env, user, path, { method, body, query }, false);
  }
  if (res.status === 522 && allowRetry) {
    await new Promise(r => setTimeout(r, 800));
    return ztFetch(env, user, path, { method, body, query }, false);
  }
  if (res.status === 401 && allowRetry) {
    tokenCache.delete(user.account);
    await zentaoLogin(env, user);
    return ztFetch(env, user, path, { method, body, query }, false);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { nonJsonResponse: text.slice(0, 400) };
  }
  return { status: res.status, ok: res.ok, data };
}

// ---------------------------------------------------------------------------
// Web session + image upload. The REST v1 API strips <img> tags from rich-text
// fields (verified 2026-09-21: both data: URIs and absolute URLs are removed),
// so inline images must go through the web form flow: web login → imgFile
// upload → bug create/edit web form with <img src="/zentao/file-read-N.ext">.
// Verified live on 21.7: img survives only when written via the web form.
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
const MAX_IMAGE_BYTES = 9 * 1024 * 1024;


// Pure-JS MD5 (WebCrypto has no MD5; ZenTao web login needs md5(md5(pwd)+rand)).
function md5(str) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;
  const msg = new TextEncoder().encode(str);
  const bitLen = msg.length * 8;
  const total = (((msg.length + 8) >> 6) + 1) * 16;
  const M = new Int32Array(total);
  for (let i = 0; i < msg.length; i++) M[i >> 2] |= msg[i] << ((i % 4) * 8);
  M[msg.length >> 2] |= 0x80 << ((msg.length % 4) * 8);
  M[total - 2] = bitLen | 0;
  M[total - 1] = Math.floor(bitLen / 4294967296) | 0;
  let A = 0x67452301 | 0, B = 0xefcdab89 | 0, C = 0x98badcfe | 0, D = 0x10325476 | 0;
  const rol = (x, c) => (x << c) | (x >>> (32 - c));
  for (let i = 0; i < total; i += 16) {
    let a = A, b = B, c = C, d = D;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const s = S[j];
      const tmp = d;
      d = c; c = b;
      b = (b + rol((a + f + K[j] + M[i + g]) | 0, s)) | 0;
      a = tmp;
    }
    A = (A + a) | 0; B = (B + b) | 0; C = (C + c) | 0; D = (D + d) | 0;
  }
  const hex = v => { let s = ''; for (let i = 0; i < 4; i++) s += ((v >>> (i * 8)) & 0xff).toString(16).padStart(2, '0'); return s; };
  return hex(A) + hex(B) + hex(C) + hex(D);
}

async function webLogin(env, user) {
  const r1 = await fetch(W_BASE(env) + '/user-refreshRandom.html', { headers: { 'User-Agent': UA } });
  const rand = (await r1.text()).trim();
  const sid1 = (/zentaosid=([^;]+)/.exec(r1.headers.get('set-cookie') || '') || [])[1];
  const cookie1 = sid1 ? 'zentaosid=' + sid1 : '';
  const password = md5(md5(user.password) + rand);
  const body = new URLSearchParams({
    account: user.account, password, passwordStrength: '1',
    referer: '/zentao/', verifyRand: rand, keepLogin: '0', captcha: '',
  });
  const res = await fetch(W_BASE(env) + '/user-login.html', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Cookie: cookie1, 'X-Requested-With': 'XMLHttpRequest' },
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { result: 'fail', message: '登录响应异常: ' + text.slice(0, 120) }; }
  const sid2 = (/zentaosid=([^;]+)/.exec(res.headers.get('set-cookie') || '') || [])[1];
  const session = { cookie: 'zentaosid=' + (sid2 || sid1 || '') };
  if (data.result !== 'success') {
    webSessions.delete(user.account);
    throw new Error('禅道网页登录失败: ' + JSON.stringify(data).slice(0, 200));
  }
  webSessions.set(user.account, session);
  return session;
}

async function webFetch(env, user, path, init = {}, allowRetry = true) {
  let session = webSessions.get(user.account);
  if (!session) session = await webLogin(env, user);
  const res = await fetch(W_BASE(env) + path, {
    ...init,
    headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Cookie: session.cookie, ...(init.headers || {}) },
    redirect: 'manual',
  });
  const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
  const loggedOut = (res.status >= 300 && res.status < 400) ||
    (text.includes('name="account"') && text.includes('name="password"'));
  if (loggedOut && allowRetry) {
    webSessions.delete(user.account);
    await webLogin(env, user);
    return webFetch(env, user, path, init, false);
  }
  return { status: res.status, text };
}

async function uploadImageWeb(env, user, bytes, filename, mime) {
  const boundary = '----ztmcp' + Date.now().toString(36);
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="imgFile"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const res = await webFetch(env, user, '/file-ajaxUpload.html', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  let data;
  try { data = JSON.parse(res.text); } catch { data = { error: 1, message: '上传响应异常: ' + res.text.slice(0, 120) }; }
  if (data.error !== 0 || !data.url) {
    throw Object.assign(new Error('图片上传失败: ' + JSON.stringify(data).slice(0, 200)), { code: 'UPLOAD_FAILED' });
  }
  return data.url; // site-relative, e.g. /zentao/file-read-302.png — use verbatim
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the steps HTML: description (plain text or HTML) with optional
// [截图:N] / [图:N] markers replaced by the uploaded images; unreferenced
// images are appended in a 问题截图 section.
function buildStepsHtml(description, uploaded, sectionTitle) {
  let html = String(description ?? '').trim();
  if (/<p[ >]|<img|<br/i.test(html)) {
    html = html; // already HTML-ish, keep as-is
  } else {
    html = html.split(/\n{2,}/).map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br/>') + '</p>').join('');
  }
  const used = new Set();
  html = html.replace(/\[\s*截图\s*[:：]?\s*(\d+)\s*\]|\[\s*图\s*[:：]?\s*(\d+)\s*\]/g, (m0, n1, n2) => {
    const n = Number(n1 || n2) - 1; // 标记编号 = 用户传入 images[] 的原始位置（1 起）
    // 必须按 inputIndex 匹配：uploaded[] 只含成功项，若用 n-1 直接索引，前图失败时会
    // 错位（把第 2 张图插进 [截图:1]）；标记指向失败图时删除标记，不换别的图、不留字面文本。
    const img = uploaded.find(u => u.inputIndex === n);
    if (!img) return '';
    used.add(n);
    return `<img src="${img.url}" alt="${escapeHtml(img.alt)}" />`;
  });
  const rest = uploaded.filter(u => !used.has(u.inputIndex));
  if (rest.length) {
    html += '<p><strong>' + escapeHtml(sectionTitle || '问题截图') + '：</strong></p>' + rest.map(img => `<img src="${img.url}" alt="${escapeHtml(img.alt)}" />`).join('');
  }
  return html;
}

// ===========================================================================
// 统一图片模块（create_bug / update_bug / create_task / update_task 共用）
// 规范化 -> 校验 -> 解码 -> 上传禅道 -> 内嵌 HTML，任何单张失败不影响其它图。
// ===========================================================================
// data URL 前缀：容忍任意 mime 参数（charset 等）与大小写 BASE64。
// 旧实现 /^data:[^;]+;base64,/ 遇 data:image/png;charset=utf-8;base64, 剥不掉前缀，
// atob 直接炸 "invalid base64" —— 这是大图上传失败的根因之一。
const DATA_URL_RE = /^data:[^,]*;base64,/i;

// Base64 规范化：剥 data URL 前缀、去换行/CR/空格、URL-safe 变体（- _）还原为 + /、
// 剥包裹引号；不触碰合法的 + / =。解码用手写字典表（Cloudflare Worker 无 Node Buffer；
// atob 对任意长度/变体不稳且报错无诊断——之前 100KB 图就是在这里炸的）。
function normalizeBase64(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(DATA_URL_RE, '');
  s = s.replace(/[\r\n\s\u00a0]+/g, '');
  s = s.replace(/^["']+/, '').replace(/["']+$/, '');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const stripped = s.replace(/=+$/, '');
  if (!stripped) return { error: 'BASE64_EMPTY', message: 'base64 内容为空' };
  if (!/^[A-Za-z0-9+/]*$/.test(stripped)) {
    const bad = stripped.match(/[^A-Za-z0-9+/]/);
    return { error: 'BASE64_INVALID_CHARS', message: 'base64 含非法字符 ' + JSON.stringify(bad && bad[0]) + '（位置 ' + (bad ? stripped.indexOf(bad[0]) : '?') + '；仅允许 A-Z a-z 0-9 + / = 与换行空白，+ / = 不会被错误剥离）' };
  }
  if (stripped.length % 4 === 1) {
    return {
      error: 'BASE64_TRUNCATED',
      message: 'base64 长度 ' + stripped.length + ' 非法（mod 4 = 1，典型为传输截断/丢尾部）；请检查调用链路是否截断长字符串，或改用 url 方式传图',
    };
  }
  return { base64: stripped + '='.repeat((4 - (stripped.length % 4)) % 4) };
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

// 严格 base64 -> Uint8Array。字典表解码；非法字符/padding 报诊断错误码。
function decodeBase64Bytes(b64) {
  const core = b64.replace(/=+$/, '');
  const rem = core.length % 4;
  const outLen = (core.length >> 2) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < core.length; i += 4) {
    const c0 = B64_LOOKUP[core.charCodeAt(i)];
    const c1 = i + 1 < core.length ? B64_LOOKUP[core.charCodeAt(i + 1)] : -1;
    const c2 = i + 2 < core.length ? B64_LOOKUP[core.charCodeAt(i + 2)] : -1;
    const c3 = i + 3 < core.length ? B64_LOOKUP[core.charCodeAt(i + 3)] : -1;
    if (c0 < 0 || c1 < 0) throw Object.assign(new Error('base64 解码失败：内容在解码中途损坏'), { code: 'BASE64_MALFORMED' });
    if (c2 >= 0) out[o++] = (c0 << 2) | (c1 >> 4);
    else { out[o++] = (c0 << 2) | (c1 >> 4); break; }
    if (c3 >= 0) { out[o++] = ((c1 & 15) << 4) | (c2 >> 2); out[o++] = ((c2 & 3) << 6) | c3; }
    else if (c2 >= 0) { out[o++] = ((c1 & 15) << 4) | (c2 >> 2); break; }
  }
  return out;
}

// 魔数嗅探：png/jpg/gif/webp/bmp，识别不出返回 null（宽容，不拦截未知二进制）。
function sniffImageExt(bytes) {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

// images[] 规范化校验（不碰网络）：url / base64 二选一；file/filePath/fileUrl 仅识别
// ——MCP streamable-HTTP 协议无通用文件句柄，拿不到连接器文件字节，统一报
// FILE_REF_UNSUPPORTED 并提示改用 url（优先）或 base64（兜底）。
function normalizeImageInput(item, index) {
  const spec = (item && typeof item === 'object') ? item : null;
  if (!spec) return { error: 'INVALID_IMAGE_ITEM', message: 'images[' + index + '] 不是对象' };
  const name = String(spec.filename || spec.name || ('截图' + (index + 1)));
  const hasUrl = typeof spec.url === 'string' && spec.url.trim() !== '';
  const hasB64 = typeof spec.base64 === 'string' && spec.base64.trim() !== '';
  const fileRef = spec.file !== undefined ? spec.file : (spec.filePath !== undefined ? spec.filePath : spec.fileUrl);
  // url 与 base64 同传时按优先级取 url（公网地址优先，base64 只是兜底），不算错误
  if (!hasUrl && !hasB64 && fileRef === undefined) {
    return { error: 'MISSING_SOURCE', message: '图片 ' + name + ' 缺少 url / base64（url 优先，base64 兜底）' };
  }
  if (!hasUrl && !hasB64 && fileRef !== undefined) {
    return { error: 'FILE_REF_UNSUPPORTED', message: '图片 ' + name + ' 用了 file/filePath/fileUrl：MCP 协议无通用文件句柄，连接器拿不到文件字节。请改用 url（公网可访问，优先）或 base64（兜底）' };
  }
  const anyExt = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  const extHint = anyExt ? anyExt.toLowerCase() : null;
  if (extHint && !IMAGE_EXTS.includes(extHint)) {
    return { error: 'UNSUPPORTED_EXT', message: '不支持的图片格式 .' + extHint + '（仅支持 ' + IMAGE_EXTS.join('/') + '）' };
  }
  return { name: name, url: hasUrl ? spec.url.trim() : null, base64: hasB64 ? spec.base64 : null, alt: spec.alt || name, extHint: extHint };
}

// 读取图片字节（base64 解码 或 URL 下载），统一 size / ext / 魔数校验。
async function loadImageBytes(item, index) {
  const norm = normalizeImageInput(item, index);
  if (norm.error) throw Object.assign(new Error(norm.message), { code: norm.error });
  let bytes, fromUrl = null, ctype = '';

  // 来源优先级：url（公网地址）优先，base64 兜底——两者同传时走 url
  if (norm.url) {
    let res;
    try {
      res = await fetch(norm.url, { headers: { 'User-Agent': UA } });
    } catch (e) {
      throw Object.assign(new Error('图片 ' + norm.name + ' 下载失败：' + ((e && e.message) || e) + '（URL 需公网可匿名访问）'), { code: 'DOWNLOAD_FAILED' });
    }
    if (!res.ok) throw Object.assign(new Error('图片 ' + norm.name + ' 下载失败（HTTP ' + res.status + '，URL 需公网可匿名访问）'), { code: 'DOWNLOAD_FAILED' });
    bytes = new Uint8Array(await res.arrayBuffer());
    fromUrl = norm.url;
    ctype = (res.headers.get('content-type') || '').toLowerCase();
  } else {
    const n = normalizeBase64(norm.base64);
    if (n.error) throw Object.assign(new Error(n.message), { code: n.error });
    // 解码前先按 base64 长度预判体积：超限直接拒绝，避免为注定失败的大图白烧解码 CPU
    const approx = Math.floor(n.base64.length / 4) * 3;
    if (approx > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error('图片 ' + norm.name + ' 过大（约 ' + approx + ' 字节，上限 ' + MAX_IMAGE_BYTES + '）'), { code: 'IMAGE_TOO_LARGE' });
    }
    bytes = decodeBase64Bytes(n.base64);
  }

  if (bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('图片 ' + norm.name + ' 过大（' + bytes.length + ' 字节，上限 ' + MAX_IMAGE_BYTES + '）'), { code: 'IMAGE_TOO_LARGE' });
  }
  if (bytes.length === 0) {
    throw Object.assign(new Error('图片 ' + norm.name + ' 解码结果为空'), { code: 'IMAGE_EMPTY' });
  }

  // 扩展名：显式 filename 优先；URL path / content-type 推断次之；魔数兜底纠偏
  let ext = norm.extHint;
  if (!ext && fromUrl) {
    ext = (/\.(png|jpe?g|gif|bmp|webp)(?:$|[?#])/i.exec(fromUrl) || [])[1];
    ext = ext ? ext.toLowerCase() : null;
    if (!ext && ctype.indexOf('image/') === 0) {
      const c = ctype.split('/')[1].split(';')[0];
      if (IMAGE_EXTS.includes(c)) ext = c === 'jpeg' ? 'jpg' : c;
    }
  }
  const sniffed = sniffImageExt(bytes);
  if (sniffed) {
    if (!norm.extHint && ext && ext !== sniffed && !(ext === 'jpg' && sniffed === 'jpg') && !(ext === 'jpeg' && sniffed === 'jpg')) {
      ext = sniffed; // URL/content-type 与实际字节不符时以字节为准
    }
    if (!ext) ext = sniffed;
    if (norm.extHint && sniffed
        && !(norm.extHint === sniffed)
        && !(norm.extHint === 'jpg' && sniffed === 'jpg')
        && !(norm.extHint === 'jpeg' && sniffed === 'jpg')) {
      throw Object.assign(new Error('图片 ' + norm.name + ' 声明扩展名 .' + norm.extHint + ' 但实际字节是 .' + sniffed + '（请修正 filename 扩展名）'), { code: 'EXT_MISMATCH' });
    }
  }
  if (!ext) ext = 'png';
  const canonicalExt = ext === 'jpeg' ? 'jpg' : ext;
  return {
    bytes: bytes,
    filename: norm.extHint ? norm.name : norm.name + '.' + canonicalExt,
    mime: 'image/' + (canonicalExt === 'jpg' ? 'jpeg' : canonicalExt),
    alt: norm.alt,
  };
}

// 上传 + 内嵌一体化（Bug/Task 共用）。上传走 web 通道（file-ajaxUpload，imgFile 字段，
// 已验证 file-read-N 相对 URL），内嵌走 buildStepsHtml 的 [截图:N] 标记 / 截图区。
async function uploadObjectImages(env, user, images) {
  const uploaded = [];
  const failures = [];
  let idx = 0;
  for (const item of (images || [])) {
    try {
      const loaded = await loadImageBytes(item, idx);
      // 禅道 21.7 file-ajaxUpload 按「文件名扩展名」查图片白名单（png/jpg/jpeg/gif/bmp，
      // 不含 webp）：白名单外一律落 file-read-N.txt + octet-stream（<img> 渲染无保障）。
      // webp 字节挂 .png 传输名实测落 image/png（2026-09-24 探针），浏览器 <img> 按魔数
      // 解码照常显示；uploaded[].filename 仍保留用户原始名（展示用）。
      const isWebp = /\.webp$/i.test(loaded.filename);
      const transportName = isWebp ? loaded.filename.replace(/\.webp$/i, '.png') : loaded.filename;
      const transportMime = isWebp ? 'image/png' : loaded.mime;
      let url;
      try {
        url = await uploadImageWeb(env, user, loaded.bytes, transportName, transportMime);
      } catch (upErr) {
        if (!upErr.code) upErr.code = 'UPLOAD_FAILED'; // 登录/网络类异常也归入上传失败，不漏成 UNKNOWN
        throw upErr;
      }
      uploaded.push({ url: url, filename: loaded.filename, alt: loaded.alt || loaded.filename, inputIndex: idx });
    } catch (err) {
      failures.push({
        index: idx,
        filename: (item && (item.filename || item.name)) || ('截图' + (idx + 1)),
        reason: (err && err.code) || 'UNKNOWN',
        message: (err && err.message) || String(err),
      });
    }
    idx++;
  }
  return { uploaded: uploaded, failures: failures };
}

// 兼容旧名
const uploadBugImages = uploadObjectImages;

// 统一图片结果块：images: {requested, uploaded, embedded, failed}。
// embedCheck=回读的富文本原文，逐图核对 <img src> 是否真实内嵌；failed.reason 统一为错误码
// （BASE64_INVALID_CHARS / IMAGE_TOO_LARGE / EXT_MISMATCH / FILE_REF_UNSUPPORTED …）。
// 单图失败不影响其它图与对象本身；uploaded=0 或部分失败时给出 warnings（规格六）。
function imageResult(userAttempted, uploaded, failures, embedCheck) {
  const embedded = uploaded.filter(u => !embedCheck || embedCheck.includes(u.url)).length;
  const images = {
    requested: userAttempted,
    uploaded: uploaded.length,
    embedded,
    failed: failures.map(f => ({ index: f.index, filename: f.filename, reason: f.reason, message: f.message })),
  };
  const warnings = [];
  if (userAttempted > 0 && uploaded.length === 0) {
    warnings.push('用户传了 ' + userAttempted + ' 张图片但全部未上传成功（uploaded=0），正文中没有图片，详见 images.failed');
  } else if (failures.length) {
    warnings.push('部分图片未成功（失败 ' + failures.length + '/' + userAttempted + '），详见 images.failed');
  }
  if (uploaded.length && embedded < uploaded.length) {
    warnings.push('有 ' + (uploaded.length - embedded) + ' 张图已上传禅道文件系统但未在正文中检索到，可能被服务端剥离，请在网页端核实');
  }
  return { images, warnings };
}

// images[] 数组项 schema（四个工具共用）：来源优先级 1.file/filePath/fileUrl 文件引用
// （MCP streamable-HTTP 无通用文件句柄，识别后报 FILE_REF_UNSUPPORTED）2.url 公网地址 3.base64 兜底。
const IMAGE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: '图片 URL，需公网可匿名访问（与 base64 二选一；两者都有优先 url）' },
    base64: { type: 'string', description: '图片 base64（与 url 二选一）。可带 data:image/png;base64, 前缀（mime 带 charset 等参数亦可），可含换行/空格，支持 URL-safe 变体' },
    filename: { type: 'string', description: '文件名（决定扩展名，支持中文），默认 截图N.png' },
    alt: { type: 'string', description: '图片 alt 描述' },
    file: { type: 'string', description: '本地文件引用：MCP 协议无文件句柄暂不支持（返回 FILE_REF_UNSUPPORTED），请改用 url 或 base64' },
    filePath: { type: 'string', description: '同 file' },
    fileUrl: { type: 'string', description: '同 file' },
  },
};

function imagesSchema(target) {
  return {
    type: 'array',
    description: '截图列表，真实上传到禅道文件系统并内嵌到' + target + '富文本（不是普通附件，详情页直接可见）。' +
      '来源优先级：1.file/filePath/fileUrl 文件引用（当前 MCP 协议无文件句柄，暂不支持，会返回 FILE_REF_UNSUPPORTED）2.url 公网图片地址 3.base64（兜底，稳定解码）。' +
      '支持 png/jpg/jpeg/gif/bmp/webp，单图 ≤9MB。' + target + '中用 [截图:1]、[截图:2] 标记指定插入位置；未标记的图统一追加到「问题截图」（关联需求的任务为「参考截图」）区。' +
      '单图失败不影响其它图，返回 images.failed 明细（filename + reason）。',
    items: IMAGE_ITEM_SCHEMA,
  };
}

// Web-form bug create/edit. Returns { ok, data } like ztFetch.
async function webSaveBug(env, user, path, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { for (const item of v) body.append(k, String(item)); }
    else body.append(k, String(v));
  }
  const res = await webFetch(env, user, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  let data;
  try { data = JSON.parse(res.text); } catch { data = { result: 'fail', message: '网页保存响应异常: ' + res.text.slice(0, 150) }; }
  const failed = data.result === 'fail' || !!data.error;
  return { status: res.status, ok: !failed, data };
}

async function resolveCreatedBugId(env, user, productID, title) {
  const list = await ztFetch(env, user, `/products/${productID}/bugs`, { query: { limit: 5, orderBy: 'id_desc' } });
  for (const b of list.data?.bugs || []) {
    if (b.title === title && !b.deleted) return b.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// State actions + notification support layer.
// API facts verified live against ZenTao 21.7 (2026-09-22):
//   Task:  finish   POST /tasks/{id}/finish  {realStarted, finishedDate, currentConsumed, comment}
//                     — realStarted/finishedDate required; currentConsumed required
//                       when total consumed would be 0 ("总计消耗为0时不能完成任务")
//          close    POST /tasks/{id}/close   {comment}  — works from wait/done/cancel
//          cancel   WEB  POST /task-cancel-{id}.html   {comment}
//                     (REST /tasks/{id}/cancel = 404; PUT {status:'cancel'} works but
//                      records only "edited" and loses the comment)
//          activate WEB  POST /task-activate-{id}.html {comment, status:'wait', assignedTo, left}
//                     (closed → activate via PUT {status:'wait', assignedTo, left, closedReason:''})
//   Bug:   resolve  POST /bugs/{id}/resolve  {resolution, resolvedBuild, assignedTo, comment}
//                     — resolvedBuild required; resolution is NOT validated server-side
//                       (garbage is accepted), so we whitelist the real enum ourselves:
//                       bydesign/duplicate/external/fixed/notrepro/postponed/willnotfix
//          close    POST /bugs/{id}/close    {comment}  — works from active AND resolved
//          activate WEB  POST /bug-activate-{id}.html
//                     {comment, openedBuild, assignedTo, resolution:'', resolvedBuild:''}
//                     — openedBuild required; empty resolution/resolvedBuild clear the
//                       old values (works from resolved AND closed)
//          cancel:  DOES NOT EXIST (REST 404 twice, no canceled status) — never faked;
//                   map 不做/重复/设计如此 to resolve_bug resolution.
//   Readback + actions[] verification is mandatory on every action: several routes
//   answer HTTP 200 with an empty body and change nothing (fake success).
// ---------------------------------------------------------------------------

const RESOLUTIONS = ['bydesign', 'duplicate', 'external', 'fixed', 'notrepro', 'postponed', 'willnotfix'];
const RESOLUTION_LABELS = {
  bydesign: '设计如此', duplicate: '重复Bug', external: '外部原因', fixed: '已解决',
  notrepro: '无法重现', postponed: '延期处理', willnotfix: '不予解决',
};
const NOTIFY_EVENTS = ['assigned', 'reassigned', 'finished', 'closed', 'canceled', 'activated'];

function nowCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
}
function accOf(v) {
  return typeof v === 'object' && v !== null ? (v.account ?? null) : (v || null);
}
function realnameOf(v) {
  return typeof v === 'object' && v !== null ? (v.realname ?? '') : '';
}
function objectUrl(env, objectType, id) {
  return W_BASE(env) + (objectType === 'bug' ? `/bug-view-${id}.html` : `/task-view-${id}.html`);
}
function notificationKey(objectType, objectID, event, account) {
  return `${objectType}:${objectID}:${event}:${account}`;
}
function parseNotificationKey(key) {
  const m = /^(bug|task):(\d+):(assigned|reassigned|finished|closed|canceled|activated):([A-Za-z0-9_.-]+)$/.exec(String(key || ''));
  return m ? { objectType: m[1], objectID: Number(m[2]), event: m[3], account: m[4] } : null;
}
// event 未传时按对象当前状态推导默认事件。
function defaultEvent(objectType, obj) {
  const s = obj?.status;
  if (objectType === 'bug') {
    return s === 'resolved' ? 'finished' : s === 'closed' ? 'closed' : 'assigned';
  }
  return s === 'done' ? 'finished' : s === 'closed' ? 'closed' : s === 'cancel' ? 'canceled' : 'assigned';
}

// 联系人配置：ZT_CONTACTS env JSON（最简可靠）。禅道用户 email 非空时优先用禅道的。
// { "wanganqing": {"realname":"王安庆","email":"...","enabled":true}, ... }
function contactConfig(env) {
  try {
    const raw = JSON.parse(env.ZT_CONTACTS || '{}');
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      const email = typeof v.email === 'string' && v.email.includes('@') ? v.email : null;
      out[String(k).toLowerCase()] = {
        realname: v.realname ?? '',
        email,
        enabled: v.enabled !== false,
      };
    }
    return out;
  } catch { return {}; }
}

function usersRows(data) {
  if (Array.isArray(data)) return data;
  const inner = data?.data;
  if (Array.isArray(inner)) return inner;
  if (Array.isArray(inner?.users)) return inner.users;
  return data?.users || data?.list || [];
}

async function findUserRow(env, user, account) {
  const res = await ztFetch(env, user, '/users', { query: { limit: 100 } });
  if (!res.ok) return null;
  const rows = usersRows(res.data);
  const want = String(account).toLowerCase();
  return rows.find((r) => String(r.account).toLowerCase() === want) || null;
}

// get_user_contact 的核心：禅道 email 优先，其次 ZT_CONTACTS，绝不猜邮箱。
async function resolveContact(env, user, account) {
  const row = await findUserRow(env, user, account);
  if (!row) return { error: 'USER_NOT_FOUND', account };
  const cfg = contactConfig(env)[String(account).toLowerCase()] || {};
  const ztEmail = typeof row.email === 'string' && row.email.includes('@') ? row.email : null;
  const cfgEmail = cfg.enabled === false ? null : cfg.email;
  const email = ztEmail ?? cfgEmail ?? null;
  if (!email) {
    return { account: row.account ?? account, realname: row.realname || cfg.realname || '', email: null, emailEnabled: false, reason: 'NO_EMAIL_CONFIGURED' };
  }
  return { account: row.account ?? account, realname: row.realname || cfg.realname || '', email, emailEnabled: true, source: ztEmail ? 'zentao' : 'notification_config' };
}

// 通知台账：ZT_USERS KV，key = notification:{notificationKey}，跨请求/跨 isolate 持久。
// isolate 内读己之写缓存（Map，随 isolate 存亡）：KV 读对「不存在」有约 60s 边缘负缓存，
// 刚写入的台账在同 isolate 随后读取可能拿到旧的 null —— 那会绕过 NOTIFICATION_ALREADY_RECORDED
// 幂等分支、真实重复发邮件（2026-09-22 回归实测踩坑）。缓存只加速读，正确性始终以 KV 为准。
const notifMem = new Map(); // notificationKey -> record | null
async function notifGet(env, key) {
  if (!env.ZT_USERS) return null;
  if (notifMem.has(key)) return notifMem.get(key);
  try {
    const raw = await env.ZT_USERS.get('notification:' + key);
    const rec = raw ? JSON.parse(raw) : null;
    notifMem.set(key, rec);
    return rec;
  } catch (err) {
    // 台账读取失败必须报出来，绝不静默当成「未发送」——那是重复发邮件的根源
    throw new Error(`通知台账读取失败（${err?.message ?? err}），无法确认是否已发送，本次操作结果未确认`);
  }
}
async function notifPut(env, key, record) {
  if (!env.ZT_USERS) throw new Error('通知台账需要 ZT_USERS KV 绑定（wrangler.jsonc kv_namespaces）');
  await env.ZT_USERS.put('notification:' + key, JSON.stringify(record));
  notifMem.set(key, record);
}

// 禅道对象提取：形状无关 + 按 id 校验。绝不能写 `data?.task ?? data` —— Bug 对象
// 顶层带整数字段 task:0（关联任务 ID），`??` 遇 0 不回退，会把数字 0 当成对象，
// 导致 id 匹配永远失败、假报 NOT_FOUND（2026-09-22 实测踩坑）。
function pickObj(data, id) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['bug', 'task', 'story', 'execution', 'project', 'product']) {
    const v = data[key];
    if (v && typeof v === 'object' && (id === undefined || Number(v.id) === Number(id))) return v;
  }
  if (data.id !== undefined && (id === undefined || Number(data.id) === Number(id))) return data;
  return null;
}

async function readObject(env, user, objectType, id) {
  const res = await ztFetch(env, user, `/${objectType === 'bug' ? 'bugs' : 'tasks'}/${id}`);
  // 源站 5xx / HTML 错误页不是"对象不存在"——绝不能误报 NOT_FOUND（2026-09-22 实测：
  // 源站抖动时 520 会让"Bug 还在却报不存在"，上层可能据此做出错误结论）。
  if (res.status >= 500 || res.data?.nonJsonResponse) {
    throw new Error(`禅道源站异常（HTTP ${res.status}），无法读取 ${objectType} ${id}，本次操作结果未确认，请稍后用 get_${objectType} 回读核实`);
  }
  const obj = pickObj(res.data, id);
  return { res, obj: res.ok && obj && Number(obj.id) === Number(id) ? obj : null };
}

function hasAction(obj, action) {
  return (obj?.actions || []).some((x) => x.action === action);
}
function actionEntry(obj, action) {
  return [...(obj?.actions || [])].reverse().find((x) => x.action === action) || null;
}

// 状态动作统一收口：校验清单 -> 不通过报 ACTION_NOT_APPLIED（绝不假成功）。
// actor 字段（finishedBy/closedBy/...）若被服务端写入则必须等于当前连接器账号。
function verifyAction(obj, { status, actorField, action, comment }, user) {
  const problems = [];
  if (status && obj.status !== status) problems.push(`status 回读为 ${obj.status}（期望 ${status}）`);
  if (action && !hasAction(obj, action)) problems.push(`动作历史缺少 ${action} 记录`);
  if (actorField) {
    const actor = accOf(obj[actorField]);
    if (actor && actor !== user.account) problems.push(`${actorField}=${actor}（期望 ${user.account}）`);
    if (!actor) problems.push(`${actorField} 未写入`);
  }
  if (comment !== undefined && comment !== null && String(comment).trim()) {
    const entry = action && actionEntry(obj, action);
    if (entry && String(entry.comment ?? '').trim() !== String(comment).trim()) {
      problems.push(`动作备注未保存（回读 ${JSON.stringify(entry.comment ?? '')}）`);
    }
  }
  return problems;
}

function actionSummary(objectType, obj) {
  const base = {
    id: obj.id,
    title: objectType === 'bug' ? obj.title : obj.name,
    status: obj.status,
    assignedTo: accOf(obj.assignedTo),
    assignedToRealName: realnameOf(obj.assignedTo),
  };
  if (objectType === 'bug') {
    return { ...base, resolution: obj.resolution, resolvedBy: accOf(obj.resolvedBy), closedBy: accOf(obj.closedBy),
      resolvedDate: obj.resolvedDate, closedDate: obj.closedDate, activatedCount: obj.activatedCount };
  }
  return { ...base, finishedBy: accOf(obj.finishedBy), closedBy: accOf(obj.closedBy), canceledBy: accOf(obj.canceledBy),
    finishedDate: obj.finishedDate, closedDate: obj.closedDate, canceledDate: obj.canceledDate,
    consumed: obj.consumed, left: obj.left };
}

function actionResult(env, objectType, obj, event) {
  const acc = accOf(obj.assignedTo);
  const key = acc ? notificationKey(objectType, obj.id, event, acc) : null;
  return {
    status: 200,
    ok: true,
    data: {
      success: true,
      [objectType]: actionSummary(objectType, obj),
      notificationKeySuggestion: key,
      notificationHint: key
        ? `如需通知：get_notification_context(objectType="${objectType}", objectID=${obj.id}, event="${event}") → get_notification_status → 由 ChatGPT 判断并经 Gmail 发送 → record_notification`
        : '该对象当前无负责人，无可通知对象',
    },
  };
}

// 创建/修改类返回里的通知提示字段（与 actionResult 保持同一约定）。
function notifHint(objectType, id, event, acc) {
  const key = acc ? notificationKey(objectType, id, event, acc) : null;
  return {
    notificationKeySuggestion: key,
    notificationHint: key
      ? `如需通知：get_notification_context(objectType="${objectType}", objectID=${id}, event="${event}") → get_notification_status → 由 ChatGPT 判断并经 Gmail 发送 → record_notification`
      : '该对象当前无负责人，无可通知对象',
  };
}

// 网页表单动作（保留空字符串值：bug-activate 需要 resolution:''/resolvedBuild:'' 来清空旧值）。
async function webFormPost(env, user, path, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    body.append(k, String(v));
  }
  const res = await webFetch(env, user, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  let data;
  try { data = JSON.parse(res.text); } catch { data = { result: 'fail', message: '网页保存响应异常: ' + res.text.slice(0, 150) }; }
  return { status: res.status, ok: data.result !== 'fail' && !data.error, data };
}

// ---------------------------------------------------------------------------

const pager = {
  limit: { type: 'integer', description: '每页条数，默认 20，最大 100' },
  page: { type: 'integer', description: '页码，从 1 开始' },
};

const TOOLS = [
  {
    name: 'list_products',
    title: '产品列表',
    description: '列出禅道全部产品（含 id、名称、类型、状态）',
    inputSchema: { type: 'object', properties: pager },
    run: (env, user, a) => ztFetch(env, user, '/products', { query: { limit: a.limit, page: a.page } }),
  },
  {
    name: 'list_projects',
    title: '项目列表',
    description: '列出禅道全部项目（含 id、名称、状态）',
    inputSchema: { type: 'object', properties: pager },
    run: (env, user, a) => ztFetch(env, user, '/projects', { query: { limit: a.limit, page: a.page } }),
  },
  {
    name: 'list_executions',
    title: '执行/迭代列表',
    description: '列出执行（迭代/冲刺），可按项目过滤。字段含 id、name、project、begin、end、status、progress',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'integer', description: '按项目 ID 过滤' }, ...pager },
    },
    run: (env, user, a) => ztFetch(env, user, '/executions', { query: { limit: a.limit, page: a.page } }),
  },
  {
    name: 'list_stories',
    title: '需求列表',
    description: '列出某产品下的需求。status 可选：active 激活 / draft 草稿 / closed 已关闭 / changed 已变更',
    inputSchema: {
      type: 'object',
      properties: {
        productID: { type: 'integer', description: '产品 ID' },
        status: { type: 'string', description: '按状态过滤（可选）' },
        ...pager,
      },
      required: ['productID'],
    },
    run: (env, user, a) =>
      ztFetch(env, user, `/products/${a.productID}/stories`, {
        query: { status: a.status, limit: a.limit, page: a.page },
      }),
  },
  {
    name: 'list_tasks',
    title: '任务列表',
    description: '列出某执行（迭代）下的任务。status 可选：wait 未开始 / doing 进行中 / done 已完成 / closed 已关闭',
    inputSchema: {
      type: 'object',
      properties: {
        executionID: { type: 'integer', description: '执行（迭代）ID' },
        status: { type: 'string', description: '按状态过滤（可选）' },
        ...pager,
      },
      required: ['executionID'],
    },
    run: (env, user, a) =>
      ztFetch(env, user, `/executions/${a.executionID}/tasks`, {
        query: { status: a.status, limit: a.limit, page: a.page },
      }),
  },
  {
    name: 'list_bugs',
    title: 'Bug 列表',
    description: '列出某产品下的 Bug',
    inputSchema: {
      type: 'object',
      properties: {
        productID: { type: 'integer', description: '产品 ID' },
        status: { type: 'string', description: '按状态过滤：active 激活 / resolved 已解决 / closed 已关闭' },
        ...pager,
      },
      required: ['productID'],
    },
    run: (env, user, a) =>
      ztFetch(env, user, `/products/${a.productID}/bugs`, {
        query: { status: a.status, limit: a.limit, page: a.page },
      }),
  },
  {
    name: 'list_users',
    title: '用户列表',
    description: '列出禅道用户（真实账号 realname 与 account）。指派任务/需求前先用它查账号',
    inputSchema: { type: 'object', properties: pager },
    run: (env, user, a) => ztFetch(env, user, '/users', { query: { limit: a.limit, page: a.page } }),
  },
  {
    name: 'get_story',
    title: '需求详情',
    description: '按 ID 获取需求详情（描述、验收标准、阶段、负责人等）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '需求 ID' } },
      required: ['id'],
    },
    run: (env, user, a) => ztFetch(env, user, `/stories/${a.id}`),
  },
  {
    name: 'get_task',
    title: '任务详情',
    description: '按 ID 获取任务详情',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '任务 ID' } },
      required: ['id'],
    },
    run: (env, user, a) => ztFetch(env, user, `/tasks/${a.id}`),
  },
  {
    name: 'get_bug',
    title: 'Bug 详情',
    description: '按 ID 获取 Bug 详情',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Bug ID' } },
      required: ['id'],
    },
    run: (env, user, a) => ztFetch(env, user, `/bugs/${a.id}`),
  },
  {
    name: 'create_bug',
    title: '创建Bug',
    description:
      '在产品下创建 Bug 并指派给处理人，默认挂到所属项目（不传 projectID 时按服务端配置的产品->项目默认映射；无映射的产品必须显式传 projectID，不允许创建 project=0 的产品级 Bug）。' +
      '创建后会回读禅道校验关键字段（标题/产品/项目/指派人）是否真正保存，未保存会删除该 Bug 并返回失败原因。' +
      '支持 images 截图列表：图片直接内嵌到重现步骤富文本中（不是附件），开发打开 Bug 详情即可看到。' +
      'openedBuild 固定为主干 trunk；openedBy 由禅道固定为连接器服务账号（不允许代他人提交），返回值中会标注实际创建者。' +
      'type 可选：codeerror 代码错误 / config 配置相关 / install 安装部署 / security 安全相关 / performance 性能问题 / standard 标准规范 / automation 测试脚本 / designdefect 设计缺陷 / others 其他',
    inputSchema: {
      type: 'object',
      properties: {
        productID: { type: 'integer', description: '产品 ID' },
        projectID: { type: 'integer', description: '所属项目 ID；未传时按服务端默认映射，无映射则必填' },
        title: { type: 'string', description: 'Bug 标题' },
        description: { type: 'string', description: 'Bug 描述/重现步骤（含操作步骤、实际结果、预期结果）' },
        assignedTo: { type: 'string', description: '指派给（禅道账号，非中文姓名；账号无效时禅道会静默丢弃，连接器会校验并报错）' },
        openedBy: { type: 'string', description: '仅作记录参考；禅道不允许代他人创建，实际创建者固定为连接器账号' },
        severity: { type: 'integer', description: '严重程度 1-4，默认 3' },
        priority: { type: 'integer', description: '优先级 1-4，默认 3' },
        type: { type: 'string', description: 'Bug 类型，默认 codeerror' },
        images: imagesSchema('重现步骤'),
      },
      required: ['productID', 'title', 'description', 'assignedTo'],
    },
    run: async (env, user, a) => {
      const title = String(a.title ?? '').trim();
      if (!title) {
        return { status: 400, ok: false, data: { error: 'title 不能为空' } };
      }
      // Business rule: bugs must hang off a project, never
      // project=0; the product->project default comes from ZT_PRODUCT_PROJECT_MAP.
      let projectID = a.projectID;
      if (projectID === undefined || projectID === null || projectID === '') {
        const mapped = projectMap(env)[String(a.productID)];
        if (mapped) {
          projectID = mapped;
        } else {
          return {
            status: 400,
            ok: false,
            data: {
              error: '请指定 projectID（所属项目）：不允许创建 project=0 的产品级 Bug。默认映射：' + (projectMapDesc(env) || '未配置') + '（由部署者通过 ZT_PRODUCT_PROJECT_MAP 配置）；项目可用 list_projects 查询。',
            },
          };
        }
      }
      // Server does NOT validate productID/projectID (it happily creates bugs pointing
      // at nonexistent ones), so preflight both ourselves.
      const prod = await ztFetch(env, user, `/products/${a.productID}`);
      if (!prod.ok || !prod.data || prod.data.error || Number(prod.data.id) !== Number(a.productID)) {
        return {
          status: prod.status,
          ok: false,
          data: { error: `产品 ${a.productID} 不存在或无法访问（禅道返回 ${prod.status}）` },
        };
      }
      const proj = await ztFetch(env, user, `/projects/${projectID}`);
      if (!proj.ok || !proj.data || proj.data.error || Number(proj.data.id) !== Number(projectID)) {
        return {
          status: proj.status,
          ok: false,
          data: { error: `项目 ${projectID} 不存在或无法访问（禅道返回 ${proj.status}）` },
        };
      }
      const productName = prod.data.name;

      // Images requested → web-form flow (the v1 API strips <img> from steps).
      if (Array.isArray(a.images) && a.images.length > 0) {
        let uploaded, failures;
        try {
          ({ uploaded, failures } = await uploadBugImages(env, user, a.images));
        } catch (err) {
          return { status: 500, ok: false, data: { reason: '图片流程失败: ' + (err?.message ?? String(err)) } };
        }
        const steps = buildStepsHtml(a.description ?? '', uploaded);
        const save = await webSaveBug(env, user, `/bug-create-${a.productID}-0-projectID=${projectID}.html`, {
          product: a.productID, branch: 0, project: projectID, execution: 0,
          module: 0, plan: 0, story: 0, storyVersion: 1,
          title, steps,
          type: a.type ?? 'codeerror', severity: a.severity ?? 3, pri: a.priority ?? 3,
          assignedTo: a.assignedTo, openedBuild: ['trunk'], keywords: '', mailto: [],
        });
        if (!save.ok) {
          return { status: 500, ok: false, data: { zentaoError: save.data, stage: 'web-create' } };
        }
        const bugId = await resolveCreatedBugId(env, user, a.productID, title);
        if (!bugId) {
          return { status: 500, ok: false, data: { reason: 'Bug 已创建但无法定位新 Bug ID，请在禅道网页确认', imageFailures: failures } };
        }
        const rb = await ztFetch(env, user, `/bugs/${bugId}`);
        const bug = pickObj(rb.data, bugId);
        const acc = typeof bug?.assignedTo === 'object' ? bug?.assignedTo?.account : bug?.assignedTo;
        const fieldsOk = bug && Number(bug.product) === Number(a.productID) &&
          Number(bug.project) === Number(projectID) && bug.title === title && acc === a.assignedTo;
        if (!fieldsOk) {
          const del = await ztFetch(env, user, `/bugs/${bugId}`, { method: 'DELETE' });
          return {
            status: 500,
            ok: false,
            data: {
              reason: `Bug 已创建（id=${bugId}）但关键字段未保存：assignedTo 回读为 ${acc ?? 'null'}（期望 ${a.assignedTo}），project 回读为 ${bug?.project ?? 'null'}（期望 ${projectID}）。${del.ok ? '该残留 Bug 已自动删除。' : '自动删除失败，请手动处理 Bug ' + bugId + '。'}`,
              readback: { assignedTo: bug?.assignedTo ?? null, project: bug?.project, product: bug?.product },
              autoDeleted: !!del.ok,
            },
          };
        }
        const { images: imgs, warnings: imgWarnings } = imageResult(a.images.length, uploaded, failures, String(bug?.steps ?? ''));
        const ob = typeof bug.openedBy === 'object' ? bug.openedBy : { account: bug.openedBy };
        const base = {
          httpStatus: 201,
          success: true,
          bug: {
            id: bug.id, title: bug.title, product: bug.product, productName,
            project: bug.project, assignedTo: acc, assignedToRealName: bug.assignedTo?.realname ?? '',
            openedBy: ob.account, openedByRealName: ob.realname ?? '',
            severity: bug.severity, pri: bug.pri, type: bug.type, status: bug.status,
          },
          images: imgs,
          ...(imgWarnings.length ? { warnings: imgWarnings } : {}),
          ...notifHint('bug', bug.id, 'assigned', acc),
          note: `openedBy 为当前连接器账号 ${user.account}：禅道以 API 登录账号记录创建人，不允许代他人提交。`,
        };
        if (failures.length || imgs.embedded < imgs.uploaded) {
          // 单图失败不使整体失败（规格六）：对象已创建即 success，失败明细走 images.failed + warnings
          return {
            status: 201,
            ok: true,
            data: { ...base, code: 'BUG_CREATED_IMAGE_FAILED', reason: 'Bug 已创建，但部分图片未成功内嵌，详见 images.failed 与 warnings' },
          };
        }
        return { status: 201, ok: true, data: base };
      }

      const created = await ztFetch(env, user, `/products/${a.productID}/bugs`, {
        method: 'POST',
        body: {
          title,
          steps: a.description ?? '',
          severity: a.severity ?? 3,
          pri: a.priority ?? 3,
          type: a.type ?? 'codeerror',
          openedBuild: ['trunk'],
          assignedTo: a.assignedTo,
          project: projectID,
        },
      });
      // ZenTao returns HTTP 200 with {"result":"fail"} on validation errors.
      if (!created.ok || created.data?.error || created.data?.result === 'fail') {
        return { status: created.status, ok: false, data: { zentaoError: created.data } };
      }
      const bugId = created.data.id;
      if (!bugId) {
        return { status: created.status, ok: false, data: { reason: '创建响应中没有 Bug ID', raw: created.data } };
      }
      // Readback: the server silently drops invalid assignedTo accounts, so a
      // 2xx response proves nothing — verify what actually persisted.
      const rb = await ztFetch(env, user, `/bugs/${bugId}`);
      const bug = pickObj(rb.data, bugId);
      const acc = typeof bug?.assignedTo === 'object' ? bug?.assignedTo?.account : bug?.assignedTo;
      const verified =
        bug && Number(bug.product) === Number(a.productID) && Number(bug.project) === Number(projectID) &&
        bug.title === title && acc === a.assignedTo;
      if (!verified) {
        const del = await ztFetch(env, user, `/bugs/${bugId}`, { method: 'DELETE' });
        return {
          status: created.status,
          ok: false,
          data: {
            reason:
              `Bug 已创建（id=${bugId}）但关键字段未保存：assignedTo 回读为 ${acc ?? 'null'}（期望 ${a.assignedTo}），project 回读为 ${bug?.project ?? 'null'}（期望 ${projectID}）。` +
              `常见原因是 assignedTo 不是有效的禅道账号，请用 list_users 核对后重试。${del.ok ? '该残留 Bug 已自动删除。' : '自动删除失败，请手动处理 Bug ' + bugId + '。'}`,
            readback: { assignedTo: bug?.assignedTo ?? null, project: bug?.project, product: bug?.product, title: bug?.title },
            autoDeleted: !!del.ok,
          },
        };
      }
      const ob = typeof bug.openedBy === 'object' ? bug.openedBy : { account: bug.openedBy };
      return {
        status: created.status,
        ok: true,
        data: {
          success: true,
          bug: {
            id: bug.id,
            title: bug.title,
            product: bug.product,
            productName,
            project: bug.project,
            assignedTo: acc,
            assignedToRealName: bug.assignedTo?.realname ?? '',
            openedBy: ob.account,
            openedByRealName: ob.realname ?? '',
            severity: bug.severity,
            pri: bug.pri,
            type: bug.type,
            status: bug.status,
          },
          ...notifHint('bug', bug.id, 'assigned', acc),
          note: `openedBy 为当前连接器账号 ${user.account}：禅道以 API 登录账号记录创建人，不允许代他人提交。`,
        },
      };
    },
  },
  {
    name: 'update_bug',
    title: '修改Bug',
    description:
      '修改 Bug（所属项目、指派、标题、描述、严重程度、优先级、类型），支持 images 截图列表（内嵌到重现步骤富文本，不是附件；新图追加到「问题截图」区，或配合 description 中的 [截图:N] 标记定位）。' +
      '修改 assignedTo/project 后会回读禅道校验是否真正保存，未生效则报失败。把 Bug 挂到项目用 projectID。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Bug ID' },
        projectID: { type: 'integer', description: '所属项目 ID' },
        assignedTo: { type: 'string', description: '指派给（禅道账号，非中文姓名）' },
        title: { type: 'string', description: 'Bug 标题' },
        description: { type: 'string', description: 'Bug 描述/重现步骤（完整替换；images 会内嵌其中）' },
        severity: { type: 'integer', description: '严重程度 1-4' },
        priority: { type: 'integer', description: '优先级 1-4' },
        type: { type: 'string', description: 'Bug 类型' },
        images: Object.assign(imagesSchema('重现步骤'), {
          description: imagesSchema('重现步骤').description + ' 不传 description 时新图追加到现有步骤末尾的「问题截图」区；传 description 时整段替换重现步骤。',
        }),
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      // Images → web-form edit flow (v1 API would strip the <img> tags).
      if (Array.isArray(a.images) && a.images.length > 0) {
        const cur = await ztFetch(env, user, `/bugs/${a.id}`);
        const curBug = pickObj(cur.data, a.id);
        if (!curBug?.id || cur.data?.error) {
          return { status: cur.status, ok: false, data: { error: `Bug ${a.id} 不存在或无法访问` } };
        }
        let uploaded, failures;
        try {
          ({ uploaded, failures } = await uploadBugImages(env, user, a.images));
        } catch (err) {
          return { status: 500, ok: false, data: { reason: '图片流程失败: ' + (err?.message ?? String(err)) } };
        }
        const baseDesc = a.description !== undefined ? a.description : String(curBug.steps ?? '');
        const steps = buildStepsHtml(baseDesc, uploaded);
        const save = await webSaveBug(env, user, `/bug-edit-${a.id}.html`, {
          product: curBug.product, branch: curBug.branch ?? 0, project: curBug.project, execution: curBug.execution ?? 0,
          module: curBug.module ?? 0, plan: curBug.plan ?? 0, story: curBug.story ?? 0, storyVersion: 1,
          title: a.title !== undefined ? String(a.title).trim() : curBug.title, steps,
          type: a.type ?? curBug.type,
          severity: a.severity ?? curBug.severity, pri: a.priority ?? curBug.pri,
          assignedTo: a.assignedTo ?? (typeof curBug.assignedTo === 'object' ? curBug.assignedTo?.account ?? '' : curBug.assignedTo ?? ''),
          openedBuild: ['trunk'], keywords: curBug.keywords ?? '',
          mailto: [], status: curBug.status ?? 'active', lastEditedDate: '',
        });
        if (!save.ok) {
          return { status: 500, ok: false, data: { zentaoError: save.data, stage: 'web-edit', note: '网页保存失败，Bug 未被改动' } };
        }
        const rb = await ztFetch(env, user, `/bugs/${a.id}`);
        const bug = pickObj(rb.data, a.id);
        const acc = typeof bug?.assignedTo === 'object' ? bug?.assignedTo?.account : bug?.assignedTo;
        const problems = [];
        const wantAssignee = a.assignedTo ?? (typeof curBug.assignedTo === 'object' ? curBug.assignedTo?.account : curBug.assignedTo);
        if (wantAssignee && acc !== wantAssignee) problems.push(`assignedTo 回读为 ${acc ?? 'null'}（期望 ${wantAssignee}）`);
        if (Number(bug?.project) !== Number(curBug.project)) problems.push(`project 回读为 ${bug?.project}（期望 ${curBug.project}）`);
        const { images: imgs, warnings: imgWarnings } = imageResult(a.images.length, uploaded, failures, String(bug?.steps ?? ''));
        if (problems.length) {
          return {
            status: 500,
            ok: false,
            data: { reason: '修改未生效：' + problems.join('；'), readback: { assignedTo: bug?.assignedTo ?? null, project: bug?.project } },
          };
        }
        const base = {
          httpStatus: 200,
          success: true,
          bug: { id: bug.id, title: bug.title, product: bug.product, project: bug.project, execution: bug.execution,
                 assignedTo: acc, assignedToRealName: bug.assignedTo?.realname ?? '', status: bug.status },
          images: imgs,
          ...(imgWarnings.length ? { warnings: imgWarnings } : {}),
          ...(a.assignedTo && a.assignedTo !== accOf(curBug.assignedTo) ? notifHint('bug', bug.id, 'reassigned', acc) : {}),
        };
        if (failures.length || imgs.embedded < imgs.uploaded) {
          // 单图失败不使整体失败（规格六）
          return { status: 200, ok: true, data: { ...base, code: 'BUG_CREATED_IMAGE_FAILED', reason: 'Bug 已更新，但部分图片未成功内嵌，详见 images.failed 与 warnings' } };
        }
        return { status: 200, ok: true, data: base };
      }
      const body = {};
      if (a.projectID !== undefined && a.projectID !== null && a.projectID !== '') body.project = a.projectID;
      if (a.assignedTo !== undefined && a.assignedTo !== '') body.assignedTo = a.assignedTo;
      if (a.title !== undefined) {
        const t = String(a.title).trim();
        if (!t) return { status: 400, ok: false, data: { error: 'title 不能为空' } };
        body.title = t;
      }
      if (a.description !== undefined) body.steps = a.description;
      if (a.severity !== undefined) body.severity = a.severity;
      if (a.priority !== undefined) body.pri = a.priority;
      if (a.type !== undefined) body.type = a.type;
      if (!Object.keys(body).length) {
        return { status: 400, ok: false, data: { error: '没有提供任何要修改的字段' } };
      }
      const res = await ztFetch(env, user, `/bugs/${a.id}`, { method: 'PUT', body });
      if (!res.ok || res.data?.error || res.data?.result === 'fail') {
        return { status: res.status, ok: false, data: { zentaoError: res.data } };
      }
      // Readback: verify the silent-drop-prone fields actually persisted.
      const rb = await ztFetch(env, user, `/bugs/${a.id}`);
      const bug = pickObj(rb.data, a.id);
      const problems = [];
      if (body.assignedTo !== undefined) {
        const acc = typeof bug?.assignedTo === 'object' ? bug?.assignedTo?.account : bug?.assignedTo;
        if (acc !== body.assignedTo) problems.push(`assignedTo 回读为 ${acc ?? 'null'}（期望 ${body.assignedTo}）`);
      }
      if (body.project !== undefined && Number(bug?.project) !== Number(body.project)) {
        problems.push(`project 回读为 ${bug?.project ?? 'null'}（期望 ${body.project}）`);
      }
      if (problems.length) {
        return {
          status: res.status,
          ok: false,
          data: {
            reason: `修改未生效：${problems.join('；')}。常见原因是 assignedTo 不是有效的禅道账号，请用 list_users 核对。`,
            readback: { assignedTo: bug?.assignedTo ?? null, project: bug?.project },
          },
        };
      }
      const acc2 = typeof bug?.assignedTo === 'object' ? bug?.assignedTo?.account : bug?.assignedTo;
      return {
        status: res.status,
        ok: true,
        data: {
          success: true,
          bug: {
            id: bug.id,
            title: bug.title,
            product: bug.product,
            project: bug.project,
            execution: bug.execution,
            assignedTo: acc2,
            assignedToRealName: bug.assignedTo?.realname ?? '',
            severity: bug.severity,
            pri: bug.pri,
            type: bug.type,
            status: bug.status,
          },
          ...(body.assignedTo !== undefined ? notifHint('bug', bug.id, 'reassigned', acc2) : {}),
        },
      };
    },
  },
  {
    name: 'create_story',
    title: '创建需求',
    description: '在产品下创建需求（研发需求）。title 必填；category 默认 feature；产品开启强制评审时必须传 reviewer，否则需求会停留在草稿/无法创建',
    inputSchema: {
      type: 'object',
      properties: {
        productID: { type: 'integer', description: '产品 ID' },
        title: { type: 'string', description: '需求名称' },
        spec: { type: 'string', description: '需求描述' },
        verify: { type: 'string', description: '验收标准' },
        pri: { type: 'integer', description: '优先级 1-4，默认 3' },
        category: {
          type: 'string',
          description: '类别：feature 功能 / interface 接口 / performance 性能 / safe 安全 / experience 体验 / improve 改进 / other 其他，默认 feature',
        },
        estimate: { type: 'number', description: '预计工时（小时）' },
        assignedTo: { type: 'string', description: '指派给（禅道账号，非中文姓名）' },
        reviewer: { type: 'array', items: { type: 'string' }, description: '评审人账号列表（产品开启强制评审时必填）' },
      },
      required: ['productID', 'title'],
    },
    run: (env, user, a) =>
      ztFetch(env, user, `/products/${a.productID}/stories`, {
        method: 'POST',
        body: {
          title: a.title,
          spec: a.spec ?? a.title,
          verify: a.verify ?? '',
          pri: a.pri ?? 3,
          category: a.category ?? 'feature',
          type: 'story',
          estimate: a.estimate,
          assignedTo: a.assignedTo,
          reviewer: Array.isArray(a.reviewer) ? a.reviewer : a.reviewer ? [a.reviewer] : undefined,
        },
      }),
  },
  {
    name: 'update_story',
    title: '修改需求',
    description: '修改需求字段（名称、描述、优先级、指派、验收标准等）。产品开启强制评审时必须传 reviewer',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '需求 ID' },
        title: { type: 'string', description: '需求名称' },
        spec: { type: 'string', description: '需求描述' },
        verify: { type: 'string', description: '验收标准' },
        pri: { type: 'integer', description: '优先级 1-4' },
        assignedTo: { type: 'string', description: '指派给（禅道账号）' },
        reviewer: { type: 'array', items: { type: 'string' }, description: '评审人账号列表（产品开启强制评审时必填）' },
      },
      required: ['id'],
    },
    run: (env, user, a) => {
      const { id, ...body } = a;
      if (body.reviewer && !Array.isArray(body.reviewer)) body.reviewer = [body.reviewer];
      return ztFetch(env, user, `/stories/${id}`, { method: 'PUT', body });
    },
  },
  {
    name: 'close_story',
    title: '关闭需求',
    description: '关闭需求。closedReason：done 已完成 / subdivided 已拆分 / duplicate 重复 / postponed 延期 / willnotdo 不做',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '需求 ID' },
        closedReason: { type: 'string', description: '关闭原因' },
        comment: { type: 'string', description: '备注' },
      },
      required: ['id', 'closedReason'],
    },
    run: (env, user, a) =>
      ztFetch(env, user, `/stories/${a.id}/close`, {
        method: 'PUT',
        body: { closedReason: a.closedReason, comment: a.comment ?? '' },
      }),
  },
  {
    name: 'create_task',
    title: '创建任务',
    description:
      '在执行（迭代）下创建任务，可同时指派负责人。禅道要求必填截止日期 deadline，不传默认今天+7天；estStarted 不传默认今天；任务类型 type：devel 开发 / test 测试 / design 设计 / research 调研 / discussion 讨论。' +
      '支持 images 截图列表：图片真实上传到禅道文件系统并内嵌到任务描述富文本（不是普通附件），打开任务详情即可看到。' +
      'desc 中用 [截图:1]、[截图:2] 标记指定插入位置；未标记的图统一追加到「问题截图」区（关联需求的任务为「参考截图」区）。',
    inputSchema: {
      type: 'object',
      properties: {
        executionID: { type: 'integer', description: '执行（迭代）ID' },
        name: { type: 'string', description: '任务名称' },
        desc: { type: 'string', description: '任务描述（纯文本或 HTML；images 内嵌其中，[截图:1]、[截图:2] 标记指定插入位置）' },
        type: { type: 'string', description: '任务类型，默认 devel' },
        assignedTo: { type: 'string', description: '指派给（禅道账号，非中文姓名）' },
        pri: { type: 'integer', description: '优先级 1-4，默认 3' },
        estimate: { type: 'number', description: '预计工时（小时）' },
        estStarted: { type: 'string', description: '预计开始日期 YYYY-MM-DD，默认今天' },
        deadline: { type: 'string', description: '截止日期 YYYY-MM-DD，禅道必填；不传默认今天+7天' },
        storyID: { type: 'integer', description: '关联需求 ID（可选）' },
        images: imagesSchema('任务描述'),
      },
      required: ['executionID', 'name'],
    },
    run: async (env, user, a) => {
      const hasImages = Array.isArray(a.images) && a.images.length > 0;
      let uploaded = [], failures = [], desc = a.desc ?? a.name;
      if (hasImages) {
        ({ uploaded, failures } = await uploadObjectImages(env, user, a.images));
        const section = a.storyID ? '参考截图' : '问题截图';
        desc = buildStepsHtml(a.desc ?? a.name, uploaded, section);
        if (uploaded.length && !/<img\s/i.test(desc)) {
          // 兜底：[截图:N] 全指向失败图被删除后，已上传的图仍必须落图（规格五：禁止有图不显示）
          desc = buildStepsHtml(String(a.desc ?? a.name).replace(/\[\s*截图\s*[:：]?\s*\d+\s*\]|\[\s*图\s*[:：]?\s*\d+\s*\]/g, ''), uploaded, section);
        }
      }
      const created = await ztFetch(env, user, `/executions/${a.executionID}/tasks`, {
        method: 'POST',
        body: {
          name: a.name,
          type: a.type ?? 'devel',
          desc,
          pri: a.pri ?? 3,
          estimate: a.estimate ?? 1,
          estStarted: a.estStarted ?? todayCN(),
          deadline: a.deadline ?? plusDaysCN(7),
          assignedTo: a.assignedTo,
          story: a.storyID,
        },
      });
      if (!created.ok || created.data?.error || created.data?.result === 'fail') {
        return { status: created.status, ok: false, data: { zentaoError: created.data } };
      }
      if (!hasImages) {
        return { status: created.status, ok: true, data: created.data };
      }
      // 图片验收：回读任务，逐图核对 <img src> 真实内嵌（Task desc 走 REST 不剥 <img>，实测保留）
      const createdId = Number(created.data?.id ?? created.data?.task?.id ?? 0);
      let task = created.data;
      if (createdId) {
        const rb = await ztFetch(env, user, `/tasks/${createdId}`);
        task = pickObj(rb.data, createdId) ?? created.data;
      }
      const { images: imgs, warnings } = imageResult(a.images.length, uploaded, failures, String(task?.desc ?? ''));
      const base = {
        httpStatus: created.status,
        success: true,
        task: createdId ? actionSummary('task', task) : created.data,
        images: imgs,
        ...(warnings.length ? { warnings } : {}),
      };
      if (failures.length || imgs.embedded < imgs.uploaded) {
        // 单图失败不使整体失败（规格六）：任务已创建即 success，失败明细走 images.failed + warnings
        return {
          status: created.status,
          ok: true,
          data: { ...base, code: 'TASK_CREATED_IMAGE_FAILED', reason: '任务已创建，但部分图片未成功内嵌，详见 images.failed 与 warnings' },
        };
      }
      return { status: created.status, ok: true, data: base };
    },
  },
  {
    name: 'update_task',
    title: '修改任务',
    description:
      '修改任务（指派、截止日期、优先级、描述、预计工时等）。支持 images 截图列表：图片真实上传到禅道文件系统并内嵌到任务描述富文本（不是普通附件）。' +
      '不传 desc 时新图追加到现有描述末尾的「问题截图/参考截图」区；传 desc 时整段替换描述，[截图:1]、[截图:2] 标记指定插入位置，未标记的图统一追加到截图区。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '任务 ID' },
        assignedTo: { type: 'string', description: '指派给（禅道账号）' },
        deadline: { type: 'string', description: '截止日期 YYYY-MM-DD' },
        pri: { type: 'integer', description: '优先级 1-4' },
        desc: { type: 'string', description: '任务描述（完整替换；images 内嵌其中，[截图:N] 标记指定插入位置）' },
        estimate: { type: 'number', description: '预计工时（小时）' },
        estStarted: { type: 'string', description: '预计开始日期 YYYY-MM-DD' },
        images: imagesSchema('任务描述'),
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      const { id, images, ...body } = a;
      const hasImages = Array.isArray(images) && images.length > 0;
      let uploaded = [], failures = [];
      if (hasImages) {
        // 追加图语义：不传 desc 时在现有描述上追加；传 desc 时整段替换（images 内嵌其中）
        const curRes = await ztFetch(env, user, `/tasks/${id}`);
        const cur = pickObj(curRes.data, id);
        if (!cur?.id || curRes.data?.error) {
          return { status: curRes.status, ok: false, data: { error: `任务 ${id} 不存在或无法访问` } };
        }
        ({ uploaded, failures } = await uploadObjectImages(env, user, images));
        const baseDesc = a.desc !== undefined ? a.desc : String(cur.desc ?? '');
        const section = cur.story ? '参考截图' : '问题截图';
        body.desc = buildStepsHtml(baseDesc, uploaded, section);
        if (uploaded.length && !/<img\s/i.test(body.desc)) {
          body.desc = buildStepsHtml(String(baseDesc).replace(/\[\s*截图\s*[:：]?\s*\d+\s*\]|\[\s*图\s*[:：]?\s*\d+\s*\]/g, ''), uploaded, section);
        }
      }
      const res = await ztFetch(env, user, `/tasks/${id}`, { method: 'PUT', body });
      if (!res.ok || res.data?.error || res.data?.result === 'fail') {
        return { status: res.status, ok: false, data: { zentaoError: res.data } };
      }
      // Readback: 禅道对无效 assignedTo 静默丢弃（HTTP 200），必须回读核对。
      const rb = await ztFetch(env, user, `/tasks/${id}`);
      const task = pickObj(rb.data, id);
      const problems = [];
      if (body.assignedTo !== undefined && body.assignedTo !== null && body.assignedTo !== '') {
        const acc = accOf(task?.assignedTo);
        if (acc !== body.assignedTo) problems.push(`assignedTo 回读为 ${acc ?? 'null'}（期望 ${body.assignedTo}）`);
      }
      if (problems.length) {
        return {
          status: 200,
          ok: false,
          data: {
            code: 'ACTION_NOT_APPLIED',
            reason: `修改未生效：${problems.join('；')}。常见原因是 assignedTo 不是有效的禅道账号，请用 list_users 核对。`,
            readback: { assignedTo: task?.assignedTo ?? null, status: task?.status },
          },
        };
      }
      if (!hasImages) {
        return { status: 200, ok: true, data: { success: true, task: actionSummary('task', task) } };
      }
      const { images: imgs, warnings } = imageResult(images.length, uploaded, failures, String(task?.desc ?? ''));
      const base = {
        httpStatus: 200,
        success: true,
        task: actionSummary('task', task),
        images: imgs,
        ...(warnings.length ? { warnings } : {}),
      };
      if (failures.length || imgs.embedded < imgs.uploaded) {
        // 单图失败不使整体失败（规格六）
        return {
          status: 200,
          ok: true,
          data: { ...base, code: 'TASK_IMAGE_FAILED', reason: '任务已更新，但部分图片未成功内嵌，详见 images.failed 与 warnings' },
        };
      }
      return { status: 200, ok: true, data: base };
    },
  },
  {
    name: 'create_execution',
    title: '创建执行/迭代',
    description: '在项目下创建执行（迭代/冲刺）。type 默认 sprint；products 传产品 ID 数组',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'integer', description: '所属项目 ID' },
        name: { type: 'string', description: '执行名称' },
        begin: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        type: { type: 'string', description: '类型：sprint 冲刺 / stage 阶段，默认 sprint' },
        lifetime: { type: 'integer', description: '可用工时（人日），可选' },
        products: { type: 'array', items: { type: 'integer' }, description: '关联产品 ID 列表' },
      },
      required: ['project', 'name', 'begin', 'end'],
    },
    run: (env, user, a) =>
      ztFetch(env, user, `/projects/${a.project}/executions`, {
        method: 'POST',
        body: {
          name: a.name,
          begin: a.begin,
          end: a.end,
          type: a.type ?? 'sprint',
          lifetime: a.lifetime,
          products: Array.isArray(a.products) ? a.products : a.products ? [a.products] : undefined,
        },
      }),
  },
  {
    name: 'update_execution',
    title: '修改执行/迭代',
    description: '修改执行（迭代）的名称、起止日期等',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '执行 ID' },
        name: { type: 'string', description: '执行名称' },
        begin: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD' },
      },
      required: ['id'],
    },
    run: (env, user, a) => {
      const { id, ...body } = a;
      return ztFetch(env, user, `/executions/${id}`, { method: 'PUT', body });
    },
  },
  // -------------------------------------------------------------------------
  // Task 状态动作（真实动作 API，全部回读 + 动作历史校验）
  // -------------------------------------------------------------------------
  {
    name: 'finish_task',
    title: '完成任务',
    description:
      '完成任务（状态 wait/doing → done）。服务端要求填写实际开始/实际完成时间，未传时自动填当前时间；' +
      '本次消耗工时 currentConsumed 在总消耗为 0 时必填，默认 1。完成后 assignedTo 不变、finishedBy 自动为当前账号。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '任务 ID' },
        consumed: { type: 'number', description: '本次消耗工时（小时），默认 1；总消耗为 0 时服务端必填' },
        realStarted: { type: 'string', description: '实际开始时间 YYYY-MM-DD HH:MM:SS，默认当前时间' },
        finishedDate: { type: 'string', description: '实际完成时间 YYYY-MM-DD HH:MM:SS，默认当前时间' },
        comment: { type: 'string', description: '完成备注（写入动作历史）' },
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      const before = await readObject(env, user, 'task', a.id);
      if (!before.obj) return { status: before.res.status, ok: false, data: { code: 'NOT_FOUND', reason: `任务 ${a.id} 不存在或无法访问` } };
      const cur = before.obj.status;
      if (cur === 'done') return { status: 200, ok: true, data: { code: 'ACTION_ALREADY_IN_STATE', reason: `任务 ${a.id} 已是 done 状态，无需重复完成`, task: actionSummary('task', before.obj) } };
      if (cur === 'closed' || cur === 'cancel') return { status: 400, ok: false, data: { code: 'INVALID_TRANSITION', reason: `${cur} 状态的任务不能直接完成；如需继续请先 activate_task 激活` } };
      const consumed = Number(a.consumed ?? 1);
      const save = await ztFetch(env, user, `/tasks/${a.id}/finish`, {
        method: 'POST',
        body: {
          realStarted: a.realStarted ?? nowCN(),
          finishedDate: a.finishedDate ?? nowCN(),
          currentConsumed: consumed,
          comment: a.comment ?? '',
        },
      });
      if (!save.ok || save.data?.error || save.data?.result === 'fail') {
        return { status: save.status, ok: false, data: { zentaoError: save.data } };
      }
      const after = await readObject(env, user, 'task', a.id);
      const obj = after.obj ?? pickObj(save.data, a.id) ?? save.data ?? {};
      const problems = verifyAction(obj, { status: 'done', actorField: 'finishedBy', action: 'finished', comment: a.comment }, user);
      if (problems.length) {
        return { status: 200, ok: false, data: { code: 'ACTION_NOT_APPLIED', reason: '完成任务未生效：' + problems.join('；'), readback: actionSummary('task', obj) } };
      }
      return actionResult(env, 'task', obj, 'finished');
    },
  },
  {
    name: 'close_task',
    title: '关闭任务',
    description:
      '关闭任务（→ closed）。wait/done/cancel 状态均可直接关闭（实测允许）；closedBy 自动为当前账号。' +
      '重复关闭同一任务会稳定返回 ACTION_ALREADY_IN_STATE 并保持幂等、不产生新动作记录。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '任务 ID' },
        comment: { type: 'string', description: '关闭原因/备注（写入动作历史，建议写明原因，如与某任务重复）' },
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      const before = await readObject(env, user, 'task', a.id);
      if (!before.obj) return { status: before.res.status, ok: false, data: { code: 'NOT_FOUND', reason: `任务 ${a.id} 不存在或无法访问` } };
      if (before.obj.status === 'closed') {
        return { status: 200, ok: true, data: { code: 'ACTION_ALREADY_IN_STATE', reason: `任务 ${a.id} 已是 closed 状态，无需重复关闭`, task: actionSummary('task', before.obj) } };
      }
      const save = await ztFetch(env, user, `/tasks/${a.id}/close`, { method: 'POST', body: { comment: a.comment ?? '' } });
      if (!save.ok || save.data?.error || save.data?.result === 'fail') {
        return { status: save.status, ok: false, data: { zentaoError: save.data } };
      }
      const after = await readObject(env, user, 'task', a.id);
      const obj = after.obj ?? pickObj(save.data, a.id) ?? save.data ?? {};
      const problems = verifyAction(obj, { status: 'closed', actorField: 'closedBy', action: 'closed', comment: a.comment }, user);
      if (problems.length) {
        return { status: 200, ok: false, data: { code: 'ACTION_NOT_APPLIED', reason: '关闭任务未生效：' + problems.join('；'), readback: actionSummary('task', obj) } };
      }
      return actionResult(env, 'task', obj, 'closed');
    },
  },
  {
    name: 'cancel_task',
    title: '取消任务',
    description:
      '取消任务（→ cancel）。走禅道网页真实取消动作（canceledBy/canceledDate 自动写入，备注进动作历史）；' +
      'REST 无此路由。已取消再调用返回 ACTION_ALREADY_IN_STATE（幂等）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '任务 ID' },
        comment: { type: 'string', description: '取消原因（写入动作历史）' },
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      const before = await readObject(env, user, 'task', a.id);
      if (!before.obj) return { status: before.res.status, ok: false, data: { code: 'NOT_FOUND', reason: `任务 ${a.id} 不存在或无法访问` } };
      if (before.obj.status === 'cancel') {
        return { status: 200, ok: true, data: { code: 'ACTION_ALREADY_IN_STATE', reason: `任务 ${a.id} 已是 cancel 状态`, task: actionSummary('task', before.obj) } };
      }
      if (before.obj.status === 'closed') return { status: 400, ok: false, data: { code: 'INVALID_TRANSITION', reason: 'closed 状态的任务不能再取消；如需变更请先 activate_task' } };
      const save = await webFormPost(env, user, `/task-cancel-${a.id}.html`, { comment: a.comment ?? '' });
      if (!save.ok) return { status: save.status, ok: false, data: { zentaoError: save.data } };
      const after = await readObject(env, user, 'task', a.id);
      const obj = after.obj ?? before.obj;
      const problems = verifyAction(obj, { status: 'cancel', actorField: 'canceledBy', action: 'canceled', comment: a.comment }, user);
      if (problems.length) {
        return { status: 200, ok: false, data: { code: 'ACTION_NOT_APPLIED', reason: '取消任务未生效：' + problems.join('；'), readback: actionSummary('task', obj) } };
      }
      return actionResult(env, 'task', obj, 'canceled');
    },
  },
  {
    name: 'activate_task',
    title: '激活任务',
    description:
      '重新激活任务（cancel/closed → wait）。取消态走网页激活动作（activated 备注进动作历史）；' +
      'closed 态按禅道规则需清空 closedReason 后回到 wait。可同时改派 assignedTo 和剩余工时 left。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '任务 ID' },
        assignedTo: { type: 'string', description: '改派给（禅道账号），不传保持原负责人' },
        left: { type: 'number', description: '剩余工时（小时）' },
        comment: { type: 'string', description: '激活原因（写入动作历史）' },
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      const before = await readObject(env, user, 'task', a.id);
      if (!before.obj) return { status: before.res.status, ok: false, data: { code: 'NOT_FOUND', reason: `任务 ${a.id} 不存在或无法访问` } };
      const src = before.obj;
      if (src.status === 'wait' || src.status === 'doing') {
        return { status: 200, ok: true, data: { code: 'ACTION_ALREADY_IN_STATE', reason: `任务 ${a.id} 已是 ${src.status} 状态，无需激活`, task: actionSummary('task', src) } };
      }
      const assignedTo = a.assignedTo ?? accOf(src.assignedTo) ?? user.account;
      const left = a.left ?? (Number(src.left) > 0 ? Number(src.left) : 8);
      let save;
      if (src.status === 'closed') {
        save = await ztFetch(env, user, `/tasks/${a.id}`, {
          method: 'PUT',
          body: { status: 'wait', assignedTo, left, closedReason: '' },
        });
      } else {
        save = await webFormPost(env, user, `/task-activate-${a.id}.html`, {
          comment: a.comment ?? '', status: 'wait', assignedTo, left,
        });
      }
      if (!save.ok || save.data?.error || save.data?.result === 'fail') {
        return { status: save.status, ok: false, data: { zentaoError: save.data } };
      }
      const after = await readObject(env, user, 'task', a.id);
      const obj = after.obj ?? src;
      const problems = [];
      if (obj.status !== 'wait') problems.push(`status 回读为 ${obj.status}（期望 wait）`);
      if (accOf(obj.assignedTo) !== assignedTo) problems.push(`assignedTo 回读为 ${accOf(obj.assignedTo) ?? 'null'}（期望 ${assignedTo}）`);
      if (a.comment && String(a.comment).trim() && src.status !== 'closed' && !hasAction(obj, 'activated')) {
        problems.push('动作历史缺少 activated 记录');
      }
      if (problems.length) {
        return { status: 200, ok: false, data: { code: 'ACTION_NOT_APPLIED', reason: '激活任务未生效：' + problems.join('；'), readback: actionSummary('task', obj) } };
      }
      return actionResult(env, 'task', obj, a.assignedTo && accOf(src.assignedTo) !== a.assignedTo ? 'reassigned' : 'activated');
    },
  },
  // -------------------------------------------------------------------------
  // Bug 状态动作（真实动作 API；cancel 不存在，绝不伪造）
  // -------------------------------------------------------------------------
  {
    name: 'resolve_bug',
    title: '解决 Bug',
    description:
      '解决 Bug（active → resolved）。resolution 必填且限定禅道真实枚举：' +
      RESOLUTIONS.map((r) => `${r} ${RESOLUTION_LABELS[r]}`).join(' / ') +
      '。resolvedBuild 解决版本必填（默认 trunk）。取消/不做/重复类诉求请用本工具（willnotfix/duplicate/bydesign 等）——禅道 Bug 没有 canceled 状态。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Bug ID' },
        resolution: { type: 'string', description: '解决方案：' + RESOLUTIONS.join(' / ') },
        resolvedBuild: { type: 'string', description: '解决版本，默认 trunk' },
        assignedTo: { type: 'string', description: '解决后回指给（禅道账号，通常给提 Bug 的人验证），不传保持不变' },
        comment: { type: 'string', description: '解决说明（写入动作历史）' },
      },
      required: ['id', 'resolution'],
    },
    run: async (env, user, a) => {
      const resolution = String(a.resolution || '').trim().toLowerCase();
      if (!RESOLUTIONS.includes(resolution)) {
        return {
          status: 400, ok: false,
          data: { code: 'INVALID_RESOLUTION', reason: `resolution=${a.resolution} 不是禅道真实解决方案枚举`, allowed: RESOLUTIONS, labels: RESOLUTION_LABELS },
        };
      }
      const before = await readObject(env, user, 'bug', a.id);
      if (!before.obj) return { status: before.res.status, ok: false, data: { code: 'NOT_FOUND', reason: `Bug ${a.id} 不存在或无法访问` } };
      if (before.obj.status === 'resolved') {
        return { status: 200, ok: true, data: { code: 'ACTION_ALREADY_IN_STATE', reason: `Bug ${a.id} 已是 resolved 状态`, bug: actionSummary('bug', before.obj) } };
      }
      if (before.obj.status === 'closed') return { status: 400, ok: false, data: { code: 'INVALID_TRANSITION', reason: 'closed 状态的 Bug 不能直接解决；如需变更请先 activate_bug 激活' } };
      const save = await ztFetch(env, user, `/bugs/${a.id}/resolve`, {
        method: 'POST',
        body: { resolution, resolvedBuild: a.resolvedBuild ?? 'trunk', assignedTo: a.assignedTo, comment: a.comment ?? '' },
      });
      if (!save.ok || save.data?.error || save.data?.result === 'fail') {
        return { status: save.status, ok: false, data: { zentaoError: save.data } };
      }
      const after = await readObject(env, user, 'bug', a.id);
      const obj = after.obj ?? pickObj(save.data, a.id) ?? save.data ?? {};
      const problems = verifyAction(obj, { status: 'resolved', actorField: 'resolvedBy', action: 'resolved', comment: a.comment }, user);
      if (obj.resolution !== resolution) problems.push(`resolution 回读为 ${JSON.stringify(obj.resolution)}（期望 ${resolution}）`);
      if (problems.length) {
        return { status: 200, ok: false, data: { code: 'ACTION_NOT_APPLIED', reason: '解决 Bug 未生效：' + problems.join('；'), readback: actionSummary('bug', obj) } };
      }
      return actionResult(env, 'bug', obj, 'finished');
    },
  },
  {
    name: 'close_bug',
    title: '关闭 Bug',
    description:
      '关闭 Bug（→ closed）。active 和 resolved 均可直接关闭（实测允许）；closedBy 自动为当前账号。' +
      '重复关闭返回 ACTION_ALREADY_IN_STATE（幂等）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Bug ID' },
        comment: { type: 'string', description: '关闭备注（写入动作历史）' },
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      const before = await readObject(env, user, 'bug', a.id);
      if (!before.obj) return { status: before.res.status, ok: false, data: { code: 'NOT_FOUND', reason: `Bug ${a.id} 不存在或无法访问` } };
      if (before.obj.status === 'closed') {
        return { status: 200, ok: true, data: { code: 'ACTION_ALREADY_IN_STATE', reason: `Bug ${a.id} 已是 closed 状态，无需重复关闭`, bug: actionSummary('bug', before.obj) } };
      }
      const save = await ztFetch(env, user, `/bugs/${a.id}/close`, { method: 'POST', body: { comment: a.comment ?? '' } });
      if (!save.ok || save.data?.error || save.data?.result === 'fail') {
        return { status: save.status, ok: false, data: { zentaoError: save.data } };
      }
      const after = await readObject(env, user, 'bug', a.id);
      const obj = after.obj ?? pickObj(save.data, a.id) ?? save.data ?? {};
      const problems = verifyAction(obj, { status: 'closed', actorField: 'closedBy', action: 'closed', comment: a.comment }, user);
      if (problems.length) {
        return { status: 200, ok: false, data: { code: 'ACTION_NOT_APPLIED', reason: '关闭 Bug 未生效：' + problems.join('；'), readback: actionSummary('bug', obj) } };
      }
      return actionResult(env, 'bug', obj, 'closed');
    },
  },
  {
    name: 'activate_bug',
    title: '激活 Bug',
    description:
      '重新激活 Bug（resolved/closed → active，走禅道网页真实激活动作，activatedCount+1，' +
      '旧的 resolution/resolvedBuild 自动清空）。可同时改派 assignedTo。' +
      '注意：禅道 Bug 没有 canceled 状态、也没有 cancel 动作。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Bug ID' },
        assignedTo: { type: 'string', description: '改派给（禅道账号），不传保持原负责人' },
        comment: { type: 'string', description: '激活原因（写入动作历史）' },
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      const before = await readObject(env, user, 'bug', a.id);
      if (!before.obj) return { status: before.res.status, ok: false, data: { code: 'NOT_FOUND', reason: `Bug ${a.id} 不存在或无法访问` } };
      const src = before.obj;
      if (src.status === 'active') {
        return { status: 200, ok: true, data: { code: 'ACTION_ALREADY_IN_STATE', reason: `Bug ${a.id} 已是 active 状态，无需激活`, bug: actionSummary('bug', src) } };
      }
      const openedBuild = Array.isArray(src.openedBuild) && src.openedBuild.length
        ? String(src.openedBuild[0].id ?? src.openedBuild[0] ?? 'trunk')
        : String(src.openedBuild || 'trunk');
      const save = await webFormPost(env, user, `/bug-activate-${a.id}.html`, {
        comment: a.comment ?? '',
        openedBuild,
        assignedTo: a.assignedTo ?? accOf(src.assignedTo) ?? user.account,
        resolution: '',
        resolvedBuild: '',
      });
      if (!save.ok) return { status: save.status, ok: false, data: { zentaoError: save.data } };
      const after = await readObject(env, user, 'bug', a.id);
      const obj = after.obj ?? src;
      const problems = [];
      if (obj.status !== 'active') problems.push(`status 回读为 ${obj.status}（期望 active）`);
      if (!hasAction(obj, 'activated')) problems.push('动作历史缺少 activated 记录');
      if (a.assignedTo && accOf(obj.assignedTo) !== a.assignedTo) {
        problems.push(`assignedTo 回读为 ${accOf(obj.assignedTo) ?? 'null'}（期望 ${a.assignedTo}）`);
      }
      if (problems.length) {
        return { status: 200, ok: false, data: { code: 'ACTION_NOT_APPLIED', reason: '激活 Bug 未生效：' + problems.join('；'), readback: actionSummary('bug', obj) } };
      }
      return actionResult(env, 'bug', obj, a.assignedTo && accOf(src.assignedTo) !== a.assignedTo ? 'reassigned' : 'activated');
    },
  },
  // -------------------------------------------------------------------------
  // Notification Support Layer（MCP 只提供上下文/台账；是否发、发给谁、内容归 ChatGPT；发送归 Gmail）
  // -------------------------------------------------------------------------
  {
    name: 'get_user_contact',
    title: '用户联系方式',
    description:
      '查询用户的姓名与邮箱（供通知用）。优先级：禅道用户 email 非空用禅道的（source=zentao），' +
      '否则用部署方联系人配置（source=notification_config），绝不猜测邮箱。' +
      '返回 emailEnabled=false + reason=NO_EMAIL_CONFIGURED 表示无邮箱；用户不存在返回 USER_NOT_FOUND。',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: '禅道账号（英文），如 wanganqing' } },
      required: ['account'],
    },
    run: async (env, user, a) => {
      const contact = await resolveContact(env, user, a.account);
      if (contact.error === 'USER_NOT_FOUND') {
        return { status: 404, ok: false, data: { code: 'USER_NOT_FOUND', account: a.account, reason: `禅道用户 ${a.account} 不存在（可先用 list_users 查账号）` } };
      }
      return { status: 200, ok: true, data: contact };
    },
  },
  {
    name: 'get_notification_context',
    title: '通知上下文',
    description:
      '生成某事件的通知上下文（对象标题/项目/负责人/邮箱/URL/notificationKey），供 ChatGPT 判断是否通知、' +
      '写邮件内容。event 可选：assigned 指派 / reassigned 改派 / finished 完成 / closed 关闭 / canceled 取消 / activated 激活；' +
      '不传时按对象当前状态推导默认事件。本工具不发邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: { type: 'string', description: '对象类型：bug / task' },
        objectID: { type: 'integer', description: '对象 ID' },
        event: { type: 'string', description: '事件：assigned / reassigned / finished / closed / canceled / activated' },
      },
      required: ['objectType', 'objectID'],
    },
    run: async (env, user, a) => {
      const objectType = a.objectType === 'bug' ? 'bug' : a.objectType === 'task' ? 'task' : null;
      if (!objectType) return { status: 400, ok: false, data: { code: 'INVALID_OBJECT_TYPE', reason: 'objectType 仅支持 bug / task' } };
      const event = a.event ? String(a.event) : null;
      if (event && !NOTIFY_EVENTS.includes(event)) {
        return { status: 400, ok: false, data: { code: 'INVALID_EVENT', reason: `event=${a.event} 不支持`, allowed: NOTIFY_EVENTS } };
      }
      const { res, obj } = await readObject(env, user, objectType, a.objectID);
      if (!obj) return { status: res.status, ok: false, data: { code: 'NOT_FOUND', reason: `${objectType} ${a.objectID} 不存在或无法访问` } };
      const usedEvent = event ?? defaultEvent(objectType, obj);
      const acc = accOf(obj.assignedTo);
      let contact = null;
      if (acc) {
        const c = await resolveContact(env, user, acc);
        contact = c.error ? { account: acc, realname: realnameOf(obj.assignedTo), email: null, emailEnabled: false, reason: 'NO_EMAIL_CONFIGURED' } : c;
      }
      let project = null;
      if (Number(obj.project) > 0) {
        const pr = await ztFetch(env, user, `/projects/${obj.project}`);
        if (pr.ok && pr.data && !pr.data.error) {
          project = { id: Number(obj.project), name: pr.data.name ?? pr.data.project?.name ?? null };
        }
      }
      project ??= { id: Number(obj.project) || 0, name: obj.projectName ?? null };
      return {
        status: 200,
        ok: true,
        data: {
          objectType,
          objectID: obj.id,
          event: usedEvent,
          title: objectType === 'bug' ? obj.title : obj.name,
          status: obj.status,
          project,
          assignedTo: acc ? { account: acc, realname: realnameOf(obj.assignedTo) || contact?.realname || '', email: contact?.email ?? null } : null,
          url: objectUrl(env, objectType, obj.id),
          notificationKey: acc ? notificationKey(objectType, obj.id, usedEvent, acc) : null,
          hint: '通知判断、收件人取舍、邮件内容由 ChatGPT 决定；发送用 Gmail 连接器；发送成功后用 record_notification 记账防重复。',
        },
      };
    },
  },
  {
    name: 'get_notification_status',
    title: '通知发送状态',
    description:
      '查询某个通知是否已发送（防重复）。未发送返回 status=not_sent；已发送返回 sent/failed、' +
      'channel、recipient、sentAt、messageId。台账存于 Cloudflare KV，跨请求持久。',
    inputSchema: {
      type: 'object',
      properties: { notificationKey: { type: 'string', description: '如 bug:130:assigned:wanganqing' } },
      required: ['notificationKey'],
    },
    run: async (env, user, a) => {
      const parsed = parseNotificationKey(a.notificationKey);
      if (!parsed) {
        return { status: 400, ok: false, data: { code: 'INVALID_NOTIFICATION_KEY', reason: 'notificationKey 格式应为 {bug|task}:{id}:{event}:{account}', example: 'bug:130:assigned:wanganqing' } };
      }
      const rec = await notifGet(env, a.notificationKey);
      if (!rec) return { status: 200, ok: true, data: { notificationKey: a.notificationKey, status: 'not_sent' } };
      return {
        status: 200,
        ok: true,
        data: {
          notificationKey: a.notificationKey,
          status: rec.status,
          channel: rec.channel,
          recipient: rec.recipient,
          sentAt: rec.sentAt,
          messageId: rec.messageId ?? null,
          error: rec.error ?? null,
        },
      };
    },
  },
  {
    name: 'record_notification',
    title: '记录通知发送',
    description:
      'Gmail 真正发送完成后调用，写入通知台账（防重复）。幂等：同 notificationKey + sent 重复提交不产生重复记录。' +
      '会校验对象存在、收件人必须与联系人映射匹配，不接受随意伪造收件人。开发/测试可用 messageId=test-message-id-001，不会发真实邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        notificationKey: { type: 'string', description: '如 bug:130:closed:wanganqing' },
        channel: { type: 'string', description: '固定传 email' },
        recipient: { type: 'string', description: '实际收件人邮箱，必须与联系人映射一致' },
        status: { type: 'string', description: 'sent 已发送 / failed 发送失败' },
        messageId: { type: 'string', description: 'Gmail 返回的消息 ID（可选）' },
        error: { type: 'string', description: '失败原因（status=failed 时）' },
      },
      required: ['notificationKey', 'channel', 'recipient', 'status'],
    },
    run: async (env, user, a) => {
      const parsed = parseNotificationKey(a.notificationKey);
      if (!parsed) {
        return { status: 400, ok: false, data: { code: 'INVALID_NOTIFICATION_KEY', reason: 'notificationKey 格式应为 {bug|task}:{id}:{event}:{account}' } };
      }
      if (a.channel !== 'email') {
        return { status: 400, ok: false, data: { code: 'INVALID_CHANNEL', reason: `channel=${a.channel} 仅支持 email` } };
      }
      if (a.status !== 'sent' && a.status !== 'failed') {
        return { status: 400, ok: false, data: { code: 'INVALID_STATUS', reason: `status=${a.status} 仅支持 sent / failed` } };
      }
      const existing = await notifGet(env, a.notificationKey);
      if (existing && existing.status === 'sent' && a.status === 'sent') {
        return { status: 200, ok: true, data: { code: 'NOTIFICATION_ALREADY_RECORDED', notificationKey: a.notificationKey, record: existing } };
      }
      const { obj } = await readObject(env, user, parsed.objectType, parsed.objectID);
      if (!obj) {
        return { status: 404, ok: false, data: { code: 'NOT_FOUND', reason: `${parsed.objectType} ${parsed.objectID} 不存在，不允许记账` } };
      }
      const contact = await resolveContact(env, user, parsed.account);
      if (contact.error || !contact.email) {
        return { status: 400, ok: false, data: { code: 'RECIPIENT_MISMATCH', reason: `联系人 ${parsed.account} 无可配置邮箱，不允许记账到 ${a.recipient}`, contact } };
      }
      if (String(a.recipient).trim().toLowerCase() !== String(contact.email).trim().toLowerCase()) {
        return {
          status: 400, ok: false,
          data: { code: 'RECIPIENT_MISMATCH', reason: `收件人 ${a.recipient} 与联系人映射（${contact.email}）不一致，拒绝记账` },
        };
      }
      const record = {
        notificationKey: a.notificationKey,
        status: a.status,
        channel: 'email',
        recipient: contact.email,
        sentAt: nowCN(),
        messageId: a.messageId ?? null,
        error: a.error ?? null,
        objectType: parsed.objectType,
        objectID: parsed.objectID,
        event: parsed.event,
        account: parsed.account,
      };
      await notifPut(env, a.notificationKey, record);
      return { status: 200, ok: true, data: { recorded: true, notificationKey: a.notificationKey, record } };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP protocol (stateless streamable-HTTP, JSON responses)
// ---------------------------------------------------------------------------

function toolResult(id, payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return mcpResult(id, { content: [{ type: 'text', text }], isError });
}

async function handleRpc(env, user, msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : API_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'zentao-mcp', title: '禅道 ZenTao', version: '1.5.2' },
      instructions:
        '禅道项目管理连接器。指派任务或需求时 assignedTo 必须用禅道账号（英文），先用 list_users 查询账号；' +
        'productID / executionID 可用 list_products / list_executions 查询。创建需求必填 title；创建任务必填 executionID + name。' +
        '提 Bug 默认挂项目，不允许 project=0；默认映射：' + (projectMapDesc(env) || '未配置（请显式传 projectID）') + '。' +
        '写操作失败时会返回禅道的中文校验错误，按提示修正参数重试即可。' +
        '状态动作用 finish/close/cancel/activate_task 与 resolve/close/activate_bug（Bug 无 cancel，取消/不做/重复类用 resolve_bug 的 willnotfix/duplicate/bydesign 等）。' +
        '通知流程：动作后 → get_notification_context → get_notification_status 查重 → 由你判断是否通知并用 Gmail 发送 → record_notification 记账；MCP 不发邮件、不写邮件正文。',
    });
  }
  if (method === 'ping') return mcpResult(id, {});
  if (method === 'tools/list') {
    return mcpResult(id, {
      tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
        name,
        title,
        description,
        inputSchema,
      })),
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return toolResult(id, `未知工具: ${name}`, true);
    try {
      const { status, ok, data } = await tool.run(env, user, params?.arguments ?? {});
      const failed = !ok || data?.error || data?.result === 'fail';
      return toolResult(id, { httpStatus: status, ...(failed ? { zentaoError: data } : data) }, failed);
    } catch (err) {
      return toolResult(id, `调用失败: ${err?.message ?? String(err)}`, true);
    }
  }
  if (id === undefined) return new Response(null, { status: 202 }); // notification
  return mcpError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Self-service registration (optional). GET / serves a small page where
// teammates enter an invite code + their own ZenTao credentials; POST /register
// verifies the credentials against ZenTao, mints a per-user secret URL and
// stores the (AES-GCM encrypted) credentials in the ZT_USERS KV namespace.
// Requires: INVITE_CODE and REG_KEY (64 hex chars) secrets + ZT_USERS binding.
// ---------------------------------------------------------------------------

const regRate = new Map(); // ip -> { count, windowStart }

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function getRegKey(env) {
  if (!env.REG_KEY || !/^[0-9a-fA-F]{64}$/.test(env.REG_KEY)) return null;
  return crypto.subtle.importKey('raw', hexToBytes(env.REG_KEY), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptCred(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const blob = new Uint8Array(iv.length + cipher.length);
  blob.set(iv, 0); blob.set(cipher, iv.length);
  let bin = '';
  for (const b of blob) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function decryptCred(key, blob) {
  const bin = atob(blob);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

function regPage() {
  return new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>禅道连接器注册</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f9;margin:0;padding:40px 16px;color:#24292f}
.card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p.sub{color:#57606a;font-size:14px;margin:0 0 20px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d0d7de;border-radius:8px;font-size:14px}
button{margin-top:20px;width:100%;padding:11px;background:#1f6feb;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.msg{margin-top:14px;padding:10px 12px;border-radius:8px;font-size:14px;display:none}
.err{background:#fff1f0;border:1px solid #ffccc7;color:#cf1322}
.ok{background:#f6ffed;border:1px solid #b7eb8f;color:#389e0d}
.url{word-break:break-all;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:10px;font-family:ui-monospace,monospace;font-size:13px;margin:8px 0}
ol{font-size:14px;line-height:1.7;padding-left:20px}
.copy{float:right;font-size:12px;padding:3px 10px;width:auto;margin:0}
</style></head><body>
<div class="card">
<h1>禅道 MCP 连接器 · 自助注册</h1>
<p class="sub">注册后你会得到一条专属连接器地址，在 ChatGPT 里绑定即可用自己的禅道账号提 Bug / 查任务。密码仅用于连接禅道（加密存储），不会发给任何第三方。</p>
<label>邀请码</label><input id="invite" placeholder="向管理员获取">
<label>禅道账号（英文）</label><input id="account" autocomplete="off" placeholder="例如 zhangsan">
<label>禅道密码</label><input id="password" type="password">
<button id="go" onclick="reg()">生成我的连接器地址</button>
<div id="err" class="msg err"></div>
<div id="ok" class="msg ok" style="display:none">
  <b>注册成功！你的专属连接器地址：</b>
  <div class="url" id="url"></div>
  <button class="copy" onclick="copyUrl()">复制地址</button>
  <p style="font-size:13px;margin:14px 0 4px"><b>在 ChatGPT 里启用（一次性）：</b></p>
  <ol>
    <li>打开 chatgpt.com → 左下角头像 → 设置 → 账户安全与登录 → 开启「开发者模式」</li>
    <li>返回设置 → 插件 → 创建连接器：名称填「禅道」，MCP 服务器 URL 填上面这条地址，身份验证选「无身份验证」</li>
    <li>创建后，在聊天输入框的工具里启用「禅道」，即可直接对话使用</li>
  </ol>
  <p style="font-size:12px;color:#57606a">请勿把这条地址分享给他人——它等同于你的禅道身份。如泄露，回到本页用同一账号重新注册即可作废旧地址。</p>
</div>
</div>
<script>
async function reg(){
  var err=document.getElementById('err'),ok=document.getElementById('ok'),btn=document.getElementById('go');
  err.style.display='none';ok.style.display='none';
  btn.disabled=true;btn.textContent='验证中…';
  try{
    var r=await fetch('/register',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({invite:invite.value.trim(),account:account.value.trim(),password:password.value})});
    var d=await r.json();
    if(r.status!==200&&r.status!==201){throw new Error(d.error||('HTTP '+r.status))}
    document.getElementById('url').textContent=d.mcpUrl;
    ok.style.display='block';ok.scrollIntoView({behavior:'smooth'});
  }catch(e){err.textContent='注册失败：'+e.message;err.style.display='block'}
  finally{btn.disabled=false;btn.textContent='生成我的连接器地址'}
}
function copyUrl(){navigator.clipboard.writeText(document.getElementById('url').textContent)}
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleRegister(request, env) {
  if (!env.INVITE_CODE || !env.ZT_USERS || !env.REG_KEY) {
    return jsonResponse({ error: '自助注册未启用（管理员需配置 INVITE_CODE / REG_KEY secrets 和 ZT_USERS KV）' }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }
  const { invite, account, password } = body || {};
  if (!invite || invite !== env.INVITE_CODE) return jsonResponse({ error: '邀请码不正确' }, 403);
  if (!account || !/^[a-zA-Z0-9_.-]{2,40}$/.test(account)) return jsonResponse({ error: '禅道账号格式不正确（英文账号）' }, 400);
  if (!password || String(password).length < 1) return jsonResponse({ error: '请填写禅道密码' }, 400);
  // simple per-IP rate limit
  const ip = request.headers.get('cf-connecting-ip') || '?';
  const now = Date.now();
  const rl = regRate.get(ip);
  if (!rl || now - rl.windowStart > 3600e3) regRate.set(ip, { count: 1, windowStart: now });
  else if (++rl.count > 10) return jsonResponse({ error: '尝试过于频繁，请一小时后再试' }, 429);
  // verify credentials against ZenTao before storing anything
  let verified = false;
  try {
    const res = await fetch(apiBase(env) + '/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password: String(password) }),
    });
    const data = await res.json().catch(() => ({}));
    verified = res.ok && !!data.token;
  } catch { verified = false; }
  if (!verified) return jsonResponse({ error: '禅道账号或密码不正确（已实时校验）' }, 401);
  // mint secret; re-registering replaces (and invalidates) the old URL
  const key = await getRegKey(env);
  const enc = await encryptCred(key, { account, password: String(password) });
  const old = await env.ZT_USERS.get('u:' + account.toLowerCase());
  const secretB = new Uint8Array(32);
  crypto.getRandomValues(secretB);
  const secret = Array.from(secretB, b => b.toString(16).padStart(2, '0')).join('');
  if (old) await env.ZT_USERS.delete('s:' + old);
  await env.ZT_USERS.put('s:' + secret, enc);
  await env.ZT_USERS.put('u:' + account.toLowerCase(), secret);
  const origin = new URL(request.url).origin;
  return jsonResponse({ mcpUrl: `${origin}/mcp/${secret}` }, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // routes: / and /register = self-service signup; /mcp/<secret> = MCP
    const pathOnly = url.pathname.replace(/\/+$/, '');
    if (pathOnly === '' || pathOnly === '/index.html') {
      return regPage();
    }
    if (pathOnly === '/register') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      return handleRegister(request, env);
    }
    if (!url.pathname.startsWith('/mcp/')) {
      return jsonResponse({ error: 'Not found' }, 404);
    }
    const secret = decodeURIComponent(url.pathname.replace(/^\/mcp\//, '').replace(/\/+$/, ''));
    const user = await resolveUser(env, secret);
    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    if (request.method === 'GET') {
      return jsonResponse(
        { jsonrpc: '2.0', error: { code: -32000, message: 'GET not supported (stateless server); use POST' } },
        405,
      );
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }
    let rpc;
    try {
      rpc = await request.json();
    } catch {
      return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const msgs = Array.isArray(rpc) ? rpc : [rpc];
    const responses = [];
    for (const msg of msgs) {
      if (!msg || typeof msg.method !== 'string') {
        responses.push({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      const res = await handleRpc(env, user, msg);
      if (res.status === 202) continue; // notification: no response
      responses.push(await res.json());
    }
    if (!responses.length) return new Response(null, { status: 202 });
    return jsonResponse(Array.isArray(rpc) ? responses : responses[0], 200, {
      'Mcp-Session-Id': 'sid-' + crypto.randomUUID(),
    });
  },
};
