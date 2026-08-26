// server/src/index.ts
import { join } from "node:path";
import { loadConfig } from "./config";
import { Orchestrator } from "./orchestrator";
import { GbrainClient } from "./gbrain-client";
import { createApp } from "./app";

const cfgPath = process.env.GBRAIN_PANEL_CONFIG ?? join(import.meta.dir, "..", "..", "config.json");
const cfg = loadConfig(cfgPath);
const orch = new Orchestrator(cfg);

// 先注册退出处理，再启动 serve：启动窗口期（最长 30s 健康等待）的 Ctrl+C 也必须走 killServe，
// 否则会留下持锁孤儿 serve，阻塞 ZCode 的 gbrain MCP。server 用可变引用，shutdown 内判空。
// once 守卫：重复信号（连按 Ctrl+C）只触发一次完整退出流程；SIGBREAK 覆盖 Windows 控制台的关闭事件。
let server: ReturnType<typeof Bun.serve> | undefined;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) { console.log("[panel] 已在退出流程中，忽略重复信号"); return; }
  shuttingDown = true;
  console.log("[panel] 退出：停止 gbrain serve …");
  try { await orch.killServe(); } catch (e) { console.error("[panel] killServe 异常:", e); }
  finally { server?.stop(); process.exit(0); }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGBREAK", shutdown);

const state = await orch.start();
console.log(`[panel] gbrain 状态: ${state} (port ${orch.getEffectivePort()})`);
if (state === "error") {
  console.error("[panel] serve 启动失败，最近日志：\n" + orch.getRecentLogs().slice(-20).join("\n"));
  console.error("[panel] 面板仍将启动，可在界面上查看日志并重试。");
}

// 端口用 getter 构造：fallback 换端口后 client 自动跟随新端口，无需重建
const client = new GbrainClient(() => orch.getEffectivePort(), cfg.bootstrapToken);
const app = createApp({ cfg, orch, client });

server = Bun.serve({ port: cfg.panelPort, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`[panel] http://127.0.0.1:${server.port}`);
