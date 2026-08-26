// server/scripts/discover.ts
// 真实链路探测：spawn serve → admin 登录 → 签 key → tools/list → 落盘 docs/discovery.json → 关 serve。
// 注意：若 ZCode 的 stdio gbrain MCP 正持锁，serve 会起不来——先关闭 ZCode（或其 gbrain MCP）再跑本脚本。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Orchestrator } from "../src/orchestrator";
import { GbrainClient } from "../src/gbrain-client";
import { probeHealth } from "../src/health";

async function main() {
  const root = join(import.meta.dir, "..", "..");
  const cfg = loadConfig(process.env.GBRAIN_PANEL_CONFIG ?? join(root, "config.json"));

  if (await probeHealth(cfg.gbrainPort, 1500)) {
    console.error(`端口 ${cfg.gbrainPort} 上已有 serve 在跑。为避免误伤，请先手动处理后再运行本脚本。`);
    process.exit(1);
  }

  const orch = new Orchestrator(cfg);
  const state = await orch.start();
  if (state !== "own") {
    console.error(`serve 未就绪（${state}）：\n${orch.getRecentLogs().slice(-20).join("\n")}`);
    console.error("若报锁冲突：关闭正在使用 gbrain 的 ZCode 会话后重试。");
    process.exit(1);
  }

  try {
    const client = new GbrainClient(orch.getEffectivePort(), cfg.bootstrapToken);
    const stats = await client.adminGet<Record<string, unknown>>("/admin/api/stats");
    const apiKey = await client.issueApiKey("gbrain-panel-discover");
    const tools = await client.mcpRequest<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>("tools/list");

    mkdirSync(join(root, "docs"), { recursive: true });
    const out = {
      generatedAt: new Date().toISOString(),
      statsShape: stats,
      apiKeyShape: { prefix: apiKey.slice(0, 6), length: apiKey.length }, // 不落盘完整 key
      toolCount: tools.tools.length,
      tools: tools.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    };
    writeFileSync(join(root, "docs", "discovery.json"), JSON.stringify(out, null, 2));
    console.log(`docs/discovery.json 已写入，共 ${tools.tools.length} 个工具。M2 计划以此为准。`);
  } finally {
    await orch.killServe();
    console.log("serve 已停止，锁已释放。");
  }
}

main();
