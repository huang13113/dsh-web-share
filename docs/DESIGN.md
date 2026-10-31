# 设计笔记

这份文档记录**为什么这么做**，以及做的时候撞到的每一堵墙。写给两类人：

1. 想改这个插件的人
2. 想做 DSH 双面插件（宿主 + 客户端）的人 —— 第 4 节是踩坑清单，能省你好几个小时

---

## 1. 为什么是「只读」

做"网页版接入"最直觉的路线是把它变成模型提供方：拦截生成、转成 API、让 agent 用免费额度跑。

**这条路我们主动放弃了。** 不是因为难，是因为代价落在用户的账号上。

生态里的实测证据（都来自公开项目，非本项目测量）：

| 现象 | 出处 |
|---|---|
| 同账号并发生成不到 6 分钟 → 临时封禁 1 天 | `cv-superding/dsh-deepseek-web-login` README |
| 该插件作者自己 4 个账号两天内陆续被限制，主嫌是单请求体量（实测单次输入 9.7k → 293k token） | 同上 |
| 判罚 `biz_code`：`5` 临时禁言、`10` 永久封禁、`11` 设备风控 | `NIyueeE/ds-free-api` |
| 赛道最早的 `LLM-Red-Team/deepseek-free-api` 已因作者账号被封停更 | 下游 fork README |
| 2026-10 起官方客户端给 `/chat/completion` 带 `x-hif-leim` 短时令牌（TTL 600s），不带该头即可判定非官方客户端 | `NIyueeE` README |

生成请求是**可被判罚的行为**。读历史不是——它和你自己翻聊天记录没有本质区别，不产生生成请求、不触发频率风控。

所以设计约束定死为：

> **宁可功能少一半，也不让用户的账号承担风险。**

这条约束直接决定了后面所有技术选择。

---

## 2. 为什么桥接层里没有 LLM

最初的设想很自然：派个子代理进浏览器，让它看着页面点按钮。

问题在成本：

| 做法 | token 开销 |
|---|---|
| 子代理 + 浏览器技能自己摸索 | 全程 30–80k token |
| 直接调确定性脚本 | 0.3–0.6k（提问）+ 结果 |

省 token 是这个项目的**目的**，而"派子代理点点点"正好把省下来的量又烧回去。所以桥接层是一段**纯确定性代码**：固定选择器、固定流程、固定解析。

代价是脆：网页一改版就失效。这个代价被接受，因为浏览器程序内还可以用 `tabbit.observe` 兜底重新定位。

---

## 3. 数据链路

```
DSH Web GUI (127.0.0.1:3080)
  └─ lib/client.js
       ctx.slots.inject("conversation.view", () => ctx.slots.register({
         name: "conversation.view", id: "dsweb", order: 20, label: () => "网页版"
       }, DsWebPanel))
       └─ fetch("api/dsweb/list") · fetch("api/dsweb/read?q=...")
                    ↓ 同源，带 GUI 自己的会话
DSH 宿主（Node）
  └─ lib/index.js
       ├─ ctx.tools.register({ name: "read_deepseek_web", ... })
       └─ ctx.webServer.register({ kind: "prefix", path: "/api/dsweb", ... })
                    ↓ spawn 子进程（只读）
dsweb-share/dsweb.mjs
  └─ selftest → 定位引擎 → 提交浏览器程序 → 收 JSON
                    ↓ tabbit-cli nodejs（Playwright 1.62）
真实浏览器（已登录 chat.deepseek.com）
  ├─ GET /api/v0/chat_session/fetch_page?count=N     → 会话列表
  └─ GET /api/v0/chat/history_messages?chat_session_id=...  → 完整对话
```

为什么分三层而不是两层：

- **客户端**跑在浏览器里，跨域调不到 chat.deepseek.com（CSP + CORS 双重拦截，实测所有预检都失败）
- **宿主**跑在 Node 里，但 Node 直连会被判非官方客户端（TLS 指纹 + 缺少 `x-hif-*` 头，实测返回 `40003 Authorization Failed`）
- **真实浏览器**才有合法身份

所以必须一路下钻到浏览器上下文。

---

## 4. DSH 插件踩坑清单

这一节全部是**实测撞出来的**，不是读文档推测的。

