#!/usr/bin/env node
/**
 * 离线冒烟测试 —— 不需要登录、不需要浏览器、不联网。
 *
 * 覆盖：产物完整性、只读铁律、清单声明、注册契约。
 * CI 与本地都跑这一个文件即可。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;

const check = (label, cond, extra = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${extra ? " — " + extra : ""}`); }
};

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

console.log("\n=== 1) 产物完整性 ===");
for (const f of ["lib/index.js", "lib/client.js", "dsweb-share/dsweb.mjs", "dsweb-share/readonly.guard.json", "cordis.patch.yml", "package.json", "README.md"]) {
  check(`存在 ${f}`, existsSync(join(ROOT, f)));
}

console.log("\n=== 2) 只读铁律 ===");
const guard = JSON.parse(read("dsweb-share/readonly.guard.json"));
check("规则文件含禁用子串", Array.isArray(guard.forbiddenSubstrings) && guard.forbiddenSubstrings.length > 0);
check("规则文件含禁用方法", Array.isArray(guard.forbiddenHttpMethods) && guard.forbiddenHttpMethods.includes("POST"));

// 扫描**所有**引擎源文件（引擎、驱动、迁移工具），与引擎自身的 selfCheck 保持一致
import { readdirSync } from "node:fs";
const engineDir = join(ROOT, "dsweb-share");
const engineFiles = readdirSync(engineDir).filter((f) => f.endsWith(".mjs"));
check("引擎文件数 ≥ 4", engineFiles.length >= 4, `实际 ${engineFiles.length}`);

const engineSources = Object.fromEntries(engineFiles.map((f) => [f, readFileSync(join(engineDir, f), "utf8")]));
for (const [file, src] of Object.entries(engineSources)) {
  for (const sub of guard.forbiddenSubstrings) {
    check(`${file} 不含 ${sub}`, !src.includes(sub));
  }
  for (const m of guard.forbiddenHttpMethods) {
    const re = new RegExp(`["'\`]${m}["'\`]|method\\s*:\\s*["'\`]${m}["'\`]`, "i");
    check(`${file} 无 ${m} 方法`, !re.test(src));
  }
}

console.log("\n=== 3) 清单声明 ===");
const pkg = JSON.parse(read("package.json"));
check("name 为 dsh-web-brief", pkg.name === "dsh-web-brief");
check("未标记 private（可发布）", pkg.private !== true);
check("声明 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("声明 dsh.client", pkg.dsh?.client?.platform === "web");
check("声明 dsh.engines", typeof pkg.dsh?.engines?.dsh === "string");
check("license 为 MIT", pkg.license === "MIT");
check("files 含 dsweb-share", (pkg.files ?? []).some((f) => f.startsWith("dsweb-share")));
check("声明 playwright-core 依赖", typeof pkg.dependencies?.["playwright-core"] === "string");

const patch = read("cordis.patch.yml");
check("patch 插入自身一行", patch.includes("dsh-web-brief"));
check("patch 行 id 为 ui-web-brief", patch.includes("ui-web-brief"));

console.log("\n=== 4) 注册契约（mock ctx） ===");
// Windows 上动态 import 必须用 file:// URL，裸绝对路径会被当成 d: 协议
const host = await import(pathToFileURL(join(ROOT, "lib/index.js")).href);
check("导出 apply", typeof host.apply === "function");
check("导出 inject", Array.isArray(host.inject) && host.inject.includes("tools") && host.inject.includes("webServer"));

let tool = null;
let route = null;
host.apply({
  tools: { register: (d) => { tool = d; return () => {}; } },
  webServer: { register: (r) => { route = r; return () => {}; } },
  logger: { info: () => {} },
}, { outDir: join(ROOT, ".test-out") });

check("注册了工具 read_deepseek_web", tool?.name === "read_deepseek_web");
check("工具参数 required 是对象级数组", JSON.stringify(tool?.parameters?.required) === '["action"]');
check("工具 output 有 schema 与 render", typeof tool?.output?.schema === "object" && typeof tool?.output?.render === "function");
check("路由为 prefix /api/dsweb", route?.kind === "prefix" && route?.path === "/api/dsweb");

console.log("\n=== 5) 客户端模块引导 ===");
const client = read("lib/client.js");
check("使用 __ModuleLoader__ 引导", client.includes("window.__ModuleLoader__.load"));
check("模块 id 与包名一致", client.includes('id: "dsh-web-brief"'));
// 三个座位：侧栏行 / 整页面板 / 对话栏标签页
check("注册 sidebar.panellist 行", client.includes('slots.inject("sidebar.panellist"'));
check("注册 main 整页面板", client.includes('slots.inject("main"'));
check("注册 conversation.view 座位", client.includes('slots.inject("conversation.view"'));
check("面板 key 与侧栏 id 一致", client.includes('const PANEL_ID = "web-brief"'));
check("未注册 single 座位 root", !/'root'|"root"/.test(client));
check("未越过 sidebar 到整列", !client.includes('inject("sidebar"'));
check("未越过 conversation 到整列", !client.includes('inject("conversation"'));
check("未注册 details 整列", !client.includes('inject("details"'));

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail === 0 ? 0 : 1);
