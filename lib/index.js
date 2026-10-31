/**
 * dsh-plugin-dsweb — 宿主半边
 *
 * 职责：
 *   1. 注册只读工具 `read_deepseek_web`，让主会话能列出/读取用户网页版对话
 *   2. 注册同源 HTTP 路由，供同包的浏览器面板调用：
 *        GET /api/dsweb/list         → 会话列表
 *        GET /api/dsweb/read?q=...   → 导出并返回指定会话的转写切片
 *
 * 数据来源：同包的 dsweb-share/dsweb.mjs。它只做只读请求（自带
 * readonly.guard.json 自检），真正的网络访问发生在用户**已登录的真实浏览器**
 * 上下文里，本插件从不接触、也从不落盘任何凭证。
 *
 * 边界：
 *   - 不注册 root / sidebar / conversation / details 等 single 座位（注册它们会让整列消失）
 *   - HTTP 路由只用 /api/dsweb 前缀，不与任何官方或第三方路由冲突
 */

import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { constants as FS, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsweb";
export const inject = ["tools", "webServer"];

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 只读引擎 dsweb.mjs 的位置。
 *
 * 插件通常以 junction / link 方式安装，包目录里只有随包发布的内容，
 * 因此不能假设引擎固定在哪一层——逐个候选探测；
 * 全都找不到时明确报错，而不是静默返回空列表让用户以为是"没有会话"。
 */
const CLI_CANDIDATES = [
  join(HERE, "..", "dsweb-share", "dsweb.mjs"),
  join(HERE, "dsweb-share", "dsweb.mjs"),
];

let cliPathCache;

/** 定位可用的只读引擎路径；找不到返回 null。 */
async function resolveCli() {
  if (cliPathCache !== undefined) return cliPathCache;
  for (const candidate of CLI_CANDIDATES) {
    try {
      await access(candidate, FS.R_OK);
      cliPathCache = candidate;
      return candidate;
    } catch { /* 试下一个候选 */ }
  }
  cliPathCache = null;
  return null;
}

const MAX_RETURN_CHARS = 120_000;

/** 单次调用的默认超时：浏览器冷启动 + 大对话取回都可能偏慢。 */
const CLI_TIMEOUT_MS = 180_000;

/**
 * 从子进程输出中提取第一个完整的 JSON 值。
 *
 * 不能只取「以 { 开头的那一行」——非紧凑 JSON 会跨多行输出，
 * 那样只会拿到 `{` 一个字符，解析必然失败（真实踩过：成功的结果被当成失败）。
 * 这里用括号配对扫描，并跳过字符串字面量（含转义），
 * 因此 JSON 内部的 `{`、`}`、`"` 都不会算错边界。
 */
function extractJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { depth += 1; continue; }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 提取最有诊断价值的错误行。
 *
 * 直接取 stderr 最后一行是错的：Node 崩溃时最后一行是 `Node.js v26.7.0`，
 * 真正的原因在更上面——那样等于把排查引向完全无关的方向。
 * 只读引擎失败时也会把 JSON 打到 stdout，因此还要回退看 stdout。
 */
function meaningfulError(stderr, stdout) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== ""
      && !/^Node\.js v\d/.test(line)
      && !/^\^+$/.test(line)
      && !/^at\s/.test(line));
  if (lines.length > 0) {
    const errLine = lines.find((line) => /Error|错误|失败|Cannot|MODULE_NOT_FOUND|ENOENT/.test(line));
    return (errLine ?? lines[0]).slice(0, 400);
  }
  const out = stdout.trim();
  return out === "" ? "只读引擎没有产生任何输出。" : out.slice(0, 400);
}

/**
 * 执行只读引擎。
 * @param args - 传给引擎的参数
 * @param options.timeoutMs - 超时（登录要开浏览器窗口，需要更长）
 * @param options.raw - true 时返回 {code,out,err} 而不是解析 JSON（登录用）
 */
