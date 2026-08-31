// server/src/app.ts
import { Hono } from "hono";
import { join, resolve, sep } from "node:path";
import type { PanelConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { GbrainClient } from "./gbrain-client";
import { readLockStatus } from "./stale-lock";
import { contentRoutes } from "./routes/content";
import { graphRoutes } from "./routes/graph";
import { opsRoutes } from "./routes/ops";
import type { BackupManager } from "./backup";

// backup 为可选依赖：未注入（旧测试/最小部署）时 /api/backups* 一律 503，既有 createApp 调用零改动
export function createApp(deps: { cfg: PanelConfig; orch: Orchestrator; client: GbrainClient; backup?: BackupManager }) {
  const { cfg, orch, client, backup } = deps;
  const app = new Hono();

  // backupRunning 并入 status（零磁盘 IO）：前端全局轮询只打这一个接口，消除备份列表每 5s 的高频 stat
  app.get("/api/status", c =>
    c.json({ state: orch.getState(), effectivePort: orch.getEffectivePort(), panelPort: cfg.panelPort, backupRunning: backup?.isRunning() ?? false, logs: orch.getRecentLogs().slice(-30) }));

  // 面板自身 config.json 只读脱敏：bootstrapToken 永不出后端，其余字段（含 updateProxy）原样
  app.get("/api/panel-config", c => {
    const { bootstrapToken: _hidden, ...rest } = cfg;
    return c.json({ ...rest, bootstrapToken: "<已隐藏>" });
  });

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
    // 版本比较必须按分量（"0.46.32" vs "0.46.5"：字典序会误判 32 < 5）
    const compareVersions = (a: string, b: string): number => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
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
      upToDate: current && latest ? compareVersions(current, latest) >= 0 : null,
    });
  });

  app.route("/api", contentRoutes(client));
  app.route("/api", graphRoutes(client));
  // 运维路由（requests/jobs/agents/api-keys 透传 + /api/events SSE 代理），仅需 client（无 cfg）
  app.route("/api", opsRoutes(client));

  // 备份路由：列表带 running 字段供备份页复位 running 态（全局横幅走 /api/status 的 backupRunning）；name 走 BackupManager 白名单校验（防路径注入）
  app.get("/api/backups", c =>
    backup ? c.json({ running: backup.isRunning(), backups: backup.list() }) : c.json({ error: "备份未启用" }, 503));
  app.post("/api/backups", async c => {
    if (!backup) return c.json({ error: "备份未启用" }, 503);
    if (backup.isRunning()) return c.json({ error: "已有备份在进行中" }, 409);
    try { return c.json(await backup.run()); }
    catch (e) { return c.json({ error: String(e) }, 503); }
  });
  app.delete("/api/backups/:name", c => {
    if (!backup) return c.json({ error: "备份未启用" }, 503);
    const ok = backup.remove(c.req.param("name"));
    return ok ? c.json({ removed: true }) : c.json({ error: "删除失败（名称非法、不存在或被占用）" }, 400);
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
    // Bun 1.3.14 Windows：带 body 的请求命中本 catch-all 且返回 new Response(BunFile)（流式）时，
    // 未消费的请求体会触发主线程 panic（Internal assertion failure，进程崩溃，回归测试 12/12 复现）。
    // 第一行先把请求体完整读走（body.cancel() 实测无效，仍 panic；arrayBuffer 实测有效）。
    // 必须放 catch-all 内而非全局 middleware——实测后者会破坏 API 路由的 c.req.json()。
    await c.req.arrayBuffer().catch(() => null);
    const rel = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "");
    const target = safeDistPath(rel);
    if (!target) return c.text("Not Found", 404);
    const file = Bun.file(target);
    if (await file.exists()) {
      // index.html 禁缓存（重新构建后须立即生效）；其余静态文件（assets 文件名带 hash）保持现状不加缓存头
      return target === safeDistPath("index.html")
        ? new Response(file, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } })
        : new Response(file);
    }
    // SPA 回退：index.html 为固定常量，resolve 后天然在 distRoot 内，走同一校验保持路径统一
    const index = safeDistPath("index.html");
    if (!index) return c.text("Not Found", 404);
    const indexFile = Bun.file(index);
    if (await indexFile.exists()) return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    return c.text("web/dist 未构建：请在 web/ 目录执行 bun run build（由用户手动执行）", 200);
  });

  return app;
}
