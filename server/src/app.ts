// server/src/app.ts
import { Hono } from "hono";
import { join, resolve, sep } from "node:path";
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
  const distRoot = resolve(join(import.meta.dir, "..", "..", "web", "dist"));
  // 路径穿越防护：Hono 会把 %5C 解码为反斜杠，Windows 下 join 视其为分隔符可上跳到 dist 之外。
  // 因此 join/resolve 后必须校验结果仍在 distRoot 内（或等于 distRoot 本身），否则一律 404。
  const withinDist = (p: string) => p === distRoot || p.startsWith(distRoot + sep);
  const safeDistPath = (rel: string) => {
    const p = resolve(distRoot, rel);
    return withinDist(p) ? p : null;
  };
  app.all("*", async c => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "");
    const target = safeDistPath(rel);
    if (!target) return c.text("Not Found", 404);
    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);
    // SPA 回退：index.html 为固定常量，resolve 后天然在 distRoot 内，走同一校验保持路径统一
    const index = safeDistPath("index.html");
    if (!index) return c.text("Not Found", 404);
    const indexFile = Bun.file(index);
    if (await indexFile.exists()) return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8" } });
    return c.text("web/dist 未构建：请在 web/ 目录执行 bun run build（由用户手动执行）", 200);
  });

  return app;
}
