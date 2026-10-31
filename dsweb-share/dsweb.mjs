#!/usr/bin/env node
/**
 * dsweb — DeepSeek 网页版对话「只读」取回引擎
 *
 * 设计约束（硬规则，违反即拒绝运行）：
 *   1. 只发出读请求，绝不含任何写方法（GET 之外一律不出现）
 *   2. 绝不调用生成接口（不代用户发言）
 *   3. 绝不创建、删除、重命名会话，绝不上传文件
 *   4. 永不把 token / cookie 写入磁盘或打印
 *
 * 架构：本文件只放**业务逻辑**（解析、渲染、CLI）；
 *       浏览器由 driver-*.mjs 提供，统一接口只有 `getJson(path)`。
 *       所有请求都在「真实浏览器页面上下文」内发出，自带同源 cookie 与反爬头。
 *
 * 驱动：playwright（默认，系统 Edge/Chrome + 独立配置，需登录一次）
 *       tabbit（已装 Tabbit 的用户，零配置）
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectDriver, describeDrivers, disposeAll } from "./driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_RETURN_CHARS = 120_000;

// ---------------------------------------------------------------- 只读自检

/**
 * 只读自检：规则外置在 readonly.guard.json，扫描**所有引擎文件**。
 * 规则必须外置——写在被扫描文件里会自我匹配。
 */
