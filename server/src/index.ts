// server/src/index.ts
import { join } from "node:path";
import { loadConfig } from "./config";
import { Orchestrator } from "./orchestrator";
import { GbrainClient } from "./gbrain-client";
import { createApp } from "./app";

const cfgPath = process.env.GBRAIN_PANEL_CONFIG ?? join(import.meta.dir, "..", "..", "config.json");
const cfg = loadConfig(cfgPath);
const orch = new Orchestrator(cfg);

const state = await orch.start();
console.log(`[panel] gbrain 状态: ${state} (port ${orch.getEffectivePort()})`);
if (state === "error") {
  console.error("[panel] serve 启动失败，最近日志：\n" + orch.getRecentLogs().slice(-20).join("\n"));
  console.error("[panel] 面板仍将启动，可在界面上查看日志并重试。");
}

const client = new GbrainClient(orch.getEffectivePort(), cfg.bootstrapToken);
const app = createApp({ cfg, orch, client });

const server = Bun.serve({ port: cfg.panelPort, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`[panel] http://127.0.0.1:${server.port}`);

const shutdown = async () => {
  console.log("[panel] 退出：停止 gbrain serve …");
  await orch.killServe();
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