async function runCli(args, { timeoutMs = CLI_TIMEOUT_MS, raw = false } = {}) {
  const cli = await resolveCli();
  if (cli === null) {
    throw new Error(
      "找不到只读引擎 dsweb.mjs —— 插件包内缺少 dsweb-share 目录。" +
      `（已尝试：${CLI_CANDIDATES.join(" 以及 ")}）`,
    );
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 忽略 */ }
      reject(new Error(`只读取回超时（${Math.round(timeoutMs / 1000)} 秒）。浏览器可能未运行，或网页版响应过慢。`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动只读引擎：${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // raw 模式：登录这类命令输出的是人话而不是 JSON，只看退出码
      if (raw) { resolve({ code, out, err }); return; }
      const parsed = extractJson(out);
      if (parsed) {
        // 浏览器程序内部的失败以 __dswebError 标记返回（例如"没找到匹配的会话"），
        // 它是**失败**而不是成功结果——必须转成异常，否则会被当成"导出成功但没有数据"。
        if (typeof parsed.__dswebError === "string") {
          reject(new Error(parsed.__dswebError));
          return;
        }
        resolve(parsed);
        return;
      }
      reject(new Error(meaningfulError(err, out)));
    });
  });
}

const listSessions = () => runCli(["list", "--count", "100", "--json"]);

/**
 * 导出会话。
 *
 * 显式传 --out：否则引擎会把产物写到**它自己所在目录**下的 _shared，
 * 而那是插件包内部（junction 安装时即用户的 node_modules），
 * 产物既不好找、也可能被后续安装操作清掉。
 */
const exportSession = (target, outDir) => runCli(["export", target, "--json", "--out", outDir]);

/**
 * 读取转写文件中的正文切片。
 * @param path - 转写文件绝对路径
 * @param maxChars - 返回字符上限
 */
