// server/test/fixtures/fake-gbrain.ts
// 用 Bun 起一个 HTTP 服务模拟 gbrain serve --http 的最小行为。
// 模式由环境变量控制：FAKE_MODE=healthy|foreign|crash|hang
const mode = process.env.FAKE_MODE ?? "healthy";
const port = Number(process.env.FAKE_PORT ?? 3999);
const token = process.env.FAKE_TOKEN ?? "";
const delay = Number(process.env.HEALTH_DELAY_MS ?? 0);

interface FakePage { slug: string; title: string; type: string; content: string; deletedAt: string | null; updatedAt: string }
interface FakeFact { factId: string; entity: string; fact: string; kind: string; visibility: string; expired: boolean }
const pages = new Map<string, FakePage>();
const facts = new Map<string, FakeFact>();
let factSeq = 100;
function seed(): void {
  pages.set("notes/seed-1", { slug: "notes/seed-1", title: "种子页一", type: "note", content: "# 种子页一\n\n内容", deletedAt: null, updatedAt: "2026-08-20T00:00:00Z" });
  pages.set("people/alice", { slug: "people/alice", title: "Alice", type: "person", content: "# Alice", deletedAt: null, updatedAt: "2026-08-21T00:00:00Z" });
  pages.set("notes/dead-page", { slug: "notes/dead-page", title: "已删页", type: "note", content: "x", deletedAt: "2026-08-22T00:00:00Z", updatedAt: "2026-08-22T00:00:00Z" });
  facts.set("1", { factId: "1", entity: "people/alice", fact: "Alice 喜欢咖啡", kind: "preference", visibility: "world", expired: false });
  facts.set("2", { factId: "2", entity: "people/alice", fact: "旧事实", kind: "event", visibility: "private", expired: true });
}
seed();

function parseFrontmatter(content: string): { title?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const fm = content.slice(3, end);
  const m = /^title:\s*(.+)$/m.exec(fm);
  return { title: m?.[1]?.trim() };
}

if (mode === "crash") { console.error("fake crash"); process.exit(1); }

if (mode === "hang") {
  setInterval(() => {}, 60000); // 不监听任何端口，模拟卡死
} else {
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        await new Promise(r => setTimeout(r, delay));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/admin/login") {
        if (mode === "foreign") return new Response("401", { status: 401 });
        const body = await req.json().catch(() => ({}) as { token?: string });
        if (body.token === token) {
          return new Response(null, { status: 204, headers: { "set-cookie": "gbrain_admin=fakesess; Path=/; HttpOnly" } });
        }
        return new Response("401", { status: 401 });
      }
      if (url.pathname === "/admin/api/stats") {
        return Response.json({ pages: 42, facts: 100, sources: 3 });
      }
      if (url.pathname === "/admin/api/health-indicators") {
        return Response.json({ status: "ok", checks: [{ name: "db", ok: true }] });
      }
      if (url.pathname === "/admin/api/api-keys" && req.method === "POST") {
        return Response.json({ key: "fake-api-key-123", name: (await req.json().catch(() => ({}))).name ?? "" });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        const body = await req.json();
        const name = body?.params?.name as string;
        const a = (body?.params?.arguments ?? {}) as Record<string, any>;
        const ok = (data: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
        const fail = (msg: string) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: msg }) }] } });
        switch (name) {
          case "list_pages": {
            const all = [...pages.values()].filter(p => (a.include_deleted ? true : !p.deletedAt) && (!a.type || p.type === a.type));
            const offset = a.offset ?? 0, limit = a.limit ?? 50;
            return ok({ pages: all.slice(offset, offset + limit).map(p => ({ slug: p.slug, title: p.title, type: p.type, updated_at: p.updatedAt, deleted_at: p.deletedAt })), total: all.length });
          }
          case "get_page": {
            const p = pages.get(a.slug);
            if (!p) return ok({ found: false });
            return ok({ page: { slug: p.slug, title: p.title, type: p.type, ...(a.include_content ? { content: p.content } : {}), updated_at: p.updatedAt, deleted_at: p.deletedAt } });
          }
          case "put_page": {
            const existing = pages.get(a.slug);
            const title = parseFrontmatter(a.content ?? "").title ?? existing?.title ?? a.slug;
            pages.set(a.slug, { slug: a.slug, title, type: existing?.type ?? "note", content: a.content ?? "", deletedAt: existing?.deletedAt ?? null, updatedAt: new Date().toISOString() });
            return ok({ slug: a.slug, status: "upserted" });
          }
          case "delete_page": {
            const p = pages.get(a.slug);
            if (!p) return fail("not found");
            p.deletedAt = new Date().toISOString();
            return ok({ slug: a.slug, deleted: true });
          }
          case "restore_page": {
            const p = pages.get(a.slug);
            if (!p) return fail("not found");
            p.deletedAt = null;
            return ok({ slug: a.slug, restored: true });
          }
          case "search": {
            const q = String(a.query ?? "").toLowerCase();
            const hits = [...pages.values()].filter(p => !p.deletedAt && (p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)));
            const offset = a.offset ?? 0, limit = a.limit ?? 50;
            return ok({ results: hits.slice(offset, offset + limit).map(p => ({ slug: p.slug, title: p.title, chunk: p.content.slice(0, 80) })), total: hits.length });
          }
          case "get_links": return ok({ links: [{ type: "note", direction: "out", slug: "seed-link" }] });
          case "get_timeline": return ok({ entries: [{ date: "2026-08-01", summary: "seed entry" }] });
          case "recall": {
            const all = [...facts.values()].filter(f => (a.include_expired ? true : !f.expired) && (!a.entity || f.entity === a.entity));
            const limit = a.limit ?? 100;
            return ok({ facts: all.slice(0, limit).map(f => ({ fact_id: f.factId, entity_slug: f.entity, fact: f.fact, kind: f.kind, visibility: f.visibility, expired: f.expired })), total: all.length });
          }
          case "remember": {
            const id = String(++factSeq);
            facts.set(id, { factId: id, entity: a.entity ?? "unknown", fact: a.fact ?? "", kind: a.kind ?? "fact", visibility: a.visibility ?? "world", expired: false });
            return ok({ id, status: "inserted", entity_slug: a.entity ?? "unknown" });
          }
          case "forget": {
            const f = facts.get(String(a.id));
            if (!f) return fail("not_found");
            f.expired = true;
            return ok({ id: String(a.id), expired: true, reason: a.reason ?? "" });
          }
          default: return fail(`unknown op ${name}`);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`fake-gbrain(${mode}) listening :${server.port}`);
}
