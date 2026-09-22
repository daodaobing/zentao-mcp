# 禅道 MCP 插件 · 完整安装教程

> 一句话：让 ChatGPT 直接读写你的禅道（查任务、提 Bug、建需求），跑在云端，电脑关了也能用。
>
> - **同事（使用者）**：只看 [第二部分](#第二部分同事安装约-3-分钟)，3 分钟搞定
> - **管理员（部署者）**：先做 [第一部分](#第一部分管理员部署约-10-分钟一次性)，一次性 10 分钟

---

## 第一部分：管理员部署（约 10 分钟，一次性）

### 0. 前置条件

| 需要 | 说明 |
|---|---|
| 禅道服务器 | 21.x 实测可用，**公网可访问**（有 https 地址） |
| Cloudflare 账号 | [免费注册](https://dash.cloudflare.com/sign-up)，免费额度足够个人和中小团队 |
| Node.js 18+ | [nodejs.org](https://nodejs.org) 下载安装（Windows / Mac 均可） |

### 1. 拉取代码并登录 Cloudflare

```bash
git clone https://github.com/daodaobing/zentao-mcp.git
cd zentao-mcp
npx wrangler login        # 会弹浏览器，点 Allow 授权
```

### 2. 创建 KV 存储（自助注册功能用）

```bash
npx wrangler kv namespace create ZT_USERS
```

把输出里的 `"id": "xxxx"` 填进 `wrangler.jsonc`：

```jsonc
"kv_namespaces": [
  { "binding": "ZT_USERS", "id": "把这里替换成你的 id" }
]
```

### 3. 部署

```bash
npx wrangler deploy
```

输出类似：`https://zentao-mcp.你的名字.workers.dev` ——记下这个地址。

### 4. 配置密钥（逐条执行，按提示输入值）

```bash
# ── 必填：单账号模式（管理员自己的连接器）──────────────
npx wrangler secret put ZT_BASE       # 禅道地址，如 https://zentao.example.com （结尾不带 /）
npx wrangler secret put ZT_ACCOUNT    # 管理员的禅道账号（英文）
npx wrangler secret put ZT_PASSWORD   # 禅道密码
npx wrangler secret put MCP_SECRET    # 管理员专属钥匙：随机串，见下方生成方法

# ── 推荐：Bug 默认挂的项目映射（可选）──────────────────
# JSON 格式：产品ID -> 项目ID。提 Bug 不传项目时自动挂
npx wrangler secret put ZT_PRODUCT_PROJECT_MAP    # 例如 {"7":93}

# ── 推荐：开启网页自助注册（同事自己注册，见第二部分）──
npx wrangler secret put INVITE_CODE   # 邀请码，自定一个发同事，如 team-2026
npx wrangler secret put REG_KEY       # 加密密钥：随机 64 位 hex，见下方生成方法
```

随机串生成（二选一）：

```bash
openssl rand -hex 16     # Mac/Linux 自带，用于 MCP_SECRET
openssl rand -hex 32     # 用于 REG_KEY
```

Windows（PowerShell，无 openssl 时）：

```powershell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })    # 生成 64 位 hex
-join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })    # 生成 32 位 hex
```

> ⚠️ **REG_KEY 务必备份保存**（存密码管理器）。丢了它，所有通过网页注册的同事都会失效（需重新注册）；它本身不是禅道密码，泄露只影响加密存储的注册数据。

### 5. 验证部署

浏览器打开 `https://zentao-mcp.你的名字.workers.dev/`：

- 看到「禅道 MCP 连接器 · 自助注册」页面 → 部署成功
- 显示 503 提示未启用 → 检查 INVITE_CODE / REG_KEY / KV 三样是否都配了

管理员自己的连接器地址：

```
https://zentao-mcp.你的名字.workers.dev/mcp/<MCP_SECRET 的值>
```

### 6. 发给同事

把这两样发到群里，你的部署工作就结束了：

1. 注册页地址：`https://zentao-mcp.你的名字.workers.dev/`
2. 邀请码

---

## 第二部分：同事安装（约 3 分钟）

> 全程只需要浏览器。手机也能完成注册，但建议用电脑装连接器。

### 第 1 步：注册，拿到你的专属地址（1 分钟）

1. 打开管理员发给你的**注册页地址**
2. 填写三格：
   - **邀请码**：管理员发的那个
   - **禅道账号**：你的英文账号（就是平时登录禅道的账号，如 `zhangsan`）
   - **禅道密码**：你平时登录禅道的密码
3. 点「生成我的连接器地址」
4. 看到**注册成功**和一条绿色地址 → 点「复制地址」

常见报错：

| 提示 | 原因 |
|---|---|
| 邀请码不正确 | 找管理员核对 |
| 禅道账号或密码不正确 | 就是你登录禅道网页用的账号密码，检查大小写 |
| 尝试过于频繁 | 1 小时后再试 |

### 第 2 步：在 ChatGPT 里绑定（2 分钟，只需一次）

1. 打开 [chatgpt.com](https://chatgpt.com) 并登录**你自己的账号**
2. 左下角头像 → **Settings（设置）** → **Apps & Connectors（应用与连接器）** → **Advanced settings（高级设置）** → 打开 **Developer mode（开发者模式）**
3. 返回 **Connectors（连接器）** 页 → 点 **Create（创建）**：
   - Name（名称）：`禅道`
   - MCP Server URL：粘贴第 1 步复制的那条地址
   - Authentication（身份验证）：选 **No authentication（无身份验证）**
   - 点 Create
4. 回到聊天输入框 → 点工具图标（⚒/＋）→ 勾选「**禅道**」
5. 随便发一句：**“查一下产品列表”** ——能返回数据就装好了 🎉

### 第 3 步：开始用（示例话术）

| 你说 | 它做 |
|---|---|
| “看一下 DMS 当前迭代还有哪些任务没完成” | 查迭代任务并汇总 |
| “把 XX 这个需求录入禅道，拆成前端/后端两个任务” | 建需求 + 建任务并派工 |
| “提个 Bug：XX 页面点保存没反应，指派给王安庆” | 创建 Bug（挂默认项目）|
| “这个 Bug 改派给 zhangsan” | 修改负责人 |
| “查一下账号 zhangsan 的真名” / “列一下用户” | 账号↔姓名对照 |

**两个小规矩：**

- 指派人请说**禅道账号**（英文，如 `wanganqing`），不要说中文姓名；不确定就让它“列一下用户”
- 带**截图**的 Bug：目前请把截图放到有公网链接的地方（或交给能读你电脑文件的 agent 助手），直接在 ChatGPT 里贴图暂时传不过去（平台限制）

### 安全须知（每个同事都看一眼）

- 你的专属地址**等同于你的禅道身份**，不要发给任何人（包括转发给其他同事——让他们自己注册）
- 地址泄露了怎么办：回到注册页用同一账号**再注册一次**，旧地址自动作废，换新地址到 ChatGPT 里重新绑定即可，全程不用找管理员

---

## 第三部分：常见问题

### 同事侧

**Q：ChatGPT 说连接器出错 / 一直转圈？**
按顺序查：①开发者模式开了吗 ②URL 粘贴完整吗（以 `/mcp/` 开头一长串）③到注册页重新注册拿新 URL 换上。

**Q：能用，但建 Bug / 建任务报错？**
看报错里的中文提示（禅道原样返回的校验错误），比如『截止日期不能为空』——把缺的信息补上让它重发即可。连接器已内置大部分默认值，正常说话不用管字段。

**Q：换了台电脑 / 换了手机，要重装吗？**
不用。连接器绑在你的 ChatGPT 账号上，任何设备登录 ChatGPT 都直接可用。

### 管理员侧

**Q：怎么换邀请码（有人离职）？**
```bash
echo 新邀请码 | npx wrangler secret put INVITE_CODE
```
旧码立即失效；**已注册的同事不受影响**。

**Q：怎么强制停用某个同事的地址？**
```bash
# 查 KV 找到他的 secret
npx wrangler kv key list --namespace-id <你的KV_id> --remote
# 删除它（删除后其 URL 立即 401）
npx wrangler kv key delete --namespace-id <你的KV_id> --remote "s:<那串secret>" --force
```
（Windows 上 wrangler kv delete 若报错崩溃，改用 REST API，见仓库 DEPLOY 模板。）

**Q：同事忘了地址？**
让他重新注册一次（同账号重注册=换新地址），或管理员从 KV 里查 `u:<账号>` 对应的 secret 拼出地址。

**Q：禅道改密码了？**
网页注册的同事：自己重新注册一次即可。环境变量模式的：`npx wrangler secret put ZT_USER_<账号>` 更新。

**Q：升级版本？**
```bash
git pull && npx wrangler deploy
```
Secrets 和 KV 数据不受影响。

**Q：这套东西安全吗？**
- 禅道密码存在**你自己的** Cloudflare 账号里：网页注册的是 AES-GCM 加密 KV，环境变量的是 secret（只写不可读）
- 每条连接器地址都是独立钥匙，可独立作废
- 本项目刻意**不暴露删除接口**，ChatGPT 误操作删不掉禅道数据
- 代价模型：全部流量走 Cloudflare→禅道，不经任何第三方服务器

---

## 附录：架构一图流

```
同事的 ChatGPT ──┐
你的 ChatGPT  ───┼──> Cloudflare Worker（zentao-mcp）──> 你的禅道服务器
                  │         │
                  │         └── KV：加密的注册凭据
                  │
                  └── 每人一条专属 /mcp/<secret> 地址
                      管理员：注册页 + 邀请码控制准入
```

部署问题提 [GitHub Issues](https://github.com/daodaobing/zentao-mcp/issues)，使用问题找你们的管理员。