async function readTranscriptSlice(path, maxChars) {
  const raw = await readFile(path, "utf8");
  const total = raw.length;
  if (total <= maxChars) return { text: raw, truncated: false, totalChars: total };
  return {
    text: `${raw.slice(0, maxChars)}\n\n…（已截断，原文共 ${total} 字符；` +
      `如需其他段落，请直接按行读取完整转写文件，或用更精确的标题重新导出）`,
    truncated: true,
    totalChars: total,
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export function apply(ctx, config = {}) {
  // 诊断日志：宿主半边一旦启动就写一行落盘。
  // 插件在宿主侧加载失败时 DSH 不会弹错——客户端照样能渲染标签，宿主却不注册路由，
  // 现象就是"标签在、里面空的"。没有这个文件就只能靠猜。
  const diag = (stage, detail) => {
    try {
      appendFileSync(
        join(tmpdir(), "dsweb-host.log"),
        `${new Date().toISOString()} [dsweb] ${stage}${detail ? " :: " + detail : ""}\n`,
        "utf8",
      );
    } catch { /* 诊断失败绝不能影响主流程 */ }
  };
  diag("apply 进入", `tools=${typeof ctx.tools} webServer=${typeof ctx.webServer}`);

  try {
    // 导出目录必须落在插件包之外。
    //
    // 注意：绝不能用 `ctx.dshHome` 试探式访问 —— cordis 的 ctx 是代理，
    // 读取任何未在 `inject` 里声明的属性都会抛
    // `cannot get property "dshHome" without inject`，
    // 那会让整个 apply() 在注册任何东西之前就挂掉（真实踩过的坑）。
    // DSH 必定导出 DSH_HOME 环境变量，直接用它即可。
    const dshHome = process.env.DSH_HOME ?? join(HERE, "..", "..", "..");
    const outDir = config.outDir ?? join(dshHome, "dsweb-shared");
    diag("导出目录", outDir);

    registerTool(ctx, outDir, diag);
    registerRoutes(ctx, outDir, diag);

    diag("apply 完成", `导出目录 ${outDir}`);
    ctx.logger?.info?.(`dsweb: 只读取回已就绪（导出目录 ${outDir}）`);
  } catch (e) {
    diag("apply 抛错", String(e && e.message ? e.message : e));
    throw e;
  }
}

/**
 * 生成「交接包」：最后 N 轮完整、前面压缩成一行。
 * 与 exportSession 的区别：不产出任何用户可见文件（超长时的临时文件读完即删）。
 */
const handoffPack = (target, { tail = 2, outDir } = {}) =>
  runCli(["handoff", target, "--json", "--tail", String(tail), "--out", outDir]);

/** 注册主会话可用的只读工具。 */
function registerTool(ctx, outDir, diag) {
  const definition = {
    name: "read_deepseek_web",
    description:
      "读取用户 DeepSeek 网页版（chat.deepseek.com）的对话记录。用户习惯先在网页版把需求聊清楚，" +
      "再用这个工具把那段对话交给主会话继续干活。只读：绝不发送消息、绝不创建或删除会话。" +
      "action=list 列出会话；action=read 返回该会话的「交接包」（最后两轮完整、前面压缩成一行），" +
      "不要用 read 去拿全量转写——只有确需逐字核对全文时才传 full=true。",
    // register() 接收的是**原始 JSON Schema**：required 必须是对象级的
    // 「属性名数组」，绝不能写成属性内的 required: true
    // ——后者会让整份 schema 非法，插件在加载期直接抛错。
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "read"],
          description: "list 列出网页版会话；read 导出并读取一个会话。",
        },
        query: {
          type: "string",
          description: "action=read 时必填：会话 ID 或标题片段。",
        },
        maxChars: {
          type: "integer",
          description: `action=read 时返回内容的最大字符数（默认 ${MAX_RETURN_CHARS}）。`,
        },
        full: {
          type: "boolean",
          description: "action=read 时返回完整转写（会落盘，体积大）。默认 false，用交接包。",
        },
      },
      required: ["action"],
    },
    output: {
      // 输出 schema 必须存在（register 强制要求 { schema, render }）。
      // 用宽松对象容纳成功与失败两种返回形状：失败路径没有 text，
      // 所以不能声明对象级 required —— 否则失败返回会被判为非法输出。
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          text: { type: "string" },
          markdown: { type: "string" },
          outline: { type: "string" },
          title: { type: "string" },
          count: { type: "integer" },
          rounds: { type: "integer" },
          tailRounds: { type: "integer" },
          messages: { type: "integer" },
          totalChars: { type: "integer" },
          truncated: { type: "boolean" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok === false
          ? `读取失败：${value.error ?? "未知错误"}`
          : String(value.text ?? ""),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = args?.action;

      if (action === "list") {
        try {
          const r = await listSessions();
          const rows = r.sessions ?? [];
          // 消息数来自网页端接口，该字段可能被上游移除；
          // 全部缺失时就不出这一列，而不是给一整列「-」。
          const hasCounts = rows.some((s) => typeof s.messages === "number");
          const text = [
            `共 ${rows.length} 条网页版会话（按更新时间倒序）：`,
            "",
            ...(hasCounts
              ? [
                  "| 标题 | 消息数 |",
                  "|---|---|",
                  ...rows.map((s) => `| ${s.title} | ${s.messages ?? "-"} |`),
                ]
              : [
                  "| 标题 |",
                  "|---|",
                  ...rows.map((s) => `| ${s.title} |`),
                ]),
          ].join("\n");
          return { ok: true, text, count: rows.length };
        } catch (e) {
          return { ok: false, error: String(e.message ?? e) };
        }
      }

      if (action === "read") {
        const query = String(args?.query ?? "").trim();
        if (query === "") {
          return { ok: false, error: "action=read 需要提供 query（会话 ID 或标题片段）。" };
        }
        const cap = Math.min(Math.max(2000, Number(args?.maxChars) || MAX_RETURN_CHARS), MAX_RETURN_CHARS);
        try {
          // 默认返回「交接包」：最后两轮完整、前面压缩，且不产生任何用户可见文件。
          // 只有显式 full=true 才导出完整转写（会落盘，用于需要逐字核对全文的场合）。
          if (args?.full !== true) {
            const h = await handoffPack(query, { tail: 2, outDir });
            if (!h?.ok) return { ok: false, error: "生成交接包失败。" };
            const full = String(h.text ?? "");
            const text = full.length > cap
              ? full.slice(0, cap) + `\n\n…（已截断，交接包共 ${full.length} 字符；需要全文请用 full=true）`
              : full;
            return {
              ok: true,
              title: h.title,
              rounds: h.rounds,
              tailRounds: h.tailRounds,
              totalChars: h.totalChars,
              truncated: full.length > cap,
              text,
            };
          }

          const r = await exportSession(query, outDir);
          if (!r?.ok) return { ok: false, error: "导出没有成功。" };
          const slice = await readTranscriptSlice(r.markdown, cap);
          return {
            ok: true,
            title: r.title,
            messages: r.messages,
            totalChars: r.totalChars,
            markdown: r.markdown,
            outline: r.outline,
            truncated: slice.truncated,
            text: `已读取《${r.title}》（${r.messages} 条消息，正文 ${r.totalChars} 字符）\n` +
              `完整转写：${r.markdown}\n目录：${r.outline}\n\n---\n\n${slice.text}`,
          };
        } catch (e) {
          return { ok: false, error: String(e.message ?? e) };
        }
      }

      return { ok: false, error: `未知 action：${String(action)}` };
    },
  };
  ctx.tools.register(definition);
  diag("工具注册成功", "read_deepseek_web");
}

