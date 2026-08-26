// server/src/routes/content.ts
import { Hono } from "hono";
import type { GbrainClient } from "../gbrain-client";

// 注：slug 可含斜杠（如 notes/m2-test），Hono 的 :slug 只匹配单段，
// 故四处 slug 路由用 :slug{.+}（TDD 实测：普通 :slug 对 /pages/notes/m2-test 返回 404）。
export function contentRoutes(client: GbrainClient) {
  const app = new Hono();

  app.get("/pages", async c => {
    const q = c.req.query("q")?.trim();
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const includeDeleted = c.req.query("include_deleted") === "true";
    try {
      if (q) return c.json(await client.mcpCall("search", { query: q, limit, offset }));
      const args: Record<string, unknown> = { limit, offset, include_deleted: includeDeleted };
      for (const k of ["type", "tag", "sort", "updated_after"] as const) {
        const v = c.req.query(k);
        if (v) args[k] = v;
      }
      return c.json(await client.mcpCall("list_pages", args));
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/pages/:slug{.+}", async c => {
    const slug = c.req.param("slug");
    const includeDeleted = c.req.query("include_deleted") === "true";
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
    try { return c.json(await client.mcpCall("recall", args)); }
    catch (e) { return c.json({ error: String(e) }, 502); }
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
