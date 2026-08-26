// server/src/app.ts
import { Hono } from "hono";
import { join } from "node:path";
import type { PanelConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { GbrainClient } from "./gbrain-client";
import { readLockStatus } from "./stale-lock";

export function createApp(deps: { cfg: PanelConfig; orch: Orchestrator; client: GbrainClient }) {
  const { cfg, orch, client } = deps;
  const app = new Hono();

  app.get("/api/status", c =>
    c.json({ state: orch.getState(), effectivePort: orch.getEffectivePort(), panelPort: cfg.panelPort, logs: orch.getRecentLogs().slice(-30) }));

  app.get("/api/stats", async c => {
    try { return c.json(await client.adminGet("/admin/api/stats")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/api/health-indicators", async c => {
    try { return c.json(await client.adminGet("/admin/api/health-indicators")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/api/stale-lock", c => c.json(readLockStatus(cfg.gbrainHome)));

  app.post("/api/spawn-fallback", async c => {
    const state = await orch.spawnOnFallbackPort();
    return c.json({ state, effectivePort: orch.getEffectivePort() });
  });

  // 静态托管 web/dist（SPA 回退）；无 dist 时给出可读提示
  const distRoot = join(import.meta.dir, "..", "..", "web", "dist");
  app.all("*", async c => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "");
    const file = Bun.file(join(distRoot, rel));
    if (await file.exists()) return new Response(file);
    const index = Bun.file(join(distRoot, "index.html"));
    if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    return c.text("web/dist 未构建：请在 web/ 目录执行 bun run build（由用户手动执行）", 200);
  });

  return app;
}