/** 注册浏览器面板调用的同源路由。 */
function registerRoutes(ctx, outDir, diag) {
  ctx.webServer.register({
    kind: "prefix",
    path: "/api/dsweb",
    async handler(req, res) {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        sendJson(res, 400, { ok: false, error: "非法请求。" });
        return;
      }

      const route = url.pathname.replace(/^\/api\/dsweb\/?/, "");

      if (route === "list" && req.method === "GET") {
        try {
          const r = await listSessions();
          sendJson(res, 200, { ok: true, sessions: r.sessions ?? [] });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e.message ?? e) });
        }
        return;
      }

      // 交接包：面板的「导出」走这条。返回可直接写进输入框的纯文本，
      // 不产生用户可见文件（引擎内部超长时的临时文件读完即删）。
      if (route === "handoff" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q === "") { sendJson(res, 400, { ok: false, error: "缺少参数 q。" }); return; }
        const tailRaw = Number(url.searchParams.get("tail"));
        const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(Math.floor(tailRaw), 10) : 2;
        try {
          const r = await handoffPack(q, { tail, outDir });
          if (!r?.ok) { sendJson(res, 200, { ok: false, error: "生成交接包失败。" }); return; }
          sendJson(res, 200, {
            ok: true,
            title: r.title,
            text: r.text,
            bytes: r.bytes,
            chars: typeof r.text === "string" ? r.text.length : 0,
            rounds: r.rounds,
            tailRounds: r.tailRounds,
            totalChars: r.totalChars,
            tailChars: r.tailChars,
          });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e.message ?? e) });
        }
        return;
      }

      // 首次使用：打开一个真实浏览器窗口让用户登录 DeepSeek（插件绝不代填凭据）。
      // 这是通用驱动（playwright + 系统 Edge/Chrome）的必经一步。
      if (route === "login" && req.method === "GET") {
        try {
          const r = await runCli(["login", "--driver", "playwright"], {
            timeoutMs: 330_000,
            raw: true,
          });
          const ok = r.code === 0;
          const raw = ok ? (r.out || "") : (r.err || r.out || "");
          sendJson(res, 200, { ok, message: raw.trim().split(/\r?\n/).slice(-4).join("\n").slice(0, 600) });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e.message ?? e) });
        }
        return;
      }

      if (route === "read" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q === "") { sendJson(res, 400, { ok: false, error: "缺少参数 q。" }); return; }
        try {
          const r = await exportSession(q, outDir);
          if (!r?.ok) { sendJson(res, 200, { ok: false, error: "导出没有成功。" }); return; }
          sendJson(res, 200, {
            ok: true,
            title: r.title,
            messages: r.messages,
            totalChars: r.totalChars,
            markdown: r.markdown,
            outline: r.outline,
          });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e.message ?? e) });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: `未知路由：${route}` });
    },
  });
  diag("路由注册成功", "prefix /api/dsweb");
}
