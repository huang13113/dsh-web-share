/**
 * Playwright 驱动（通用）
 *
 * 用 `playwright-core` 驱动**系统自带的 Edge / Chrome**，配一个**插件自己的配置目录**。
 * 不下载额外浏览器（playwright-core 只有几 MB），跨 Windows / macOS / Linux。
 *
 * 与 Tabbit 驱动的关键差别：
 *   - 请求在**宿主 Node 进程里**发出，不经过 CLI 中转，**没有 16 KiB 结果上限**
 *   - 但需要一次性登录：在插件弹出的浏览器窗口里登录 chat.deepseek.com
 *
 * 配置目录：$DSH_HOME/web-share/browser-profile（默认 ~/.dsh/web-share/browser-profile）
 * 可用环境变量覆盖：DSWEB_PROFILE / DSWEB_CHANNEL（如 "msedge,chrome"）
 */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ORIGIN = "https://chat.deepseek.com";

const PROFILE_DIR =
  process.env.DSWEB_PROFILE ??
  join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "web-share", "browser-profile");

const CHANNELS = (process.env.DSWEB_CHANNEL ?? "msedge,chrome")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const name = "playwright";

/** 缓存的持久化上下文（一次进程内复用）。 */
let cached = null;

export function profileDir() {
  return PROFILE_DIR;
}

/** playwright-core 是否可用。 */
export async function available() {
  try {
    await import("playwright-core");
    return true;
  } catch {
    return false;
  }
}

/** 启动（或复用）持久化上下文。依次尝试各 channel。 */
async function getContext({ headless = true } = {}) {
  if (cached !== null && cached.headless === headless) return cached;
  if (cached !== null) {
    await cached.context.close().catch(() => {});
    cached = null;
  }
  mkdirSync(PROFILE_DIR, { recursive: true });

  const errors = [];
  for (const channel of CHANNELS) {
    try {
      const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel,
        headless,
        viewport: headless ? { width: 1280, height: 900 } : null,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      cached = { context, channel, headless, page: null };
      return cached;
    } catch (e) {
      errors.push(`${channel}: ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  throw new Error(
    `无法启动浏览器（已尝试 ${CHANNELS.join(" / ")}）。\n` +
    `原因：${errors.join("；") || "未知"}\n` +
    `请确认本机装了 Microsoft Edge 或 Google Chrome，或用 DSWEB_CHANNEL 指定 channel。`,
  );
}

/** 取一个已打开 DeepSeek 首页的页面（复用同一个，避免反复导航）。 */
async function getPage() {
  const ctx = await getContext({ headless: true });
  if (ctx.page !== null && !ctx.page.isClosed()) return ctx.page;
  const page = ctx.context.pages()[0] ?? await ctx.context.newPage();
  await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(800);
  ctx.page = page;
  return page;
}

/** 从页面 localStorage 读 userToken（页面上下文内，不落盘）。 */
async function readToken(page) {
  try {
    return await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem("userToken") || "{}").value || null; } catch { return null; }
    });
  } catch {
    return null;
  }
}

/**
 * 首次登录：弹出一个真实浏览器窗口，等用户在里头登录成功。
 * 绝不代为输入凭据。
 */
export async function login({ timeoutMs = 300_000 } = {}) {
  const ctx = await getContext({ headless: false });
  const page = ctx.context.pages()[0] ?? await ctx.context.newPage();
  await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 60000 });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const token = await readToken(page);
    if (token) {
      await page.waitForTimeout(500);
      return { ok: true, driver: name, channel: ctx.channel, url: page.url() };
    }
    if (page.url().includes("/sign_in")) {
      // 还在登录页，继续等
    }
  }
  return {
    ok: false,
    driver: name,
    reason: `等待登录超时（${Math.round(timeoutMs / 1000)} 秒）。请在弹出的窗口里完成登录后重试。`,
  };
}

/** 登录态探活（零额度：只读一次会话列表（count 太小会 ILLEGAL_COUNT，用 20））。 */
export async function status() {
  try {
    const r = await getJson("/api/v0/chat_session/fetch_page?count=20");
    if (r.status !== 200) return { ready: false, driver: name, reason: `HTTP ${r.status}` };
    const p = JSON.parse(r.text);
    const ok = p.code === 0 && p?.data?.biz_code === 0;
    return { ready: ok, driver: name, reason: ok ? null : `biz_code=${p?.data?.biz_code} ${p?.data?.biz_msg ?? ""}` };
  } catch (e) {
    return { ready: false, driver: name, reason: String(e.message ?? e) };
  }
}

/**
 * 在页面上下文里 GET 一个 API 路径。
 * 请求由页面发出，因此自带同源 cookie、指纹头等一切反爬上下文。
 * @returns {{status:number, text:string}}
 */
export async function getJson(path) {
  const page = await getPage();
  const token = await readToken(page);
  if (token === null) {
    throw new Error(
      "浏览器里没有 DeepSeek 登录态。请先运行：node dsweb.mjs login" +
      `（配置目录：${PROFILE_DIR}）`,
    );
  }
  const res = await page.evaluate(async ({ url, tok }) => {
    const r = await fetch(url, {
      headers: { authorization: "Bearer " + tok },
      credentials: "include",
    });
    return { status: r.status, text: await r.text() };
  }, { url: ORIGIN + path, tok: token });
  return { status: res.status, text: res.text };
}

/** 释放浏览器（引擎退出前调用）。 */
export async function dispose() {
  if (cached === null) return;
  const ctx = cached;
  cached = null;
  await ctx.context.close().catch(() => {});
}
