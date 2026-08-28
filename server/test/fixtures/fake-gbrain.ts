// server/test/fixtures/fake-gbrain.ts
// 用 Bun 起一个 HTTP 服务模拟 gbrain serve --http 的最小行为。
// 模式由环境变量控制：FAKE_MODE=healthy|foreign|crash|hang
const mode = process.env.FAKE_MODE ?? "healthy";
const port = Number(process.env.FAKE_PORT ?? 3999);
const token = process.env.FAKE_TOKEN ?? "";
const delay = Number(process.env.HEALTH_DELAY_MS ?? 0);

interface FakePage { slug: string; title: string; type: string; content: string; deletedAt: string | null; updatedAt: string }
interface FakeFact { factId: string; entity: string; fact: string; kind: string; visibility: string; expiredAt: string | null; validFrom: string }
const pages = new Map<string, FakePage>();
const facts = new Map<string, FakeFact>();
const links = [{ from: "notes/seed-1", to: "people/alice", type: "note" }, { from: "people/alice", to: "notes/seed-2", type: "note" }];
// op 计数（键=MCP op 名）+ admin 路径计数（键=`METHOD path`），仅测试断言用，经 GET /__calls 读取
const opCounts: Record<string, number> = {};
// api-keys 状态机：GET 列表 / POST 签发 / POST revoke 共享同一份模块级列表（每个 fake 进程独立）
interface FakeApiKey { id: string; name: string; created_at: string; last_used_at: string | null; status: "active" | "revoked" }
const apiKeys: FakeApiKey[] = [{ id: "k1", name: "gbrain-panel", created_at: "2026-08-26T00:00:00Z", last_used_at: null, status: "active" }];
let keySeq = 1;
let factSeq = 100;
function seed(): void {
  pages.set("notes/seed-1", { slug: "notes/seed-1", title: "种子页一", type: "note", content: "# 种子页一\n\n内容", deletedAt: null, updatedAt: "2026-08-20T00:00:00Z" });
  pages.set("people/alice", { slug: "people/alice", title: "Alice", type: "person", content: "# Alice", deletedAt: null, updatedAt: "2026-08-21T00:00:00Z" });
  pages.set("notes/seed-2", { slug: "notes/seed-2", title: "种子页二", type: "note", content: "# 二", deletedAt: null, updatedAt: "2026-08-25T00:00:00Z" });
  pages.set("notes/dead-page", { slug: "notes/dead-page", title: "已删页", type: "note", content: "x", deletedAt: "2026-08-22T00:00:00Z", updatedAt: "2026-08-22T00:00:00Z" });
  facts.set("1", { factId: "1", entity: "people/alice", fact: "Alice 喜欢咖啡", kind: "preference", visibility: "world", expiredAt: null, validFrom: "2026-08-20T00:00:00Z" });
  facts.set("2", { factId: "2", entity: "people/alice", fact: "旧事实", kind: "event", visibility: "private", expiredAt: "2026-08-22T00:00:00Z", validFrom: "2026-08-21T00:00:00Z" });
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
      if (url.pathname.startsWith("/admin/")) {
        const k = `${req.method} ${url.pathname}`;
        opCounts[k] = (opCounts[k] ?? 0) + 1;
      }
      if (url.pathname === "/__calls") return Response.json(opCounts);
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
      if (url.pathname === "/admin/api/requests") {
        // 真实形状：{rows,total,page,pages}，行含 token_name/agent_name/operation/latency_ms/status 等
        return Response.json({
          rows: [{ id: 1, token_name: "gbrain-panel", agent_name: "gbrain-panel", operation: "list_pages", latency_ms: 12, status: "success", params: "{}", error_message: null, created_at: "2026-08-28T00:00:00Z" }],
          total: 1, page: 1, pages: 1,
        });
      }
      if (url.pathname === "/admin/api/jobs/watch") {
        // 真实形状（源码 jobs-watch.ts WatchSnapshot）：ts_ms 快照时间 + by_type(name/total/completed/failed/dead)
        // + queue_health(waiting/active/stalled) + lease_pressure_1h + top_errors(cluster/count) + budget_owners
        return Response.json({
          ts_ms: Date.now(),
          by_type: [{ name: "embed", total: 3, completed: 2, failed: 1, dead: 0 }],
          queue_health: { waiting: 0, active: 0, stalled: 0 },
          lease_pressure_1h: 0,
          top_errors: [{ cluster: "TimeoutError: embed", count: 1 }],
          budget_owners: [{ owner_id: "panel-test", remaining_cents: 100, total_spent_cents: 5 }],
        });
      }
      if (url.pathname === "/admin/api/agents") {
        // 真实形状（源码 serve-http.ts /admin/api/agents）：裸数组，oauth 客户端与 api_key 混排，
        // 行 = {id,name,auth_type,grant_types,scope,source_id,federated_read,created_at,token_ttl,status,last_used_at,total_requests,requests_today}
        return Response.json([
          { id: "uuid-1", name: "zcode-main", auth_type: "oauth", grant_types: "client_credentials", scope: "read write", source_id: null, federated_read: false, created_at: "2026-08-01T00:00:00Z", token_ttl: 3600, status: "active", last_used_at: "2026-08-28T00:00:00Z", total_requests: 42, requests_today: 5 },
          { id: "uuid-2", name: "gbrain-panel", auth_type: "api_key", grant_types: null, scope: "read write admin", source_id: null, federated_read: false, created_at: "2026-08-26T00:00:00Z", token_ttl: null, status: "active", last_used_at: null, total_requests: 10, requests_today: 2 },
        ]);
      }
      if (url.pathname === "/admin/api/api-keys" && req.method === "GET") {
        // 真实形状（源码 serve-http.ts）：裸数组 {id,name,created_at,last_used_at,status}，按 created_at 倒序
        return Response.json([...apiKeys].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      }
      if (url.pathname === "/admin/api/api-keys" && req.method === "POST") {
        // 真实形状：{name,token,id}（token 一次性，仅签发响应可见）；同时入列表，与 GET 形成一致状态机
        const name = ((await req.json().catch(() => ({}))) as { name?: string }).name ?? "";
        const id = `k${++keySeq}`;
        apiKeys.push({ id, name, created_at: new Date().toISOString(), last_used_at: null, status: "active" });
        return Response.json({ name, token: "fake-one-time-token-456", id });
      }
      if (url.pathname === "/admin/api/api-keys/revoke" && req.method === "POST") {
        // 源码语义：按 name 撤所有 active 行
        const name = ((await req.json().catch(() => ({}))) as { name?: string }).name ?? "";
        for (const k of apiKeys) if (k.name === name && k.status === "active") k.status = "revoked";
        return Response.json({ revoked: true });
      }
      if (url.pathname === "/admin/events") {
        // 最小 SSE：握手头 + ": connected" 注释行后挂起不关闭（真实端点持续推送运维事件）
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(c) { c.enqueue(encoder.encode(": connected\n\n")); /* 保持不关闭 */ },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        const body = await req.json();
        const name = body?.params?.name as string;
        if (name) opCounts[name] = (opCounts[name] ?? 0) + 1;
        const a = (body?.params?.arguments ?? {}) as Record<string, any>;
        const ok = (data: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
        const fail = (msg: string) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true } });
        switch (name) {
          case "list_pages": {
            // 真实形状：裸数组，行 = {slug, source_id, type, title, updated_at}（无 deleted_at、无 total）
            const all = [...pages.values()].filter(p => (a.include_deleted ? true : !p.deletedAt) && (!a.type || p.type === a.type));
            if (a.sort === "updated" || a.sort === "updated_desc") all.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
            const offset = a.offset ?? 0, limit = a.limit ?? 50;
            return ok(all.slice(offset, offset + limit).map(p => ({ slug: p.slug, source_id: "default", type: p.type, title: p.title, updated_at: p.updatedAt })));
          }
          case "get_page": {
            const p = pages.get(a.slug);
            if (!p) return ok({ found: false });
            if (p && p.deletedAt && !a.include_deleted) return ok({ found: false });
            const body = p.content.startsWith("---") ? (p.content.slice(p.content.indexOf("\n---", 3) + 4).trim()) : p.content;
            return ok({ found: true, page: { slug: p.slug, title: p.title, type: p.type, ...(a.include_content ? { content: p.content, compiled_truth: body } : {}), updated_at: p.updatedAt, deleted_at: p.deletedAt } });
          }
          case "put_page": {
            const existing = pages.get(a.slug);
            const title = parseFrontmatter(a.content ?? "").title ?? existing?.title ?? a.slug;
            pages.set(a.slug, { slug: a.slug, title, type: existing?.type ?? "note", content: a.content ?? "", deletedAt: null, updatedAt: new Date().toISOString() });
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
            // 真实形状：裸数组（含 chunk_text/score 等混合检索字段，这里取最小子集）
            const q = String(a.query ?? "").toLowerCase();
            const hits = [...pages.values()].filter(p => !p.deletedAt && (p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)));
            const offset = a.offset ?? 0, limit = a.limit ?? 50;
            return ok(hits.slice(offset, offset + limit).map(p => ({ slug: p.slug, title: p.title, type: p.type, chunk_text: p.content.slice(0, 80), score: 0.5, keyword_hit: true })));
          }
          case "get_links": return ok({ links: [{ type: "note", direction: "out", slug: "seed-link" }] });
          case "get_timeline": return ok({ entries: [{ date: "2026-08-01", summary: "seed entry" }] });
          case "recall": {
            // 真实形状：{facts, total} 包装，行含 expired_at/valid_until（无 expired 布尔）
            const all = [...facts.values()].filter(f => (a.include_expired ? true : !f.expiredAt) && (!a.entity || f.entity === a.entity));
            const limit = a.limit ?? 100;
            return ok({
              facts: all.slice(0, limit).map(f => ({ fact_id: f.factId, id: f.factId, entity_slug: f.entity, fact: f.fact, kind: f.kind, visibility: f.visibility, valid_from: f.validFrom, valid_until: null, expired_at: f.expiredAt })),
              total: all.length,
            });
          }
          case "remember": {
            const id = String(++factSeq);
            facts.set(id, { factId: id, entity: a.entity ?? "unknown", fact: a.fact ?? "", kind: a.kind ?? "fact", visibility: a.visibility ?? "world", expiredAt: null, validFrom: new Date().toISOString() });
            return ok({ id, status: "inserted", status_text: "remembered as fact #" + id, entity_slug: a.entity ?? "unknown", valid_until: null });
          }
          case "forget": {
            const f = facts.get(String(a.id));
            if (!f) return fail("not_found");
            f.expiredAt = new Date().toISOString();
            return ok({ id: String(a.id), expired: true, reason: a.reason ?? "" });
          }
          case "traverse_graph": {
            const direction = a.direction ?? "out";
            const depth = Math.min(a.depth ?? 5, 10);
            const seen = new Set<string>();
            const edges: { source: string; target: string; type: string }[] = [];
            const slugs = new Set<string>([a.slug]);
            let frontier = [a.slug];
            for (let d = 0; d < depth; d++) {
              const next: string[] = [];
              for (const s of frontier) {
                for (const l of links) {
                  if (direction === "in" ? l.to === s : direction === "out" ? l.from === s : l.from === s || l.to === s) {
                    const edge = { source: l.from, target: l.to, type: l.type };
                    const key = `${l.from}->${l.to}`;
                    if (!seen.has(key)) { seen.add(key); edges.push(edge); }
                    const other = l.from === s ? l.to : l.from;
                    if (!slugs.has(other)) { slugs.add(other); next.push(other); }
                  }
                }
              }
              frontier = next;
              if (!frontier.length) break;
            }
            const nodes = [...slugs].map(sg => pages.get(sg)).filter((p): p is FakePage => Boolean(p)).map((p: FakePage) => ({ slug: p.slug, title: p.title, type: p.type }));
            // FAKE_GRAPH_SHAPE=paths：对齐真实形状——传 direction 时 gbrain 返回 GraphPath 裸数组
            // （from_slug/to_slug/link_type），无命中时为 []（空数组，非 {edges:[]} 包装）。
            if (process.env.FAKE_GRAPH_SHAPE === "paths") {
              return ok(edges.map(e => ({ from_slug: e.source, to_slug: e.target, link_type: e.type, context: "", depth: 1 })));
            }
            return ok({ edges, nodes });
          }
          case "entity": {
            const q = String(a.name ?? "").toLowerCase();
            const hit = [...pages.values()].find(p => p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
            if (!hit) return ok({ found: false, suggestions: [{ slug: "people/alice", title: "Alice" }] });
            // dead-page 特例（M4-1 兜底测试依赖）：notes/dead-page 不在 links 种子里（traverse 必空），
            // expand 空结果回退 entity 时靠这组卡关联——out 方向 → source=dead-page/target=seed-2。
            return ok({ found: true, card: {
              entity: { slug: hit.slug, title: hit.title, type: hit.type }, aka: [], summary: "fake summary",
              last_touched: hit.updatedAt, open_threads: [],
              edges: [{ type: "note", direction: "out", slug: "notes/seed-2" }], backlink_count: 1, active_fact_count: 1,
            } });
          }
          case "get_versions": {
            const p = pages.get(a.slug);
            if (!p) return fail("not found");
            return ok({ versions: [
              { version: 1, created_at: "2026-08-01T00:00:00Z", label: "初始" },
              { version: 2, created_at: "2026-08-20T00:00:00Z", label: "编辑" },
            ] });
          }
          default: return fail(`unknown op ${name}`);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`fake-gbrain(${mode}) listening :${server.port}`);
}
