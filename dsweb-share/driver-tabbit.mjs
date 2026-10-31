/**
 * Tabbit 驱动
 *
 * 用 Tabbit Browser 的 CLI 在**已登录的真实浏览器**里发请求。
 * 适合已经装了 Tabbit 的用户（Windows）。
 *
 * 实现要点：Tabbit 的返回值有 16 KiB 内联上限，超了会退化成 resourceId。
 * 因此把「大结果自己写盘 → Node 读 → 立刻删」这层绕路**封装在本驱动内部**，
 * 上层业务代码完全不需要知道这个限制。
 */

import { spawn } from "node:child_process";
import { access, readFile, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";

const ORIGIN = "https://chat.deepseek.com";
const TASK_NAME = "dsweb-share";
const CLI_TIMEOUT_MS = 180_000;

/** Tabbit CLI 的位置（可用 TABBIT_CLI 覆盖）。 */
const TABBIT_CLI =
  process.env.TABBIT_CLI ??
  join(process.env.LOCALAPPDATA ?? "", "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe");

export const name = "tabbit";

/** Tabbit CLI 是否存在。 */
export async function available() {
  try {
    await access(TABBIT_CLI, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 当前是否已有可用的登录态（靠 list 探一次，零额度）。 */
export async function status() {
  try {
    const r = await getJson("/api/v0/chat_session/fetch_page?count=20");
    if (r.status !== 200) return { ready: false, reason: `HTTP ${r.status}` };
    const p = JSON.parse(r.text);
    return { ready: p.code === 0 && p?.data?.biz_code === 0, reason: null };
  } catch (e) {
    return { ready: false, reason: String(e.message ?? e) };
  }
}

/**
 * 登录：Tabbit 复用用户日常浏览器，通常已登录。
 * 这里只做一次探测，不尝试自动登录（绝不代为输入凭据）。
 */
export async function login() {
  const s = await status();
  if (s.ready) return { ok: true, alreadyLoggedIn: true, driver: name };
  return {
    ok: false,
    driver: name,
    reason: "请在 Tabbit 浏览器里打开 chat.deepseek.com 并登录一次，然后重试。",
  };
}

/** 在 Tabbit 里执行一段 Playwright 程序，返回其 JSON 结果。 */
function runInBrowser(program, { requestId, timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const id = requestId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const child = spawn(TABBIT_CLI, [
      "nodejs",
      "--task", TASK_NAME,
      "--request-id", id,
      "--timeout-ms", String(timeoutMs),
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.stdin.on("error", () => { /* 忽略 EPIPE */ });
    child.on("error", (e) => reject(new Error(`无法启动 tabbit-cli：${e.message}`)));
    child.on("close", () => {
      const parsed = extractJson(stdout);
      if (!parsed) {
        reject(new Error(meaningfulError(stderr, stdout)));
        return;
      }
      if (parsed.status !== "succeeded") {
        reject(new Error(`浏览器程序未成功：${JSON.stringify(parsed).slice(0, 300)}`));
        return;
      }
      const v = parsed.result?.value;
      if (v && typeof v.__dswebError === "string") {
        reject(new Error(v.__dswebError));
        return;
      }
      resolve(v);
    });
    child.stdin.end(program, "utf8");
  });
}

/** 括号配对提取第一个完整 JSON（跨多行也能取）。 */
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
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 取有诊断价值的一行错误（跳过 Node 崩溃的版本号尾巴）。 */
function meaningfulError(stderr, stdout) {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l !== "" && !/^Node\.js v\d/.test(l) && !/^\^+$/.test(l) && !/^at\s/.test(l));
  if (lines.length > 0) {
    const hit = lines.find((l) => /Error|错误|失败|Cannot|MODULE_NOT_FOUND|ENOENT/.test(l));
    return (hit ?? lines[0]).slice(0, 400);
  }
  const out = stdout.trim();
  return out === "" ? "只读引擎没有产生任何输出。" : out.slice(0, 400);
}

/**
 * 在已登录页面上下文里 GET 一个 API 路径。
 * @returns {{status:number, text:string}}
 */
export async function getJson(path) {
  const program = `
await page.goto(${JSON.stringify(ORIGIN + "/")}, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(1000);
const __tok = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("userToken") || "{}").value; } catch (e) { return null; } });
if (!__tok) return { __dswebError: "浏览器里没有 DeepSeek 登录态。请在 Tabbit 里打开 chat.deepseek.com 登录一次。" };
const r = await page.fetch(${JSON.stringify(ORIGIN)} + ${JSON.stringify(path)}, {
  headers: { authorization: "Bearer " + __tok },
  as: "text",
  timeoutMs: 60000,
  maxBytes: 8000000,
});
// 超过内联阈值时自己写盘，只把路径带回去（绕开 16 KiB 上限）
if (typeof r.text === "string" && new TextEncoder().encode(r.text).length > 12000) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = ${JSON.stringify(join(process.env.TEMP ?? process.cwd(), "dsweb-tabbit-tmp"))};
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "get-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".json");
  fs.writeFileSync(p, r.text, "utf8");
  return { status: r.status, tempPath: p };
}
return { status: r.status, text: r.text };
`;
  const v = await runInBrowser(program, { requestId: `get-${Date.now()}` });
  if (v && typeof v.tempPath === "string") {
    const text = await readFile(v.tempPath, "utf8");
    await unlink(v.tempPath).catch(() => {});
    return { status: v.status, text };
  }
  return { status: v.status, text: v.text ?? "" };
}
