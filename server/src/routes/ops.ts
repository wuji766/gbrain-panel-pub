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

  // SSE 透传：/admin/events 流式转发 + 面板侧 5s 心跳（M6）。上游 gbrain 的 SSE 握手只写
  // 一次 ": connected"（源码 serve-http.ts openAdminSseStream，无周期心跳）且不杀空闲流；
  // 而 Bun.serve 默认 idleTimeout=10s 会杀面板这端的空闲响应——浏览器腿每 ~10s 断一次，
  // EventSource 反复重连（M5 验收缺陷 A）。注入 ": ping\n\n"（SSE 注释行，EventSource 规范
  // 忽略，前端零改动）保活；上游断流则收尾浏览器腿，由 EventSource 原生重连兜底。
  app.get("/events", async c => {
    try {
      const upstream = await client.adminFetchRaw("/admin/events");
      if (!upstream.ok || !upstream.body) {
        return c.json({ error: `admin -> HTTP ${upstream.status}` }, 502);
      }
      const reader = upstream.body.getReader();
      const enc = new TextEncoder();
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      const stopPing = () => { if (pingTimer !== undefined) { clearInterval(pingTimer); pingTimer = undefined; } };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          pingTimer = setInterval(() => {
            try { controller.enqueue(enc.encode(": ping\n\n")); } catch { stopPing(); } // 客户端已断开
          }, 5000);
          (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } catch { /* 上游断流：收尾浏览器腿，交给 EventSource 原生重连 */ }
            stopPing();
            try { controller.close(); } catch { /* 已关 */ }
          })();
        },
        cancel(reason) {
          stopPing();
          reader.cancel(reason).catch(() => {});
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  return app;
}
