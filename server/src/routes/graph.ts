// server/src/routes/graph.ts
import { Hono } from "hono";
import type { GbrainClient } from "../gbrain-client";

// 真实 gbrain traverse_graph 返回形状（M4 源码核实）共三种，归一化统一输出 {nodes,edges}：
// ① 传 direction 时：GraphPath 裸数组（from_slug/to_slug/link_type）；
// ② 不传 direction 时：GraphNode 裸数组（slug + links[{to_slug,link_type}]，从根展开边）；
// ③ 历史/包装形态：{edges:[...]} 或 {paths:[...]}（端点字段 source/from、target/to）。
// 归一化后 edges 为空时回退 entity 卡关联（card.edges={type,direction,slug}，上限 10 条）。

function dedupeEdges(edges: { source: string; target: string; type: string }[]) {
  const seen = new Set<string>();
  return edges.filter(e => {
    const k = `${e.source}->${e.target}::${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}
function nodesFromEdges(edges: { source: string; target: string }[], root: string, titles: Map<string, { title?: string; type?: string }>) {
  const slugs = new Set<string>([root, ...edges.flatMap(e => [e.source, e.target])]);
  return [...slugs].map(s => ({ slug: s, title: titles.get(s)?.title ?? s, type: titles.get(s)?.type ?? "" }));
}

export function graphRoutes(client: GbrainClient) {
  const app = new Hono();

  app.get("/graph/expand", async c => {
    const slug = c.req.query("slug")?.trim();
    if (!slug) return c.json({ error: "slug 必填" }, 400);
    const directionRaw = c.req.query("direction") ?? "both";
    if (!["in", "out", "both"].includes(directionRaw)) return c.json({ error: `direction 非法：${directionRaw}` }, 400);
    const direction = directionRaw as "in" | "out" | "both";
    const depth = Math.max(1, Math.min(3, Math.floor(Number(c.req.query("depth") ?? 1) || 1)));
    try {
      const res = await client.mcpCall<unknown>("traverse_graph", { slug, depth, direction });
      // 三种真实/历史形态归一化：GraphPath 裸数组 / GraphNode 裸数组 / {edges|paths}
      const rawEdges: { source: string; target: string; type: string }[] = [];
      const nodeTitles = new Map<string, { title?: string; type?: string }>();
      const addEdge = (source: string, target: string, type: string) => {
        if (source && target) rawEdges.push({ source, target, type: type || "link" });
      };
      const arr = Array.isArray(res) ? res : ((res as any)?.edges ?? (res as any)?.paths ?? []);
      for (const item of arr as any[]) {
        if (item?.from_slug || item?.to_slug) {                      // GraphPath
          addEdge(item.from_slug ?? "", item.to_slug ?? "", item.link_type ?? "link");
        } else if (item?.source || item?.from) {                     // 历史包装形状
          addEdge(item.source ?? item.from ?? "", item.target ?? item.to ?? "", item.type ?? item.link_type ?? "link");
        } else if (item?.slug && Array.isArray(item?.links)) {       // GraphNode（无 direction 调用）
          nodeTitles.set(item.slug, { title: item.title, type: item.type });
          for (const l of item.links) addEdge(item.slug, l?.to_slug ?? "", l?.link_type ?? "link");
        }
      }
      for (const n of ((res as any)?.nodes ?? []) as any[]) nodeTitles.set(n.slug, { title: n.title, type: n.type });
      let edges = dedupeEdges(rawEdges);
      let nodes = nodesFromEdges(edges, slug, nodeTitles);
      if (!edges.length) {
        // 兜底：entity 卡关联（源码证实 card.edges={type,direction:'out'|'in',slug}，上限 10）
        try {
          const ent = await client.mcpCall<{ found?: boolean; card?: { edges?: { type?: string; direction?: string; slug?: string }[] } }>("entity", { name: slug });
          const ce = ent?.card?.edges ?? [];
          const fb: typeof rawEdges = [];
          for (const e of ce) {
            if (!e?.slug) continue;
            if (e.direction === "in") fb.push({ source: e.slug, target: slug, type: e.type ?? "link" });
            else fb.push({ source: slug, target: e.slug, type: e.type ?? "link" });
          }
          edges = dedupeEdges(fb);
          nodes = nodesFromEdges(edges, slug, nodeTitles);
        } catch { /* entity 失败保持空结果 */ }
      }
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
