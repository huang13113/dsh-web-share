#!/usr/bin/env node
/**
 * 一次性迁移工具：把 Tabbit 浏览器里的 DeepSeek 登录态复制到本插件的
 * Playwright 配置目录（~/.dsh/web-share/browser-profile）。
 *
 * 用途：已经用 Tabbit 跑通过的用户，可以免去再登录一次。
 * 注意：这只搬 cookie，不搬密码，也不落任何明文凭据文件——
 *       写进的是浏览器自己的 profile，和正常登录后的状态一样。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const TABBIT_CLI =
  process.env.TABBIT_CLI ??
  join(process.env.LOCALAPPDATA ?? "", "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe");

const PROGRAM = `
await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(1200);
const cookies = await context.cookies("https://chat.deepseek.com");
const tok = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("userToken") || "{}").value || null; } catch (e) { return null; } });
return { cookies, token: tok };
`;

function runTabbit(program) {
  return new Promise((resolve, reject) => {
    const child = spawn(TABBIT_CLI, [
      "nodejs", "--task", "dsweb-seed",
      "--request-id", `seed-${Date.now()}`,
      "--timeout-ms", "120000",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => reject(new Error(`无法启动 tabbit-cli：${e.message}`)));
    child.on("close", () => {
      const line = out.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
      if (!line) { reject(new Error(`tabbit 无 JSON 输出：${err.slice(0, 200)}`)); return; }
      const parsed = JSON.parse(line);
      if (parsed.status !== "succeeded") { reject(new Error(`tabbit 程序未成功：${line.slice(0, 200)}`)); return; }
      resolve(parsed.result.value);
    });
    child.stdin.end(program, "utf8");
  });
}

const { cookies, token } = await runTabbit(PROGRAM);
if (!token) {
  console.error("❌ Tabbit 里也没有登录态，请先在 Tabbit 登录 chat.deepseek.com。");
  process.exit(1);
}

const { chromium } = await import("playwright-core");
const { mkdirSync } = await import("node:fs");
const { homedir } = await import("node:os");

const profile = process.env.DSWEB_PROFILE ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "web-share", "browser-profile");
mkdirSync(profile, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: process.env.DSWEB_CHANNEL ?? "msedge",
  headless: true,
  args: ["--no-first-run", "--no-default-browser-check"],
});

try {
  // 过滤掉 Playwright 不接受的字段，并补齐 domain
  const prepared = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith(".") ? c.domain : "." + c.domain.replace(/^\.?/, ""),
    path: c.path ?? "/",
    expires: typeof c.expires === "number" && c.expires > 0 ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None" ? c.sameSite : "Lax",
  }));
  await ctx.addCookies(prepared);

  const page = ctx.pages()[0] ?? await ctx.newPage();
  // 先落到同源任意页面（未登录会跳到 /sign_in，仍是同源），
  // 这样才能写这个 origin 的 localStorage —— 登录态的关键在 userToken，不在 cookie。
  await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.evaluate((tok) => {
    localStorage.setItem("userToken", JSON.stringify({ value: tok, __version: "0" }));
  }, token);

  // 重新进入，让应用带上 userToken 启动
  await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  const got = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("userToken") || "{}").value || null; } catch { return null; }
  });
  console.log(JSON.stringify({
    ok: !!got,
    cookiesImported: prepared.length,
    url: page.url(),
    tokenPresent: !!got,
    tokenLen: got ? String(got).length : 0,
  }, null, 2));
} finally {
  await ctx.close().catch(() => {});
}
