# dsh-web-share

> **先省钱地聊，再全力地干。** 在 DeepSeek 网页版把方案聊清楚，一键交给 DeepSeek Harness 去执行。

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4f46e5?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
[![Read-only](https://img.shields.io/badge/design-read--only-10b981?style=flat-square)](#只读是设计前提不是功能缺失)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d4?style=flat-square)](#前置要求)

[English](README.en.md) · 中文

---

## 这个插件解决什么问题：**省 token**

用过 agent 的人都知道，一件复杂活儿的前半段是"磨方案"：试措辞、比路子、来回改、推翻重来。

这段过程在 agent 里做**非常贵**——每一轮试探都在烧上下文和 token。但如果先在 **DeepSeek 网页版**里聊，它自带智能搜索和深度思考，**聊多久都不进 agent 的账**。

问题只剩最后一步：**聊完之后怎么交给 agent？** 复制粘贴？一段 200 条的对话根本贴不动。

这个插件把最后这一步变成**一次点击**：

```
网页版里把方案聊好（免费额度，随便聊）
        ↓
在 DSH 里点「导出到新对话」
        ↓
自动生成「交接包」+ 新建对话 + 预填进输入框
        ↓
你按回车 —— agent 拿着方案去写代码 / 写文件 / 干活
```

**省下的就是那几千到几万 token 的"磨需求"过程。** agent 只拿到结论，不陪你想。

---

## 它长什么样

一个插件，**两个入口**，行为一致：

| 入口 | 位置 |
|---|---|
| **侧栏「网页版导出」** | 侧栏 `插件 / 自动化任务 / 任务看板` 下面，点开是整页面板 |
| **对话栏「网页版」** | 和「对话」「轨迹」并列的第三个标签页 |

点「预览」可以展开最后 4 轮、勾选要**完整上传**的轮次，再点「导出所选 N 轮」；
也可以直接点「导出到新对话」用默认（最后 2 轮完整）。

点任意一条会话的「导出到新对话」，会：

1. 生成**交接包**：最后 2 轮逐字完整，更早的轮次压缩成一行
2. **新建一个对话**（自动选好工作区）
3. 把交接包**预填进那个新对话的输入框**——不发送，你自己按回车

### 为什么是「交接包」而不是全量转写

实测：一段 202 条消息的对话有 **25 万字符 ≈ 24 万 token**，塞进任何输入框都会炸。

而交接真正需要的是**方案定稿**——它在最后一两轮里。所以交接包长这样：

- **前情**：每轮一行（你的提问 + 它的回答各截一段），保留脉络
- **最后 2 轮**：逐字完整，一字不删

实测 30 轮的对话 → **6,620 字符**，其中最后 2 轮完整。**全量转写和目录文件都不会生成**，磁盘上不留东西。

---

## 前置要求

| 依赖 | 说明 |
|---|---|
| **Edge 或 Chrome** | 插件用 `playwright-core` 驱动**你系统里的浏览器**（不下载额外的 Chromium） |
| **DSH** | `>= 0.1.7-rc.2`（在 0.1.7-rc.2 与 0.2.1-rc.2 上验证过） |
| **Node** | `>= 20` |
| **平台** | **仅 Windows**（发布包 `os: win32`；macOS / Linux 上 npm 会按 `os` 字段拒绝安装，除非加 `--force`） |

> 已装 Tabbit 的用户也可以切到 `tabbit` 驱动（零登录，仅 Windows）：
> `DSWEB_DRIVER=tabbit node dsweb-share/dsweb.mjs doctor`

### 关于"浏览器适配性"——请务必先自测

⚠️ **这是本项目最需要注意的地方。**

插件不调用任何官方 API，而是用 Playwright 驱动一个**真实浏览器**去读 `chat.deepseek.com`。
这意味着它的稳定性取决于三件**不在我们控制范围内**的东西：

1. **你本机浏览器的情况**（Edge/Chrome 版本、是否被企业策略限制、配置目录是否可写）
2. **DeepSeek 网页端的前端实现**（接口路径、字段名随时可能变）
3. **网络环境**（企业代理、加速器、DNS 都可能影响）

**所以：装完之后请先按下面「自测清单」跑一遍，确认能用再日常使用。**
出问题不会损坏任何东西（插件只读），最坏情况就是读不到数据。

#### 自测清单（三条命令，1 分钟）

```powershell
cd <插件目录>\dsweb-share

node dsweb.mjs selftest        # ① 只读自检，必须通过
node dsweb.mjs doctor          # ② 看驱动与登录状态
node dsweb.mjs list --count 5  # ③ 真读一次会话列表
```

- ① 失败 → 文件被改动过，别用
- ② 显示 `playwright ⚪ 可用未登录` → 跑 `node dsweb.mjs login` 登录一次
- ③ 能列出标题 → **通了**；报错请把报错原文贴 issue

---

## 安装

```powershell
# 1) 装插件（会一并装 playwright-core，约 5 MB，不下载浏览器）
dsh plugin --profile web add github:huang13113/dsh-web-share
```

装完 **重启 DSH**（插件在启动时装配）。

```powershell
# 2) 登录一次（会弹出一个真实浏览器窗口）
cd "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-web-share\dsweb-share"
node dsweb.mjs login
```

在弹出的窗口里正常登录 `chat.deepseek.com`，登录成功后窗口自动关闭。
**插件不接触、也不保存你的密码**——登录态留在那个浏览器自己的配置目录里。

```powershell
# 3) 验证
node dsweb.mjs doctor
```

> 也可以直接在 DSH 面板里点 **「登录 DeepSeek」** 按钮，效果一样。

---

## 使用

**侧栏入口（推荐，任何状态下都能用）**

侧栏 → **「网页版导出」** → 找到那段对话 → 点 **「导出到新对话」** → 新对话已预填好 → 改一改按回车。

**对话栏标签页**

对话栏 → **「网页版」** → 同样点「导出到新对话」。

> 两个入口行为一致：都是**开新对话 + 预填**，不会往你当前这个对话里塞东西。

**给 agent 的工具**

```
read_deepseek_web action=list               # 列出所有网页版会话
read_deepseek_web action=read query="毕业论文"  # 返回交接包
```

**命令行**

```powershell
node dsweb.mjs doctor                          # 驱动 / 登录状态
node dsweb.mjs list --count 20                 # 列出会话
node dsweb.mjs handoff "毕业论文"               # 打印交接包
node dsweb.mjs export "毕业论文" --out D:\share  # 完整转写（存档用，会落盘）
```

---

## 亮点

| | |
|---|---|
| **省钱** | 把"磨需求"的 token 花在免费网页版上，agent 只接结论 |
| **一次点击** | 导出 = 生成交接包 + 新建对话 + 预填，不用复制粘贴 |
| **交接包** | 选中的轮次逐字完整 + 前情一行压缩；30 轮对话 → 6,600 字符 |
| **预览挑轮次** | 展开预览最后 4 轮，勾选要完整上传的那几轮（默认最后 2 轮） |
| **不落文件** | 交接包全内存传递，超长时的临时文件读完即删 |
| **只读** | 只发 GET。代码里有强制自检，改出写能力直接拒绝启动 |
| **零凭据落盘** | 登录态留在浏览器自己的配置目录，插件从不读写任何凭据文件 |
| **驱动可换** | `playwright`（默认，系统 Edge/Chrome）/ `tabbit`（已装 Tabbit 的人） |
| **两个入口** | 侧栏整页面板 + 对话栏标签页，都是官方座位，不是外挂浮层 |

---

## 只读是设计前提，不是功能缺失

生态里做"网页版接入"的项目，主流思路是把它变成 **模型提供方**——让网页版替你生成内容。那条路很诱人，代价是账号风险：

| 事实 | 出处 |
|---|---|
| 同账号并发生成，**不到 6 分钟触发 1 天临时封禁** | `cv-superding/dsh-deepseek-web-login` README 实测 |
| 判罚信号实证：`5` 临时禁言 / `10` **永久封禁** / `11` 设备风控 | `NIyueeE/ds-free-api` |
| 赛道最早的 `LLM-Red-Team/deepseek-free-api` **已因作者账号被封停更** | 下游 fork README |

**本项目只读。** 读历史不产生生成请求，和你自己翻聊天记录的流量没有本质区别。
这也是为什么它可以不逆向接口、不伪装指纹、不存可登录凭证。

### 强制自检

`dsweb-share/readonly.guard.json` 是只读铁律，**规则外置**（放在被扫描文件里会自我匹配）。
引擎每次启动先扫**自己所有源文件**，命中就 `throw`：

```
❌ 只读自检失败，拒绝运行。发现被禁止的模式：POST
```

铁律覆盖：生成接口、会话创建/删除/重命名、文件上传、以及 `POST/PUT/PATCH/DELETE`。

---

## 架构

```
┌──────────────────────────────────────────────┐
│ DSH Web GUI（浏览器）                          │
│   lib/client.js                               │
│   ├─ sidebar.panellist → 侧栏「网页版导出」      │
│   ├─ main#web-share    → 整页面板              │
│   └─ conversation.view → 对话栏「网页版」标签    │
└───────────────────┬──────────────────────────┘
                    │ 同源 fetch  /api/dsweb/*
┌───────────────────▼──────────────────────────┐
│ DSH 宿主（Node 进程）                          │
│   lib/index.js                                │
│   ├─ 工具 read_deepseek_web                    │
│   └─ 路由 list / handoff / login / read        │
└───────────────────┬──────────────────────────┘
                    │ spawn 子进程（只读）
┌───────────────────▼──────────────────────────┐
│ dsweb-share/dsweb.mjs   业务逻辑（解析/渲染）    │
│ dsweb-share/driver.mjs  驱动选择（auto）        │
│   ├─ driver-playwright  系统 Edge/Chrome        │
│   └─ driver-tabbit      Tabbit CLI             │
└───────────────────┬──────────────────────────┘
                    │ 页面上下文内 fetch
┌───────────────────▼──────────────────────────┐
│ 真实浏览器 → chat.deepseek.com                 │
└──────────────────────────────────────────────┘
```

**关键设计**：桥接层里没有 LLM。让子代理"看着浏览器点点点"会烧掉几万 token，正好抵消省下来的量——所以这一层是纯确定性代码。

---

## 和同类项目的区别

这块生态已经有人在做，我把差异摆出来，你自己判断要不要用：

| 项目 | 做什么 | 和本项目的区别 |
|---|---|---|
| [`xmuwenxiang/dsh-web-chat`](https://github.com/xmuwenxiang/dsh-web-chat) | 在 DSH 里**用网页版聊天**（可发消息、可回填），并能把对话「迁移」成任务简报 | 它会**替你发消息**（走生成接口）；迁移时**用 LLM 蒸馏**（要花 token）。本项目**只读不发送**，交接包是**确定性拼装、零 LLM** |
| [`cv-superding/dsh-deepseek-web-login`](https://github.com/cv-superding/dsh-deepseek-web-login) | 把网页版当**模型 provider**，用免费额度驱动 agent | 同样需要生成请求；本项目不碰生成侧 |
| [`KyMi-22/dsh-deepseek-web`](https://github.com/KyMi-22/dsh-deepseek-web) · [`sbbbx/dsh-client-ui-webchat`](https://github.com/sbbbx/dsh-client-ui-webchat) | 把网页版对话接进 DSH | 功能取向往"聊天/双向搬运"靠；本项目只解决**单向交接**这一件事 |
| `dsh-share` / `dsh-share-link` / `dsh-qr-share` 等 | 会话**分享**（公网链接、二维码） | 名字里都有 share，但做的是"把会话发出去"，不是"把网页版对话交给 agent" |

**一句话定位**：别人做的是「让网页版替 agent 干活」，本项目做的是「让 agent 接着你们聊好的方案干活」。
前者需要生成、有账号风险；后者只读、零风险。

如果你需要的是"在 DSH 里直接和网页版对话"，[`dsh-web-chat`](https://github.com/xmuwenxiang/dsh-web-chat) 更合适；
如果你只是想**把聊好的结论交出去**，本项目的交接包更省。

---

## 常见问题

**Q：面板是空的 / 标签在但没内容？**

宿主半边加载失败时 DSH 是静默的。跑 `node docs/read-diag.mjs` 看诊断日志。

**Q：`doctor` 显示"可用未登录"？**

跑 `node dsweb.mjs login`，或在面板里点「登录 DeepSeek」。

**Q：点了导出没反应 / 报错？**

先跑自测清单。若仍失败，看浏览器控制台里的 `[dsweb]` 日志，或把 `node dsweb.mjs list` 的报错贴到 issue。

**Q：能不用 Playwright、直接用我开着的浏览器吗？**

做不到透明：普通启动的浏览器没开调试端口，而且跨域限制让 DSH 页面读不到 DeepSeek。
本项目的做法是"用你系统的 Edge/Chrome，但配一个独立配置目录"，登录一次即可。

**Q：会用我日常的浏览器登录态吗？**

不会。插件有自己的配置目录（`~/.dsh/web-share/browser-profile`），和你日常用的浏览器互不影响。

---

## DSH Desktop（桌面端）说明

桌面端是 Electron 应用，插件在里面**不需要特殊配置**，但有三点要知道：

**① 登录时确实会弹一个系统浏览器窗口**

因为 DeepSeek 的登录态（`userToken`）只能存在于浏览器 profile 里，而 Electron 的 profile
对第三方插件是拿不到的。所以首次使用会：

```
点「登录 DeepSeek」→ 弹出系统 Edge/Chrome 的一个新窗口
        ↓ 你正常登录 chat.deepseek.com
        窗口自动关闭（登录态存进插件自己的配置目录）
        ↓
之后**完全后台静默**：不再弹窗，导出直接走无头浏览器
```

这个窗口是**独立配置**的（`~/.dsh/web-share/browser-profile`），不会带出你日常浏览器的标签页、书签、历史。

**② 为什么不在 Electron 里内嵌登录**

内嵌需要应用层提供 webview / BrowserView 的插件 API，而 DSH 目前没有把这层开放给插件；
退而求其次"复用你 Electron 里的会话"也不行——那属于应用自身的 profile，插件无权限访问。

**③ 引擎拉起方式已做兼容**

桌面端跑在 Electron 里，`process.execPath` 指向应用本体而不是 node。
插件拉起引擎时会自动带上 `ELECTRON_RUN_AS_NODE=1`，否则会把整个应用再启动一次。
这个分支已在代码中处理；如果你在桌面端遇到"点了没反应"，请先跑自测清单并把报错贴出来。

> 桌面端的 profile 名通常是 `desktop`：
> `dsh plugin --profile desktop add github:huang13113/dsh-web-share`

---

## 开发笔记：踩过的坑

完整版见 [docs/DESIGN.md](docs/DESIGN.md)。摘要：

| 坑 | 现象 | 原因 |
|---|---|---|
| **`ctx` 是代理** | 插件静默不生效 | 读任何未在 `inject` 声明的属性直接抛错，连 `typeof` 试探都不行 |
| **宿主失败是静默的** | 客户端标签照常渲染，宿主不注册路由 | 两条加载路径独立；必须落盘诊断日志 |
| **HTTP 200 ≠ 成功** | 列表静默变空 | 业务错误在 `biz_code` 里 |
| **`count` 太小非法** | 探活误报"未登录" | `fetch_page?count=1` 返回 `ILLEGAL_COUNT`，最小要用 20 |
| **`startSession({prompt})` 的 prompt 会被吞** | 建了会话但输入框是空的 | 草稿在 composer 挂载时被清；改成"建→切→挂载后重试写草稿" |
| **复用空白会话会吞新交接包** | 点了没反应、显示旧内容 | `requestDraftInitialization` 遇到非空草稿返回 `preserved`；改成每次新建 |
| **Playwright 上下文不释放** | 命令跑完不退出 | 持久化上下文会保活进程，必须显式 `close()` |

---

## 路线图

- [ ] CDP 驱动：连你自己用 `--remote-debugging-port` 启动的 Edge/Chrome（复用现有登录态）
- [ ] 多站点抽象（其他 web AI 的会话接口）
- [ ] 面板内预览交接包（先看再导）
- [ ] 工作区下拉（默认最近使用的）

---

## 免责声明

> ⚠️ **非官方项目**：与 DeepSeek 无关联，未获授权或赞助。"DeepSeek" 为其权利人商标。
>
> ⚠️ **浏览器适配性风险**：插件依赖真实浏览器与网页端私有接口，**可能因浏览器版本、企业策略或网页改版而失效**。请先按自测清单验证。
>
> ⚠️ **数据边界**：读的是**你自己账号**的会话，只在本机处理。请勿把导出的转写提交到公开仓库。
>
> ⚠️ **协议风险**：驱动网页端读取自身数据属于灰色地带。本插件刻意限制为只读、低频、手动触发，但不构成合规保证。
>
> ⚠️ **按现状提供**：作者不提供担保（见 MIT License）。

---

## License

[MIT](LICENSE)
