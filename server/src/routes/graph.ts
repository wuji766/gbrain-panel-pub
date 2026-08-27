// server/src/routes/graph.ts
import { Hono } from "hono";
import type { GbrainClient } from "../gbrain-client";

// 真实 gbrain traverse_graph 的返回形状未在 discovery 中锁定（M3 防御式归一化）：
// 边列表兼容 edges/paths 两种键，端点字段兼容 source/from、target/to；
// nodes 缺失时不额外调 get_page 补齐（展开请求可能很重），由 slug 兜底对象补上（title=slug）。
interface RawEdge { source?: string; from?: string; target?: string; to?: string; type?: string; link_type?: string }

export function graphRoutes(client: GbrainClient) {
  const app = new Hono();

  app.get("/graph/expand", async c => {
    const slug = c.req.query("slug")?.trim();
    if (!slug) return c.json({ error: "slug 必填" }, 400);
    const depth = Math.min(Number(c.req.query("depth") ?? 1) || 1, 3);
    const direction = (c.req.query("direction") ?? "both") as "in" | "out" | "both";
    try {
      const res = await client.mcpCall<{ edges?: RawEdge[]; paths?: RawEdge[]; nodes?: { slug: string; title?: string; type?: string }[] }>(
        "traverse_graph", { slug, depth, direction });
      const raw = res.edges ?? res.paths ?? [];
      const edges = raw.map(e => ({
        source: e.source ?? e.from ?? "",
        target: e.target ?? e.to ?? "",
        type: e.type ?? e.link_type ?? "link",
      })).filter(e => e.source && e.target);
      const nodes = (res.nodes && res.nodes.length ? res.nodes : edges.flatMap(e => [{ slug: e.source }, { slug: e.target }])
        .filter((n, i, arr) => arr.findIndex(x => x.slug === n.slug) === i))
        .map(n => ({ slug: n.slug, title: (n as { title?: string }).title ?? n.slug, type: (n as { type?: string }).type ?? "" }));
      return c.json({ nodes, edges });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  // name 为单段 URL 参数（前端 encodeURIComponent），与 slug 路由的 :slug{.+?} 不同，无吞后缀问题
  app.get("/entity/:name", async c => {
    try { return c.json(await client.mcpCall("entity", { name: c.req.param("name") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  return app;
}
