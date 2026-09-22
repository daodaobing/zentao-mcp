# zentao-mcp — 在 ChatGPT 里直接管理禅道

一个零依赖的 [Cloudflare Worker](https://workers.cloudflare.com/)，把禅道（ZenTao 21+）的项目管理能力以 **MCP 连接器**形式接入 ChatGPT。电脑关机也能用——部署在云端，ChatGPT 直连你的禅道服务器。

```
ChatGPT（网页 / 任意设备）
   │  MCP over HTTPS（URL 内置访问密钥）
   ▼
Cloudflare Worker（本仓库，免费额度足够个人与中小团队）
   │  REST API v1 + 网页会话（自动登录 / 自动续期）
   ▼
你的禅道（公网可访问即可，21.x 实测）
```

## 能力

| 读取 | 写入 |
|---|---|
| 产品 / 项目 / 执行（迭代） | 创建 / 修改 / 关闭需求 |
| 需求 / 任务 / Bug 列表与详情 | 创建 / 修改任务（指派、截止日期、关联需求） |
| 用户列表（账号 ↔ 姓名对照） | 创建 / 修改迭代 |
| | **创建 / 修改 Bug**（指派、挂项目） |
| | **截图内嵌**到 Bug 重现步骤（非附件，打开详情直接看图） |

内置防呆（全部来自真实踩坑，详见代码注释）：

- **写操作一律 JSON body**——禅道 PUT 不解析表单，POST 表单会静默丢字段（如任务指派人）
- **创建后回读校验**：HTTP 200 ≠ 业务成功（禅道校验失败也返回 200 + `result:fail`）；指派人无效会被服务端静默丢弃，连接器回读发现不一致会自动删除残留并报错
- **产品 / 项目预检**：服务端不校验 ID 存在性，会照常创建指向不存在产品的垃圾数据
- **Bug 默认挂项目**（不允许 project=0 的产品级 Bug），默认映射可配置
- 图片部分失败时返回 `BUG_CREATED_IMAGE_FAILED`（含成功/失败明细），不删除已建 Bug
- token 过期自动重登录，零维护

## 快速开始（单用户，约 5 分钟）

前置：一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）+ 公网可访问的禅道（21.x）。

```bash
git clone https://github.com/daodaobing/zentao-mcp.git
cd zentao-mcp
npx wrangler login          # 浏览器授权一次

npx wrangler deploy         # 部署，得到 https://<name>.<you>.workers.dev

# 配置密钥（每次会提示输入值）
npx wrangler secret put ZT_BASE       # 例如 https://zentao.example.com
npx wrangler secret put ZT_ACCOUNT    # 禅道账号（英文）
npx wrangler secret put ZT_PASSWORD   # 禅道密码
npx wrangler secret put MCP_SECRET    # 随机串，如 openssl rand -hex 16
# 可选：Bug 默认挂的项目映射，如 {"7":93} 表示产品 7 默认挂项目 93
npx wrangler secret put ZT_PRODUCT_PROJECT_MAP
```

然后在 ChatGPT 里注册连接器：

1. 打开 chatgpt.com → 左下角头像 → **设置 → 账户安全与登录 → 开启开发者模式**
2. 返回设置 → **插件 → 创建连接器**：
   - 名称：`禅道`
   - MCP 服务器 URL：`https://<name>.<you>.workers.dev/mcp/<MCP_SECRET>`
   - 身份验证：无身份验证
3. 在聊天输入框的工具里启用「禅道」，然后就可以说：

> “看一下 DMS 当前迭代还有哪些任务没完成”
> “把仓库调拨单这个需求录入禅道，拆成前端/后端任务派给张三李四”
> “提个 Bug：通知公告发布后后台列表不显示，指派给王安庆，带这两张截图”

## 多用户：同事用自己的禅道账号

三种模式，按信任模型选择。

### 模式 A · 网页自助注册（同事零依赖，管理员零后续，推荐）

同事打开 Worker 首页，凭邀请码 + 自己的禅道账号密码自助拿到专属连接器地址——**不需要管理员在场，也不需要装任何东西**。

一次性启用（管理员）：

```bash
npx wrangler kv namespace create ZT_USERS
# 把返回的 id 填进 wrangler.jsonc 的 kv_namespaces

npx wrangler secret put INVITE_CODE   # 邀请码，发给同事（改它即可让旧码失效）
npx wrangler secret put REG_KEY       # 32 字节随机 hex：openssl rand -hex 32
npx wrangler deploy
```

之后把 `https://<name>.<you>.workers.dev/` 和邀请码发给同事即可。注册页会：

- 用提交的凭据**实时登录禅道校验**（错误密码直接拒绝，不落盘）
- 生成他的专属 MCP URL，页面直接展示 ChatGPT 绑定步骤
- 凭据以 **AES-GCM 加密**存入 KV（密钥是 REG_KEY，独立于禅道账号）
- 同一账号重复注册自动**轮换**地址（旧的立即失效）——地址泄露时同事可自助作废

### 模式 B · 管理员代开（环境变量）

```bash
# 为同事 wanganqing 开通（大写账号作环境变量后缀）
npx wrangler secret put ZT_SECRET_WANGANQING   # 同事专属随机串 → 生成 URL 用
npx wrangler secret put ZT_USER_WANGANQING     # 同事的禅道密码
```

同事拿到的 URL：`https://<name>.<you>.workers.dev/mcp/<ZT_SECRET_WANGANQING>`，按上面同样的步骤在**他自己的** ChatGPT 里注册连接器即可。

### 模式 C · 各自部署（完全隔离）

每人 fork 本仓库 → 自己的 Cloudflare 账号 → 按快速开始部署。凭据不出自己的掌控，互不信任也无所谓。

三种模式下同事创建的 Bug `openedBy` 都是**他们自己的账号**，审计归属清晰。

> 信任说明：模式 A/B 下同事的禅道密码存放在**你的** Cloudflare 账号里（A 为加密 KV，B 为 secret——secret 只写不可读）。不合适就换模式 C。

## 截图内嵌是怎么做的

禅道 v1 REST API 会把富文本字段里的 `<img>` 标签整体剥掉（data URI 和外链都剥）。本连接器复刻了网页编辑器的真实流程：

1. 网页登录（`md5(md5(密码)+rand)` 双重哈希，内置纯 JS MD5）
2. `POST /file-ajaxUpload.html` 上传图片（multipart 字段名必须是 `imgFile`）→ 得到 `file-read-N.png` URL
3. 通过网页表单保存 Bug，`steps` 里带 `<img src="...">` → 与人工在网页上贴图完全一致

图片需要禅道登录态才能看（匿名 302），开发在禅道内打开 Bug 即直接可见。

## 限制与说明

- **ChatGPT 网页里用户上传的图片无法直接转传**：那是模型的视觉输入，拿不到字节或可转发 URL。可行路径：截图有公网 URL 时传 `url`；或通过能读本地文件的本地 agent 提 Bug（转 base64）。
- 工具参数里的指派人用**禅道账号**（英文，如 `wanganqing`），不是中文姓名；先用 `list_users` 查。
- 每个连接器 URL 就是一把钥匙——泄露即他人可用，可用 `wrangler secret put` 随时轮换。
- 刻意不暴露删除接口，防误删。
- 在 ZenTao 21.7 上实测开发；v2 API（`/api.php/v2`）在 21.7 未启用（返回空 200），本连接器走 v1。

## 冒烟测试

```bash
export MCP_URL='https://<name>.<you>.workers.dev/mcp/<secret>'
export ZT_BASE=... ZT_ACCOUNT=... ZT_PASSWORD=...   # 直连禅道用于清理断言
python test/smoke.py
```

## License

[MIT](LICENSE)
