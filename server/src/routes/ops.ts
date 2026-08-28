// server/src/routes/ops.ts
import { Hono } from "hono";
import type { GbrainClient } from "../gbrain-client";

// 运维路由：admin requests/jobs/agents/api-keys 透传 + /admin/events SSE 代理。
// 透传模式与 content.ts 一致：成功原样 c.json，下游异常 502 带 error。
export function opsRoutes(client: GbrainClient) {
  const app = new Hono();

  // 请求审计列表：仅转发已知的过滤参数（page/agent/operation/status），不透传任意 query
  app.get("/ops/requests", async c => {
    const qs = new URLSearchParams();
    for (const k of ["page", "agent", "operation", "status"] as const) {
      const v = c.req.query(k);
      if (v) qs.set(k, v);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    try { return c.json(await client.adminGet(`/admin/api/requests${suffix}`)); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/ops/jobs", async c => {
    try { return c.json(await client.adminGet("/admin/api/jobs/watch")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/ops/agents", async c => {
    try { return c.json(await client.adminGet("/admin/api/agents")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/ops/api-keys", async c => {
    try { return c.json(await client.adminGet("/admin/api/api-keys")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  // 签发：响应含一次性 token，原样透传给前端展示（面板自身签 key 走 client.issueApiKey 的自清理路径）
  app.post("/ops/api-keys", async c => {
    const body = await c.req.json().catch(() => null) as { name?: string } | null;
    if (!body?.name?.trim()) return c.json({ error: "body.name 必填" }, 400);
    try { return c.json(await client.adminPost("/admin/api/api-keys", { name: body.name.trim() })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  // 撤销：revoke 按 name 撤所有同名 active 行（源码语义）
  app.post("/ops/api-keys/revoke", async c => {
    const body = await c.req.json().catch(() => null) as { name?: string } | null;
    if (!body?.name?.trim()) return c.json({ error: "body.name 必填" }, 400);
    try { return c.json(await client.adminPost("/admin/api/api-keys/revoke", { name: body.name.trim() })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  // SSE 透传：/admin/events 流式原样转发（响应头在此重设，body 直通上游流）。
  // 上游非 2xx / 无 body → 502；客户端断开由运行时传播至上游流。
  app.get("/events", async c => {
    try {
      const upstream = await client.adminFetchRaw("/admin/events");
      if (!upstream.ok || !upstream.body) {
        return c.json({ error: `admin -> HTTP ${upstream.status}` }, 502);
      }
      return new Response(upstream.body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  return app;
}
