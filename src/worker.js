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

function resolveUser(env, secret) {
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
    throw new Error('图片上传失败: ' + JSON.stringify(data).slice(0, 200));
  }
  return data.url; // site-relative, e.g. /zentao/file-read-302.png — use verbatim
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the steps HTML: description (plain text or HTML) with optional
// [截图:N] / [图:N] markers replaced by the uploaded images; unreferenced
// images are appended in a 问题截图 section.
function buildStepsHtml(description, uploaded) {
  let html = String(description ?? '').trim();
  if (/<p[ >]|<img|<br/i.test(html)) {
    html = html; // already HTML-ish, keep as-is
  } else {
    html = html.split(/\n{2,}/).map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br/>') + '</p>').join('');
  }
  const used = new Set();
  html = html.replace(/\[\s*截图\s*[:：]?\s*(\d+)\s*\]|\[\s*图\s*[:：]?\s*(\d+)\s*\]/g, (m0, n1, n2) => {
    const n = Number(n1 || n2);
    const img = uploaded[n - 1];
    if (!img) return ''; // upload failed: drop the marker instead of leaving literal text
    used.add(n - 1);
    return `<img src="${img.url}" alt="${escapeHtml(img.alt)}" />`;
  });
  const rest = uploaded.filter((_, i) => !used.has(i));
  if (rest.length) {
    html += '<p><strong>问题截图：</strong></p>' + rest.map(img => `<img src="${img.url}" alt="${escapeHtml(img.alt)}" />`).join('');
  }
  return html;
}

