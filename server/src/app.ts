// server/src/app.ts
import { Hono } from "hono";
import { join, resolve, sep } from "node:path";
import type { PanelConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { GbrainClient } from "./gbrain-client";
import { readLockStatus } from "./stale-lock";
import { contentRoutes } from "./routes/content";

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

  app.get("/api/full-stats", async c => {
    try { return c.json(await client.adminGet("/admin/api/full-stats")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  // 检查更新：当前版本解析自 serve 启动横幅日志，最新版本与 gbrain check-update 同源
  // （raw.githubusercontent 上的 VERSION 文件，gbrain 自身直连可通；失败可用 config.updateProxy 兜底）
  app.get("/api/update-check", async c => {
    const banner = [...orch.getRecentLogs()].reverse().find(l => /GBrain MCP Server v[\d.]+/.test(l));
    const current = banner?.match(/GBrain MCP Server v(\d+(?:\.\d+)*)/)?.[1] ?? null;
    const parseVersion = (body: string): string | null => {
      const first = body.slice(0, 256).trim().split("\n")[0].trim();
      return first.match(/^v?(\d+\.\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
    };
    let latest: string | null = null;
    let networkError: string | null = null;
    try {
      const res = await fetch(cfg.updateUrl, { signal: AbortSignal.timeout(5_000), headers: { "User-Agent": "gbrain-panel" } });
      if (res.ok) latest = parseVersion(await res.text());
    } catch (e) {
      if (cfg.updateProxy) {
        try {
          const res = await fetch(cfg.updateUrl, {
            signal: AbortSignal.timeout(5_000),
            proxy: cfg.updateProxy,
          } as RequestInit & { proxy?: string });
          if (res.ok) latest = parseVersion(await res.text());
        } catch (e2) { networkError = String(e2); }
      } else networkError = String(e);
    }
    return c.json({
      current, latest, networkError,
      checkedAt: new Date().toISOString(),
      upToDate: current && latest ? current >= latest : null,
    });
  });

  app.route("/api", contentRoutes(client));

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
    // Bun 1.3.14 Windows：带 body 的请求命中本 catch-all 且返回 new Response(BunFile)（流式）时，
    // 未消费的请求体会触发主线程 panic（Internal assertion failure，进程崩溃，回归测试 12/12 复现）。
    // 第一行先把请求体完整读走（body.cancel() 实测无效，仍 panic；arrayBuffer 实测有效）。
    // 必须放 catch-all 内而非全局 middleware——实测后者会破坏 API 路由的 c.req.json()。
    await c.req.arrayBuffer().catch(() => null);
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