export async function selfCheck() {
  const guard = JSON.parse(readFileSync(new URL("readonly.guard.json", import.meta.url), "utf8"));
  const files = readdirSync(HERE).filter((f) => f.endsWith(".mjs"));
  const violations = [];

  for (const file of files) {
    const src = readFileSync(join(HERE, file), "utf8");
    for (const sub of guard.forbiddenSubstrings) {
      if (src.includes(sub)) violations.push(`${file}: 端点 ${sub}`);
    }
    for (const m of guard.forbiddenHttpMethods) {
      const re = new RegExp(`["'\`]${m}["'\`]|method\\s*:\\s*["'\`]${m}["'\`]`, "i");
      if (re.test(src)) violations.push(`${file}: HTTP 方法 ${m}`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `只读自检失败，拒绝运行。发现被禁止的模式：\n  ${violations.join("\n  ")}\n` +
      "（dsweb 是只读工具，任何写操作都不允许。）",
    );
  }
  return true;
}

// ---------------------------------------------------------------- API 解析

/** 解析 DeepSeek 的响应信封。注意：业务失败时 HTTP 仍是 200，必须查 biz_code。 */
function parseEnvelope(res) {
  if (res.status !== 200) return { error: `HTTP ${res.status}：${String(res.text).slice(0, 200)}` };
  let p;
  try { p = JSON.parse(res.text); } catch { return { error: "响应不是合法 JSON" }; }
  if (p.code !== 0) return { error: `接口 code=${p.code} msg=${p.msg ?? ""}` };
  const d = p.data;
  if (d?.biz_code !== 0) return { error: `业务错误 biz_code=${d?.biz_code} biz_msg=${d?.biz_msg ?? ""}` };
  return { data: d.biz_data };
}

/** 列出会话。count 上限 100，超过会 ILLEGAL_COUNT。 */
export async function listSessions(driver, { count = 50 } = {}) {
  const safe = Math.min(Math.max(1, Math.floor(count)), 100);
  const r = await driver.getJson(`/api/v0/chat_session/fetch_page?count=${safe}`);
  const p = parseEnvelope(r);
  if (p.error) throw new Error(`列出会话失败：${p.error}`);
  return (p.data?.chat_sessions ?? []).map((s) => ({
    id: s.id,
    title: s.title || "(无标题)",
    updatedAt: s.updated_at,
    // 上游已移除 current_message_id；缺失就不给这个字段
    ...(typeof s.current_message_id === "number" ? { messages: s.current_message_id } : {}),
  }));
}

/** 按 ID 或标题片段定位会话。 */
async function findSession(driver, want) {
  const all = await listSessions(driver, { count: 100 });
  const lower = String(want).toLowerCase();
  const hits = all.filter((s) => s.id === want || String(s.title).toLowerCase().includes(lower));
  if (hits.length === 0) {
    throw new Error(`没找到匹配的会话：${want}（已扫描最近 ${all.length} 条）。可先运行 list 看看标题。`);
  }
  return hits[0];
}

/** 取一个会话的全部消息，并归并成「轮」（用户 + 助手）。 */
export async function fetchRounds(driver, session) {
  const r = await driver.getJson(`/api/v0/chat/history_messages?chat_session_id=${session.id}`);
  const p = parseEnvelope(r);
  if (p.error) throw new Error(`读取会话失败：${p.error}`);
  const msgs = p.data?.chat_messages ?? [];
  if (msgs.length === 0) throw new Error("这个会话是空的。");

  const pick = (m, type) => (m.fragments ?? []).filter((f) => f.type === type).map((f) => f.content || "").join("");
  const bodyOf = (m) => {
    const req = pick(m, "REQUEST");
    const resp = pick(m, "RESPONSE");
    return m.role === "USER" ? (req || resp) : (resp || req);
  };

  const rounds = [];
  for (const m of msgs) {
    if (m.role === "USER") rounds.push({ user: bodyOf(m), assistant: "" });
    else if (rounds.length === 0) rounds.push({ user: "", assistant: bodyOf(m) });
    else rounds[rounds.length - 1].assistant += (rounds[rounds.length - 1].assistant ? "\n\n" : "") + bodyOf(m);
  }
  return { title: session.title, sessionId: session.id, rounds };
}

/** 单条预览里每个角色最多显示多少字（只用于界面展示，导出时用的是全文）。 */
const PEEK_CHARS = 320;

/**
 * 预览最后 N 轮，供用户挑选要完整上传的轮次。
 *
 * 只回传**截断后的文本**：真正的全文在导出时才重新读取渲染，
 * 这样既不会把大段内容塞进预览接口，也不让客户端有机会篡改要上传的内容。
 */
export async function previewRounds(driver, target, tailN = 4) {
  const session = await findSession(driver, target);
  const packed = await fetchRounds(driver, session);
  const total = packed.rounds.length;
  const n = Math.max(1, Math.min(Number(tailN) || 4, 20));
  const start = Math.max(0, total - n);
  const rounds = packed.rounds.slice(start).map((r, k) => ({
    n: start + k + 1,
    userChars: r.user.length,
    assistantChars: r.assistant.length,
    userPeek: squeeze(r.user).slice(0, PEEK_CHARS),
    assistantPeek: squeeze(r.assistant).slice(0, PEEK_CHARS),
  }));
  return { title: packed.title, totalRounds: total, from: start + 1, to: total, rounds };
}

// ---------------------------------------------------------------- 渲染
const squeeze = (s) => String(s).replace(/\s+/g, " ").trim();
const cut = (s, n) => {
  const t = squeeze(s);
  return t.length <= n ? t : t.slice(0, n) + "…";
};

/**
 * 交接包：**被选中的轮次逐字完整**，其余轮次压缩成一行。
 *
 * 交接要的是"方案定稿"，它通常在最后几轮里；全量转写会撑爆上下文。
 *
 * @param picked - 要完整保留的轮次号（1 基，对应 UI 里显示的「第 N 轮」）。
 *                 省略时默认取最后 2 轮。
 */
export function renderHandoff({ title, rounds, picked, tailRounds, headChars = 60, headBudget = 12000 }) {
  const total = rounds.length;

  // 选中集合（0 基）。默认 = 最后 2 轮。
  let keep;
  if (Array.isArray(picked) && picked.length > 0) {
    keep = new Set(picked.map((n) => Number(n) - 1).filter((i) => Number.isInteger(i) && i >= 0 && i < total));
  } else {
    const n = Math.max(1, Math.min(tailRounds ?? 2, total));
    keep = new Set(Array.from({ length: n }, (_, k) => total - n + k));
  }
  if (keep.size === 0) keep = new Set([total - 1]);

  const headIdx = [];
  const tailIdx = [];
  for (let i = 0; i < total; i += 1) (keep.has(i) ? tailIdx : headIdx).push(i);

  const head = headIdx.map((i) => rounds[i]);
  const pickedSummary = tailIdx.map((i) => i + 1).join("、");

  const lines = [];
  lines.push(`# 交接：${title}`, "");
  lines.push(`> 来源：chat.deepseek.com 网页版 · 共 ${total} 轮对话`);
  lines.push(`> **第 ${pickedSummary} 轮完整保留**（你选中的方案定稿）；其余轮次压缩成一行。`, "");
  lines.push("---", "");

  if (head.length > 0) {
    lines.push("## 一、前情（压缩）", "");
    let used = 0;
    for (let k = 0; k < head.length; k += 1) {
      const r = head[k];
      const n = headIdx[k] + 1;
      const line = `- **第 ${n} 轮**｜我：${cut(r.user, headChars) || "（空）"}　／　DeepSeek：${cut(r.assistant, headChars) || "（空）"}`;
      if (used + line.length > headBudget) {
        lines.push(`- …（前面还有 ${head.length - k} 轮，因篇幅省略）`);
        break;
      }
      used += line.length;
      lines.push(line);
    }
    lines.push("", "---", "");
  }

  lines.push(`## 二、完整保留的 ${tailIdx.length} 轮`, "");
  for (const i of tailIdx) {
    const r = rounds[i];
    const n = i + 1;
    if (r.user) lines.push(`### 👤 我（第 ${n} 轮）`, "", r.user.trim() || "（空）", "");
    if (r.assistant) lines.push(`### 🤖 DeepSeek（第 ${n} 轮）`, "", r.assistant.trim() || "（空）", "");
  }

  const text = lines.join("\n");
  const tailChars = tailIdx.reduce((n, i) => n + rounds[i].user.length + rounds[i].assistant.length, 0);
  const totalChars = rounds.reduce((n, r) => n + r.user.length + r.assistant.length, 0);
  return {
    text,
    rounds: total,
    tail: tailIdx.length,
    picked: tailIdx.map((i) => i + 1),
    tailChars,
    totalChars,
    chars: text.length,
  };
}

/** 完整转写（存档用）。 */
export function renderMarkdown({ title, sessionId, rounds }) {
  const lines = [`# ${title}`, "", "> 来源：chat.deepseek.com 网页版 · 只读导出",
    `> 会话 ID：\`${sessionId}\``, `> 轮次：${rounds.length} · 导出时间：${new Date().toISOString()}`, "", "---", ""];
  rounds.forEach((r, i) => {
    const n = i + 1;
    if (r.user) lines.push(`## [${n}] 👤 用户`, "", r.user.trim() || "（空）", "", "---", "");
    if (r.assistant) lines.push(`## [${n}] 🤖 DeepSeek`, "", r.assistant.trim() || "（空）", "", "---", "");
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------- CLI

function usage() {
  console.log(`dsweb — DeepSeek 网页版对话只读取回引擎

用法：
  node dsweb.mjs doctor                        查看浏览器驱动与登录状态
  node dsweb.mjs login                         首次登录（弹出浏览器窗口，手动登录一次）
  node dsweb.mjs list [--count N] [--json]     列出网页版会话
  node dsweb.mjs preview <ID或标题> [--tail 4] 预览最后 N 轮（挑要完整上传的轮次）
  node dsweb.mjs handoff <ID或标题> [--pick 28,29]  生成交接包（选中的轮次完整，其余压缩）
  node dsweb.mjs export <ID或标题> --out DIR   导出完整转写（存档用）
  node dsweb.mjs selftest                      只读自检

选项：
  --driver playwright|tabbit|auto   选浏览器驱动（默认 auto）
  --tail N                          handoff 默认保留最后几轮，默认 2；preview 预览几轮，默认 4
  --pick 28,29                      handoff 指定要完整保留的轮次号（逗号分隔）
  --head-chars N                    handoff 前情每条保留多少字，默认 60

安全：只用 GET，永不发言、永不创建/删除会话、永不落盘凭证。
`);
}

function flag(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

async function main() {
  await selfCheck();

  const argv = process.argv.slice(2);
  const jsonOnly = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [cmd, ...rest] = args;
  const driverName = flag(rest, "--driver", undefined);

  if (!cmd || cmd === "help" || cmd === "--help") { usage(); return; }

  if (cmd === "selftest") {
    console.log("✅ 只读自检通过：引擎各文件中不含写方法 / 生成接口 / 会话增删模式。");
    return;
  }

  if (cmd === "doctor") {
    const drivers = await describeDrivers();
    let chosen = null;
    try { chosen = await selectDriver(driverName); } catch { /* 报告里说明 */ }
    const report = { drivers, chosen: chosen ? chosen.name : null };
    if (jsonOnly) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log("浏览器驱动：");
    for (const d of drivers) {
      const mark = d.ready ? "✅ 已登录" : d.available ? "⚪ 可用未登录" : "❌ 不可用";
      console.log(`  ${d.driver.padEnd(11)} ${mark}${d.reason ? "  (" + d.reason + ")" : ""}`);
    }
    console.log(`\n当前使用：${report.chosen ?? "（无可用驱动）"}`);
    if (report.chosen === "playwright") {
      console.log("配置目录：可用 DSWEB_PROFILE 覆盖；首次使用请先跑 `node dsweb.mjs login`。");
    }
    return;
  }

  if (cmd === "login") {
    const driver = await selectDriver(driverName === undefined ? "playwright" : driverName);
    console.log(`使用驱动：${driver.name}`);
    if (driver.name === "tabbit") {
      const r = await driver.login();
      console.log(r.ok ? "✅ Tabbit 里已有登录态，可直接使用。" : `⚠️ ${r.reason}`);
      return;
    }
    console.log("请在弹出的浏览器窗口里登录 chat.deepseek.com …（最多等 5 分钟）");
    const r = await driver.login();
    if (r.ok) console.log(`✅ 登录成功（${r.channel ?? driver.name}），窗口已关闭。`);
    else console.error(`❌ ${r.reason}`);
    if (typeof driver.dispose === "function") await driver.dispose();
    if (!r.ok) process.exit(1);
    return;
  }

  const driver = await selectDriver(driverName);
  try {
    if (cmd === "list") {
      const count = Number(flag(rest, "--count", "50"));
      const sessions = await listSessions(driver, { count });
      if (jsonOnly) { console.log(JSON.stringify({ ok: true, count: sessions.length, sessions }, null, 2)); return; }
      console.log(`共 ${sessions.length} 条会话：\n`);
      const hasCounts = sessions.some((s) => typeof s.messages === "number");
      if (hasCounts) {
        console.log("| # | 标题 | 消息数 | 更新时间 |");
        console.log("|---|---|---|---|");
        sessions.forEach((s, i) => console.log(`| ${i + 1} | ${s.title} | ${s.messages ?? "-"} | ${fmt(s.updatedAt)} |`));
      } else {
        console.log("| # | 标题 | 更新时间 |");
        console.log("|---|---|---|");
        sessions.forEach((s, i) => console.log(`| ${i + 1} | ${s.title} | ${fmt(s.updatedAt)} |`));
      }
      return;
    }

    if (cmd === "preview") {
      const skip = new Set();
      for (const f of ["--tail", "--driver"]) {
        const i = rest.indexOf(f);
        if (i >= 0) { skip.add(i); skip.add(i + 1); }
      }
      const target = rest.filter((a, i) => !a.startsWith("--") && !skip.has(i)).join(" ").trim();
      if (target === "") { console.error("请给出会话 ID 或标题片段。"); process.exit(2); }
      const pv = await previewRounds(driver, target, Number(flag(rest, "--tail", "4")));
      if (jsonOnly) { console.log(JSON.stringify({ ok: true, ...pv })); return; }
      console.log(`《${pv.title}》共 ${pv.totalRounds} 轮，预览第 ${pv.from}–${pv.to} 轮：\n`);
      for (const r of pv.rounds) {
        console.log(`── 第 ${r.n} 轮 ──`);
        console.log(`  我(${r.userChars}字)：${r.userPeek}`);
        console.log(`  DS(${r.assistantChars}字)：${r.assistantPeek}\n`);
      }
      return;
    }

    if (cmd === "handoff" || cmd === "export") {
      const skip = new Set();
      for (const f of ["--count", "--tail", "--head-chars", "--out", "--driver", "--pick"]) {
        const i = rest.indexOf(f);
        if (i >= 0) { skip.add(i); skip.add(i + 1); }
      }
      const target = rest.filter((a, i) => !a.startsWith("--") && !skip.has(i)).join(" ").trim();
      if (target === "") { console.error("请给出会话 ID 或标题片段。"); process.exit(2); }

      const session = await findSession(driver, target);
      const packed = await fetchRounds(driver, session);

      if (cmd === "handoff") {
        const pickRaw = flag(rest, "--pick", "");
        const pick = pickRaw === "" ? undefined : String(pickRaw).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        const out = renderHandoff({
          title: packed.title,
          rounds: packed.rounds,
          picked: pick,
          tailRounds: Number(flag(rest, "--tail", "2")),
          headChars: Number(flag(rest, "--head-chars", "60")),
        });
        if (jsonOnly) {
          console.log(JSON.stringify({ ok: true, title: packed.title, ...out, tailRounds: out.tail }));
          return;
        }
        console.log(out.text);
        console.error(`\n[交接包] ${packed.title} · ${out.rounds} 轮（完整保留最后 ${out.tail} 轮）· ${out.chars} 字符`);
        return;
      }

      // export：写完整转写（唯一会落盘的路径）
      const outDir = resolve(flag(rest, "--out", join(process.cwd(), "_shared")));
      mkdirSync(outDir, { recursive: true });
      const safe = String(packed.title).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "conversation";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const mdPath = join(outDir, `${safe}-${stamp}.md`);
      writeFileSync(mdPath, renderMarkdown({ title: packed.title, sessionId: packed.sessionId, rounds: packed.rounds }), "utf8");
      const result = { ok: true, title: packed.title, rounds: packed.rounds.length, markdown: mdPath };
      if (jsonOnly) { console.log(JSON.stringify(result)); return; }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.error(`未知命令：${cmd}`);
    usage();
    process.exit(2);
  } finally {
    if (typeof driver.dispose === "function") await driver.dispose();
  }
}

function fmt(epochSec) {
  if (!epochSec) return "";
  try {
    const d = new Date(epochSec * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ""; }
}

// 入口判断：Windows 盘符路径下必须用 pathToFileURL 比较
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main()
    // 必须显式释放浏览器，否则 Playwright 的持久化上下文会让进程一直挂着
    .then(async () => { await disposeAll(); })
    .catch(async (e) => {
      console.error("❌ " + (e && e.message ? e.message : e));
      await disposeAll();
      process.exit(1);
    });
}