// Load image bytes for an images[] entry: base64 inline or fetch a URL.
async function loadImageBytes(item, index) {
  const spec = item ?? {};
  const name = spec.filename || spec.name || `截图${index + 1}`;
  if (spec.base64) {
    const b64 = String(spec.base64).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    const bin = atob(b64);
    if (bin.length > MAX_IMAGE_BYTES) throw new Error(`图片 ${name} 过大（${bin.length} 字节，上限 ${MAX_IMAGE_BYTES}）`);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const anyExt = (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase();
    if (anyExt && !IMAGE_EXTS.includes(anyExt)) throw new Error(`不支持的图片格式 .${anyExt}（仅支持 ${IMAGE_EXTS.join('/')}）`);
    const ext = IMAGE_EXTS.includes(anyExt) ? anyExt : 'png';
    return { bytes, filename: anyExt ? name : name + '.' + ext, mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext), alt: spec.alt || name };
  }
  if (spec.url) {
    const res = await fetch(spec.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`图片 ${name} 下载失败（HTTP ${res.status}，URL 需公网可匿名访问）`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片 ${name} 过大（${buf.length} 字节）`);
    let ext = (/\.(png|jpe?g|gif|bmp|webp)(?:$|[?#])/i.exec(spec.url) || [])[1]?.toLowerCase();
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ext && ctype.startsWith('image/')) ext = ctype.split('/')[1].split(';')[0];
    const anyExt2 = (/\.([a-z0-9]+)(?:$|[?#])/i.exec(spec.url) || [])[1]?.toLowerCase();
    if (!ext && anyExt2) throw new Error(`不支持的图片格式 .${anyExt2}（仅支持 ${IMAGE_EXTS.join('/')}）`);
    return { bytes: buf, filename: name + '.' + (ext || 'png'), mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext || 'png'), alt: spec.alt || name };
  }
  throw new Error(`图片 ${index + 1} 缺少 url 或 base64`);
}

async function uploadBugImages(env, user, images) {
  const uploaded = [];
  const failures = [];
  let idx = 0;
  for (const item of (images || [])) {
    try {
      const { bytes, filename, mime, alt } = await loadImageBytes(item, idx);
      const ext = (/\.([a-z0-9]+)$/i.exec(filename) || [])[1]?.toLowerCase() || 'png';
      if (!IMAGE_EXTS.includes(ext)) throw new Error(`不支持的图片格式 .${ext}（仅支持 ${IMAGE_EXTS.join('/')}）`);
      const url = await uploadImageWeb(env, user, bytes, filename, mime);
      uploaded.push({ url, filename, alt: alt || filename });
    } catch (err) {
      failures.push({ index: idx, filename: item?.filename || item?.name || `截图${idx + 1}`, reason: err?.message ?? String(err) });
    }
    idx++;
  }
  return { uploaded, failures };
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
        images: {
          type: 'array',
          description: '截图列表，直接内嵌到重现步骤富文本（不是附件）。description 中可用 [截图:1]、[截图:2] 标记插入位置，未标记的图统一排到「问题截图」区。支持 png/jpg/jpeg/gif/bmp/webp，单图 ≤9MB',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: '图片 URL，需公网可匿名访问（与 base64 二选一）' },
              base64: { type: 'string', description: '图片 base64 内容，可带 data:image/png;base64, 前缀（与 url 二选一）' },
              filename: { type: 'string', description: '文件名（决定扩展名，支持中文），默认 截图N.png' },
              alt: { type: 'string', description: '图片 alt 描述' },
            },
          },
        },
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
        const bug = rb.data?.bug ?? rb.data;
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
        const imagesInSteps = uploaded.filter(u => String(bug?.steps ?? '').includes(u.url));
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
          images: {
            requested: a.images.length,
            uploaded: uploaded.length,
            embedded: imagesInSteps.length,
            failed: failures,
          },
          note: `openedBy 为当前连接器账号 ${user.account}：禅道以 API 登录账号记录创建人，不允许代他人提交。`,
        };
        if (failures.length || imagesInSteps.length < uploaded.length) {
          return {
            status: 201,
            ok: false,
            data: { ...base, code: 'BUG_CREATED_IMAGE_FAILED', reason: 'Bug 已创建但部分图片未成功内嵌，见 images/failed 与 images/embedded' },
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
      const bug = rb.data?.bug ?? rb.data;
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
        images: {
          type: 'array',
          description: '要内嵌的截图列表（同 create_bug 的 images 格式）。不传 description 时新图追加到现有步骤末尾的「问题截图」区',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: '图片 URL，需公网可匿名访问（与 base64 二选一）' },
              base64: { type: 'string', description: '图片 base64 内容（与 url 二选一）' },
              filename: { type: 'string', description: '文件名，支持中文' },
              alt: { type: 'string', description: '图片 alt 描述' },
            },
          },
        },
      },
      required: ['id'],
    },
    run: async (env, user, a) => {
      // Images → web-form edit flow (v1 API would strip the <img> tags).
      if (Array.isArray(a.images) && a.images.length > 0) {
        const cur = await ztFetch(env, user, `/bugs/${a.id}`);
        const curBug = cur.data?.bug ?? cur.data;
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
        const bug = rb.data?.bug ?? rb.data;
        const acc = typeof bug?.assignedTo === 'object' ? bug?.assignedTo?.account : bug?.assignedTo;
        const problems = [];
        const wantAssignee = a.assignedTo ?? (typeof curBug.assignedTo === 'object' ? curBug.assignedTo?.account : curBug.assignedTo);
        if (wantAssignee && acc !== wantAssignee) problems.push(`assignedTo 回读为 ${acc ?? 'null'}（期望 ${wantAssignee}）`);
        if (Number(bug?.project) !== Number(curBug.project)) problems.push(`project 回读为 ${bug?.project}（期望 ${curBug.project}）`);
        const imagesInSteps = uploaded.filter(u => String(bug?.steps ?? '').includes(u.url));
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
          images: { requested: a.images.length, uploaded: uploaded.length, embedded: imagesInSteps.length, failed: failures },
        };
        if (failures.length || imagesInSteps.length < uploaded.length) {
          return { status: 200, ok: false, data: { ...base, code: 'BUG_CREATED_IMAGE_FAILED', reason: 'Bug 已更新但部分图片未成功内嵌，见 images' } };
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
      const bug = rb.data?.bug ?? rb.data;
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
    description: '在执行（迭代）下创建任务，可同时指派负责人。禅道要求必填截止日期 deadline，不传默认今天+7天；estStarted 不传默认今天；任务类型 type：devel 开发 / test 测试 / design 设计 / research 调研 / discussion 讨论',
    inputSchema: {
      type: 'object',
      properties: {
        executionID: { type: 'integer', description: '执行（迭代）ID' },
        name: { type: 'string', description: '任务名称' },
        desc: { type: 'string', description: '任务描述' },
        type: { type: 'string', description: '任务类型，默认 devel' },
        assignedTo: { type: 'string', description: '指派给（禅道账号，非中文姓名）' },
        pri: { type: 'integer', description: '优先级 1-4，默认 3' },
        estimate: { type: 'number', description: '预计工时（小时）' },
        estStarted: { type: 'string', description: '预计开始日期 YYYY-MM-DD，默认今天' },
        deadline: { type: 'string', description: '截止日期 YYYY-MM-DD，禅道必填；不传默认今天+7天' },
        storyID: { type: 'integer', description: '关联需求 ID（可选）' },
      },
      required: ['executionID', 'name'],
    },
    run: (env, user, a) =>
      ztFetch(env, user, `/executions/${a.executionID}/tasks`, {
        method: 'POST',
        body: {
          name: a.name,
          type: a.type ?? 'devel',
          desc: a.desc ?? a.name,
          pri: a.pri ?? 3,
          estimate: a.estimate ?? 1,
          estStarted: a.estStarted ?? todayCN(),
          deadline: a.deadline ?? plusDaysCN(7),
          assignedTo: a.assignedTo,
          story: a.storyID,
        },
      }),
  },
  {
    name: 'update_task',
    title: '修改任务',
    description: '修改任务（指派、截止日期、优先级、描述、预计工时等）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '任务 ID' },
        assignedTo: { type: 'string', description: '指派给（禅道账号）' },
        deadline: { type: 'string', description: '截止日期 YYYY-MM-DD' },
        pri: { type: 'integer', description: '优先级 1-4' },
        desc: { type: 'string', description: '任务描述' },
        estimate: { type: 'number', description: '预计工时（小时）' },
        estStarted: { type: 'string', description: '预计开始日期 YYYY-MM-DD' },
      },
      required: ['id'],
    },
    run: (env, user, a) => {
      const { id, ...body } = a;
      return ztFetch(env, user, `/tasks/${id}`, { method: 'PUT', body });
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
      serverInfo: { name: 'zentao-mcp', title: '禅道 ZenTao', version: '1.3.0' },
      instructions:
        '禅道项目管理连接器。指派任务或需求时 assignedTo 必须用禅道账号（英文），先用 list_users 查询账号；' +
        'productID / executionID 可用 list_products / list_executions 查询。创建需求必填 title；创建任务必填 executionID + name。' +
        '提 Bug 默认挂项目，不允许 project=0；默认映射：' + (projectMapDesc(env) || '未配置（请显式传 projectID）') + '。' +
        '写操作失败时会返回禅道的中文校验错误，按提示修正参数重试即可。',
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = decodeURIComponent(url.pathname.replace(/^\/mcp\//, '').replace(/\/+$/, ''));
    const user = resolveUser(env, secret);
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
