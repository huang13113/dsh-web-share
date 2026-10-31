/**
 * 驱动选择器
 *
 * 引擎（dsweb.mjs）只依赖这个接口：
 *   { name, available(), status(), login(), getJson(path) -> {status, text}, dispose?() }
 *
 * 这样"用哪个浏览器"变成可替换的一层，业务逻辑完全不用改。
 */

import * as tabbit from "./driver-tabbit.mjs";
import * as playwright from "./driver-playwright.mjs";

const DRIVERS = { tabbit, playwright };

/**
 * 选择驱动。
 *
 * `auto`（默认）的判定顺序：
 *   1. playwright 已可用且配置目录里**已有登录态** → 用它（通用、跨平台、无结果上限）
 *   2. tabbit 可用 → 用它（零配置，但仅 Windows）
 *   3. playwright 可用但没登录 → 仍用它，并提示用户跑 login
 */
export async function selectDriver(prefer) {
  const want = prefer ?? process.env.DSWEB_DRIVER ?? "auto";

  if (want !== "auto") {
    const d = DRIVERS[want];
    if (d === undefined) {
      throw new Error(`未知驱动 "${want}"，可选：auto / ${Object.keys(DRIVERS).join(" / ")}`);
    }
    if (!(await d.available())) {
      throw new Error(`驱动 "${want}" 不可用（依赖缺失或浏览器不存在）。`);
    }
    return d;
  }

  const pwOk = await playwright.available();
  if (pwOk) {
    const st = await playwright.status().catch(() => ({ ready: false }));
    if (st.ready) return playwright;
  }
  if (await tabbit.available()) return tabbit;
  if (pwOk) return playwright;

  throw new Error(
    "没有可用的浏览器驱动：playwright-core 未安装，也找不到 Tabbit。\n" +
    "请在插件目录执行 `npm install`（会装上 playwright-core），并确认本机有 Edge 或 Chrome。",
  );
}

/** 所有驱动的可用性概览（doctor 用）。 */
export async function describeDrivers() {
  const out = [];
  for (const [key, d] of Object.entries(DRIVERS)) {
    let avail = false;
    let st = { ready: false, reason: "未检测" };
    try { avail = await d.available(); } catch { avail = false; }
    if (avail) {
      try { st = await d.status(); } catch (e) { st = { ready: false, reason: String(e.message ?? e) }; }
    }
    out.push({ driver: key, available: avail, ready: !!st.ready, reason: st.reason ?? null });
  }
  return out;
}

/**
 * 释放所有驱动持有的资源（主要是 Playwright 的浏览器进程）。
 *
 * 必须显式调用：持久化上下文一旦启动，Node 进程会一直存活，
 * 表现为"命令跑完了但不退出"。
 */
export async function disposeAll() {
  for (const d of Object.values(DRIVERS)) {
    if (typeof d.dispose === "function") {
      try { await d.dispose(); } catch { /* 忽略 */ }
    }
  }
}
