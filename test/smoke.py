# -*- coding: utf-8 -*-
"""Minimal smoke test against a deployed (or `wrangler dev`) zentao-mcp Worker.

Env:
  MCP_URL      e.g. https://zentao-mcp.xxx.workers.dev/mcp/<secret>
  ZT_BASE      ZenTao base URL (for direct cleanup assertions)
  ZT_ACCOUNT   ZenTao account (direct login for cleanup)
  ZT_PASSWORD  ZenTao password

Run: python test/smoke.py
"""
import base64, json, os, re, struct, sys, time, urllib.error, urllib.request, zlib

MCP_URL = os.environ.get('MCP_URL', '').rstrip('/')
ZT_BASE = os.environ.get('ZT_BASE', '').rstrip('/')
ZT_ACCOUNT = os.environ.get('ZT_ACCOUNT', '')
ZT_PASSWORD = os.environ.get('ZT_PASSWORD', '')

results = []
def report(name, ok, detail=''):
    results.append(ok)
    print(('PASS' if ok else 'FAIL'), name, ('| ' + detail if detail else ''))

def mcp(name, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': name, 'arguments': args}}).encode('utf-8')
    req = urllib.request.Request(MCP_URL, data=body,
        headers={'Content-Type': 'application/json', 'User-Agent': 'curl/8.9'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8'))

def call(name, args):
    d = mcp(name, args)
    text = d['result']['content'][0]['text']
    return d['result'].get('isError', False), json.loads(text)

def zt(path, method='GET'):
    req = urllib.request.Request(f'{ZT_BASE}/api.php/v1{path}', method=method,
        headers={'Token': zt_token(), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

_zt_tok = None
def zt_token():
    global _zt_tok
    if _zt_tok:
        return _zt_tok
    req = urllib.request.Request(f'{ZT_BASE}/api.php/v1/tokens', method='POST',
        data=json.dumps({'account': ZT_ACCOUNT, 'password': ZT_PASSWORD}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        _zt_tok = json.loads(r.read().decode())['token']
    return _zt_tok

def tiny_png():
    w = h = 40
    rows = b''
    for _ in range(h):
        rows += b'\x00' + bytes([60, 120, 200]) * w
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows))
            + chunk(b'IEND', b''))

def main():
    if not MCP_URL:
        sys.exit('Set MCP_URL (and ZT_* for cleanup assertions)')
    # 1. list products
    d = mcp('list_products', {'limit': 2})
    t = json.loads(d['result']['content'][0]['text'])
    report('list_products readable', not d['result'].get('isError'), f"total={t.get('total')}")
    products = t.get('products') or []
    if not products:
        sys.exit('No products visible to this account — aborting write tests')
    pid = products[0]['id']

    # 2. create bug with image (web flow) — cleaned up at the end
    ts = time.strftime('%m%d%H%M')
    b64 = base64.b64encode(tiny_png()).decode()
    d = mcp('create_bug', {'productID': pid, 'title': f'smoke-{ts}',
        'description': f'smoke test {ts} [截图:1]', 'assignedTo': ZT_ACCOUNT,
        'images': [{'base64': b64, 'filename': 'smoke.png'}]})
    err = d['result'].get('isError', False)
    t = json.loads(d['result']['content'][0]['text'])
    b = t.get('bug', {})
    imgs = t.get('images', {})
    ok2 = not err and imgs.get('embedded') == 1 and b.get('openedBy') == ZT_ACCOUNT
    report('create_bug with embedded image', ok2, json.dumps(t, ensure_ascii=False)[:150])
    bug_id = b.get('id')

    # 3. readback shows the file-read img reference
    if bug_id:
        err, rb = call('get_bug', {'id': bug_id})
        steps = str((rb.get('bug', rb) or {}).get('steps', ''))
        srcs = re.findall(r'<img[^>]*src="([^"]+)"', steps)
        report('readback contains file-read img', any('file-read-' in s for s in srcs), str(srcs))

    # 4. wrong secret rejected
    bad = urllib.request.Request(MCP_URL.rsplit('/', 1)[0] + '/wrong-secret',
        data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}).encode(),
        headers={'Content-Type': 'application/json', 'User-Agent': 'curl/8.9'})
    try:
        urllib.request.urlopen(bad, timeout=30)
        report('wrong secret rejected', False, 'accepted!')
    except urllib.error.HTTPError as e:
        report('wrong secret rejected', e.code == 401, f'HTTP {e.code}')

    print('\n===', sum(1 for x in results if x), '/', len(results), 'PASS ===')
    passed = all(results)

    # cleanup (soft delete)
    if bug_id and ZT_BASE:
        try:
            zt(f'/bugs/{bug_id}', method='DELETE')
            print('cleaned', bug_id)
        except Exception as e:
            print('cleanup failed:', str(e)[:120])
    sys.exit(0 if passed else 1)

if __name__ == '__main__':
    main()