### 4.1 `ctx` 是代理，未声明的属性访问会抛错

```js
// ❌ 这样写，插件在注册任何东西之前就挂了
const home = typeof ctx.dshHome === "string" ? ctx.dshHome : fallback;
// Error: cannot get property "dshHome" without inject
```

cordis 的 `ctx` 不是普通对象，是**服务注入代理**。只有 `inject` 里声明过的服务才能读。

```js
// ✅ 正确：要么声明，要么别碰
export const inject = ["tools", "webServer"];
const home = process.env.DSH_HOME ?? fallback;
```

**教训**：连"试探式访问"（`typeof x === 'string'`）都不行，代理在取属性那一刻就抛。

### 4.2 宿主加载失败是静默的

插件分两条独立加载路径：

- **客户端半边**：由 boot 清单（`window.__DSH_BOOT__`）加载 → 失败会有客户端渲染错误
- **宿主半边**：由 cordis loader 激活 → 失败**界面上完全看不出来**

结果就是「标签页在、点进去空的」这种最难查的现象：客户端渲染成功，宿主 `apply()` 早就抛了。

```js
// ✅ 唯一有效的排查手段：落盘诊断
const diag = (stage, detail) => appendFileSync(
  join(tmpdir(), "dsweb-host.log"),
  `${new Date().toISOString()} [dsweb] ${stage}${detail ? " :: " + detail : ""}\n`,
  "utf8",
);
diag("apply 进入", `tools=${typeof ctx.tools} webServer=${typeof ctx.webServer}`);
```

`docs/read-diag.mjs` 会读这个日志并直接给结论。

### 4.3 HTTP 200 ≠ 业务成功

```json
{ "code": 0, "data": { "biz_code": 1, "biz_msg": "ILLEGAL_COUNT", "biz_data": null } }
```

HTTP 状态是 **200**，业务其实失败了。`fetch_page` 的 `count` 上限是 100，超了就是这个响应。

```js
// ✅ 必须查 biz_code
const __parse = (res) => {
  if (res.status !== 200) return { error: ... };
  const p = JSON.parse(res.text);
  if (p.code !== 0) return { error: ... };
  if (p.data?.biz_code !== 0) return { error: `biz_code=${p.data?.biz_code} ${p.data?.biz_msg}` };
  return { data: p.data.biz_data };
};
```

**教训**：不查 `biz_code` 的后果是"列表静默变空"，比报错难查一百倍。

### 4.4 浏览器程序的返回值有 16 KiB 上限

Tabbit 的 `nodejs` 程序返回值超过 `inlineResultThresholdBytes`（16384）会退化成资源引用：

```json
{ "result": { "resourceId": "...", "byteLength": 2415236 } }
```

2.4 MB 的对话根本传不回来。

```js
// ✅ 解法：让浏览器程序自己渲染 + 写盘，只回摘要
const fs = await import("node:fs");
fs.writeFileSync(mdPath, markdown, "utf8");
return { ok: true, path: mdPath, bytes: fs.statSync(mdPath).size };
```

实测这样 202 条消息 553 KB 也是 **2 秒**完成，因为数据从来没离开过浏览器进程。

### 4.5 JSON Schema 的 `required` 只认对象级数组

```js
// ❌ 插件加载期直接抛
properties: { action: { type: "string", required: true } }
// JsonSchemaError: ... required is not supported on type "string"

// ✅
properties: { action: { type: "string" } },
required: ["action"],
```

而且 **`output.schema` 必须存在**，`register()` 强制要求 `{ schema, render }`。失败路径没有 `ok`/`text` 时，别在对象级 required 里声明它们，否则失败返回会被判非法输出。

### 4.6 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM

后果是 JSON 解析失败（`Unexpected token '﻿'`），以及中文源码被按 ANSI 解码后变成乱码、整份文件语法错误。

```powershell
# ❌
Set-Content -Path x.json -Encoding UTF8
# ✅
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
```

**教训**：改 UTF-8 源码不要用 PowerShell 的字符串管道，会毁掉中文。

### 4.7 `dsh plugin add` 不会把包加进 bundle 列表

装完会看到：

