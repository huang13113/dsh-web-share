#!/usr/bin/env node
/**
 * 读取 dsweb 宿主插件的诊断日志。
 *
 * 为什么需要它：宿主半边加载失败时 DSH 是**静默**的——客户端标签照样渲染，
 * 宿主却不注册路由，现象就是"标签在、里面空的"。诊断日志是唯一能区分
 * 「apply 没被调用」/「工具注册抛错」/「路由注册抛错」的证据。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const path = join(tmpdir(), "dsweb-host.log");
if (!existsSync(path)) {
  console.log("诊断日志不存在：", path);
  console.log("这本身就是一个结论——说明宿主插件从来没有进入 apply()，");
  console.log("即插件行没有被加载（而不是加载后注册失败）。");
  process.exit(0);
}

const raw = readFileSync(path, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
console.log(`日志文件：${path}`);
console.log(`共 ${lines.length} 行，最近 20 行：\n`);
for (const line of lines.slice(-20)) console.log("  " + line);

const last = lines.at(-1) ?? "";
console.log("\n=== 结论 ===");
if (last.includes("apply 完成")) console.log("  ✅ apply 完整跑完：工具与路由都已注册。");
else if (last.includes("路由注册失败")) console.log("  ❌ 工具注册成功但路由注册失败 —— 看上面那一行的具体报错。");
else if (last.includes("工具注册失败")) console.log("  ❌ 工具注册就失败了 —— schema 或服务不可用。");
else if (last.includes("apply 进入")) console.log("  ⚠️ apply 进入了但没跑完，且未捕获到失败阶段 —— 说明中途抛了未记录的错误。");
else console.log("  ⚠️ 日志内容不符合预期，请人工查看。");
