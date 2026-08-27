// server/src/routes/content.ts
import { Hono } from "hono";
import type { GbrainClient } from "../gbrain-client";

// 注：slug 可含斜杠（如 notes/m2-test），Hono 的 :slug 只匹配单段，
// 故 slug 路由用 :slug{.+}（TDD 实测：普通 :slug 对 /pages/notes/m2-test 返回 404）。
// 例外：GET 详情与 versions 路由用非贪婪 :slug{.+?}（原因见 versions 路由处注释）。

// 真实 gbrain 的 list_pages/search 返回裸数组（2026-08-27 实测 + docs/discovery.json），
// 面板 API 统一归一化为 {pages, total}；fake MCP 曾按包装形状实现导致真机列表恒空（M2 BUG-1）。
function normRows(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  const obj = res as { pages?: unknown; results?: unknown };
  if (Array.isArray(obj?.pages)) return obj.pages as Record<string, unknown>[];
  if (Array.isArray(obj?.results)) return obj.results as Record<string, unknown>[];
  return [];
}

// 真实 list_pages 行不含 deleted_at（仅 get_page 有），回收站视图需逐行补齐
async function enrichDeletedAt(client: GbrainClient, rows: Record<string, unknown>[]): Promise<void> {
  await Promise.all(rows.map(async r => {
    const slug = typeof r.slug === "string" ? r.slug : "";
    if (!slug || r.deleted_at) return;
    try {
      const d = await client.mcpCall<{ page?: { deleted_at?: string | null } }>("get_page", { slug, include_deleted: true });
      if (d?.page) r.deleted_at = d.page.deleted_at ?? null;
    } catch { /* 单行补齐失败不阻塞整个列表 */ }
  }));
}

// limit/offset NaN 守卫：非有限数或负数回默认，杜绝 ?limit=abc 产生 NaN 下传
// （JSON.stringify 会把 NaN 变 null 掩盖问题，真实 gbrain 对非法分页参数未必兜底）
const numOr = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

export function contentRoutes(client: GbrainClient) {
  const app = new Hono();

  app.get("/pages", async c => {
    const q = c.req.query("q")?.trim();
    const limit = numOr(c.req.query("limit"), 50);
    const offset = numOr(c.req.query("offset"), 0);
    const includeDeleted = c.req.query("include_deleted") === "true";
    const typeParam = c.req.query("type");
    try {
      let res: unknown;
      if (q) {
        // q + type 组合：search 无 type 单数参数，type 映射进 types 数组（M3-2 加固）
        res = await client.mcpCall("search", { query: q, limit, offset, ...(typeParam ? { types: [typeParam] } : {}) });
      } else {
        const args: Record<string, unknown> = { limit, offset, include_deleted: includeDeleted };
        for (const k of ["type", "tag", "sort", "updated_after"] as const) {
          const v = c.req.query(k);
          if (v) args[k] = v;
        }
        res = await client.mcpCall("list_pages", args);
      }
      const rows = normRows(res);
      if (!q && includeDeleted) await enrichDeletedAt(client, rows);
      return c.json({ pages: rows, total: (res as { total?: number })?.total ?? rows.length });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  // 版本列表路由。注意：详情路由用贪婪 :slug{.+} 时会吞掉 "/xxx/versions" 后缀
  // （hono reg-exp-router 的终端标记排在交替分支最前，与注册顺序无关，实测复现），
  // 故详情改用非贪婪 :slug{.+?} 且两路由共享同一 token，使后缀路由正确优先（两种注册顺序实测均对）。
  app.get("/pages/:slug{.+?}/versions", async c => {
    try { return c.json(await client.mcpCall("get_versions", { slug: c.req.param("slug") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/pages/:slug{.+?}", async c => {
    const slug = c.req.param("slug");
    // 默认含已删页：回收站详情/恢复入口需要；显式 ?include_deleted=false 关闭
    const includeDeleted = c.req.query("include_deleted") !== "false";
    try {
      const [pageRes, links, timeline] = await Promise.all([
        client.mcpCall("get_page", { slug, include_content: true, include_deleted: includeDeleted }),
        client.mcpCall("get_links", { slug }).catch(() => ({ links: [] })),
        client.mcpCall("get_timeline", { slug, limit: 50 }).catch(() => ({ entries: [] })),
      ]);
      // get_page 返回 {page:{...}} 包裹（未找到为 {found:false}）；测试契约为 detail.page 即页面对象，故解包（无包裹时原样透传）
      return c.json({ page: (pageRes as { page?: unknown }).page ?? pageRes, links, timeline });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.put("/pages/:slug{.+}", async c => {
    const body = await c.req.json().catch(() => null) as { content?: string } | null;
    if (!body || typeof body.content !== "string") return c.json({ error: "body.content 必填" }, 400);
    try { return c.json(await client.mcpCall("put_page", { slug: c.req.param("slug"), content: body.content })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.delete("/pages/:slug{.+}", async c => {
    try { return c.json(await client.mcpCall("delete_page", { slug: c.req.param("slug") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.post("/pages/:slug{.+}/restore", async c => {
    try { return c.json(await client.mcpCall("restore_page", { slug: c.req.param("slug") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/facts", async c => {
    const args: Record<string, unknown> = {
      include_expired: c.req.query("include_expired") === "true",
      limit: Number(c.req.query("limit") ?? 100),
    };
    const entity = c.req.query("entity");
    if (entity) args.entity = entity;
    const grep = c.req.query("grep");
    if (grep) args.grep = grep;
    try {
      // 真实 recall 行无 expired 布尔（只有 expired_at/valid_until，M2 BUG-2 实测），统一补上供前端直接分支
      const res = await client.mcpCall<{ facts?: Record<string, unknown>[]; total?: number } | Record<string, unknown>[]>("recall", args);
      const rows = (Array.isArray(res) ? res : (res.facts ?? [])) as Record<string, unknown>[];
      const now = Date.now();
      const facts = rows.map(f => ({
        ...f,
        expired: f.expired === true || Boolean(f.expired_at)
          || (typeof f.valid_until === "string" && !Number.isNaN(Date.parse(f.valid_until)) && Date.parse(f.valid_until) < now),
      }));
      return c.json({ facts, total: (Array.isArray(res) ? undefined : res.total) ?? facts.length });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.post("/facts", async c => {
    const body = await c.req.json().catch(() => null) as { fact?: string; entity?: string; kind?: string; visibility?: string } | null;
    if (!body?.fact?.trim()) return c.json({ error: "body.fact 必填" }, 400);
    try {
      return c.json(await client.mcpCall("remember", {
        fact: body.fact, provenance: "panel",
        ...(body.entity ? { entity: body.entity } : {}),
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.visibility ? { visibility: body.visibility } : {}),
      }));
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.post("/facts/:id/forget", async c => {
    const body = await c.req.json().catch(() => null) as { reason?: string } | null;
    if (!body?.reason?.trim()) return c.json({ error: "body.reason 必填" }, 400);
    try { return c.json(await client.mcpCall("forget", { id: c.req.param("id"), reason: body.reason })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  return app;
}