```
warning: dsh-web-brief declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

把 `dsh.bundle.patch` 补进 package.json 之后，`dump-config` 里仍然没有这一行。原因：`dsh plugin add` 只写 `dependencies`，**不会改 `dsh.profile.bundles`**，必须手动加。

验证方法：

```powershell
dsh --profile web --dump-config | Select-String "ui-web-brief"
```

### 4.8 一次性试装 profile 必须自己 `pnpm install`

手工建 profile 目录后直接启动会报：

```
cannot resolve profile bundle "dsh-web-brief" from the dsh installation or <profile dir>
```

因为 junction / node_modules 还没建。先 `pnpm install --no-frozen-lockfile`。

另外**试装服务器要用备用端口**：端口被占时 `webserver`（`required`）激活失败，`webServer` 服务就不存在，所有依赖它的插件（包括本插件）全部卡在 `missing: ['webServer']`，看起来像插件自身的问题。

---

## 5. 只读自检是怎么工作的

规则**外置**在 `readonly.guard.json`：

```json
{
  "forbiddenSubstrings": ["/chat/completion", "chat_session/create", "chat_session/delete", "chat_session/rename", "/file/upload_file"],
  "forbiddenHttpMethods": ["POST", "PUT", "PATCH", "DELETE"]
}
```

引擎每次启动先扫自己的源码，命中就 `throw`。

**为什么规则必须外置**：如果把正则字面量写在被扫描的文件里，自检一定把自己抓出来。第一版就踩了这个坑——注释里写了 `/chat/completion` 都算违规。

```js
// 扫描的是这段逻辑之外的文件内容
const guard = JSON.parse(readFileSync(new URL("readonly.guard.json", here), "utf8"));
const src = readFileSync(new URL("dsweb.mjs", here), "utf8");
for (const sub of guard.forbiddenSubstrings) {
  if (src.includes(sub)) violations.push(sub);
}
```

代价：想加写能力得同时改代码和规则文件。这是刻意的摩擦，不是疏漏。

---

## 6. 大对话为什么必须切片

实测（真实对话）：

| 对话 | 消息 | 正文字符 | 导出字节 |
|---|---|---|---|
| A | 202 | 253,003 | 553 KB |
| B | 70 | 66,601 | 442 KB |
| C | 54 | 125,059 | 776 KB |

A ≈ 24 万 token。任何主流上下文窗口都装不下，硬塞只会被截断或直接失败。

所以每次导出写两个文件：

- `<标题>-<时间戳>.md` —— 完整转写，一字不丢
- `<标题>-<时间戳>.outline.md` —— 目录：`| # | 角色 | 字符数 | 开头 60 字 |`

工作流是**先读目录、再读段落**，像人读长文档先看目录。

完整性校验方式（也写进了验收标准）：正文字符 + 思考链字符 ≈ 接口声明的总字符，误差 < 1%。

---

## 7. 上游漂移记录

网页端私有接口没有兼容承诺，已知变更：

| 时间 | 变更 | 影响 |
|---|---|---|
| 2026-10 | `chat_session/fetch_page` 移除 `current_message_id`、`seq_id`、`agent`、`version`、`inserted_at` | 会话列表拿不到消息数；已改为优雅降级（缺就只显示时间） |

**设计对策**：所有字段读取都容忍缺失；缺数据时降级显示，而不是显示 `-` 或报错。

---

## 8. 如果想换成 Chrome / Edge

只看一处：`dsweb-share/dsweb.mjs` 的 `TABBIT_CLI`。

```js
const TABBIT_CLI = process.env.TABBIT_CLI ?? join(process.env.LOCALAPPDATA, "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe");
```

替换成 CDP 驱动（或 Playwright 连一个 `--remote-debugging-port` 的 Chrome）即可，上层逻辑完全不用动。需要注意：

1. 必须复用**用户已登录的真实 profile**，不能新建无头实例（否则登录态、指纹都不对）
2. Chrome 136+ 禁止在默认 profile 上开 `--remote-debugging-port`，需要复制 profile 或使用独立 user-data-dir
3. 页面内的 `page.fetch` 语义要保留——请求必须从 chat.deepseek.com 的页面上下文发出，才能带上同源 cookie 与反爬头

这是仓库路线图的第一项，欢迎 PR。
