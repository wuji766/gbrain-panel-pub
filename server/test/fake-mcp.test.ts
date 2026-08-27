// server/test/fake-mcp.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { GbrainClient } from "../src/gbrain-client";
import { startFakeGbrain, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const handles: FakeGbrainHandle[] = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.stop(); });

async function client(): Promise<{ c: GbrainClient; h: FakeGbrainHandle }> {
  const h = await startFakeGbrain({ mode: "healthy", token: TOKEN });
  handles.push(h);
  return { c: new GbrainClient(h.port, TOKEN), h };
}

describe("fake /mcp 分发器（op 形状对齐真实 gbrain：list/search 裸数组、recall 行用 expired_at）", () => {
  test("put→list→get→delete→restore 全链路", async () => {
    const { c } = await client();
    await c.mcpCall("put_page", { slug: "notes/new-page", content: "---\ntitle: 新页\n---\n\n正文" });
    const list = await c.mcpCall<{ slug: string }[]>("list_pages", { include_deleted: false });
    expect(list.some(p => p.slug === "notes/new-page")).toBe(true);
    const got = await c.mcpCall<{ page: { title?: string; compiled_truth?: string } }>("get_page", { slug: "notes/new-page", include_content: true });
    expect(got.page.title).toBe("新页");
    expect(got.page.compiled_truth).toBe("正文");
    await c.mcpCall("delete_page", { slug: "notes/new-page" });
    const alive = await c.mcpCall<{ slug: string }[]>("list_pages", { include_deleted: false });
    expect(alive.some(p => p.slug === "notes/new-page")).toBe(false);
    const deleted = await c.mcpCall<{ slug: string }[]>("list_pages", { include_deleted: true });
    expect(deleted.some(p => p.slug === "notes/new-page")).toBe(true);
    await c.mcpCall("restore_page", { slug: "notes/new-page" });
    const restored = await c.mcpCall<{ slug: string }[]>("list_pages", { include_deleted: false });
    expect(restored.some(p => p.slug === "notes/new-page")).toBe(true);
  });

  test("search 子串匹配（裸数组）", async () => {
    const { c } = await client();
    const r = await c.mcpCall<{ slug: string }[]>("search", { query: "seed" });
    expect(r.length).toBeGreaterThan(0);
  });

  test("remember→recall(include_expired)→forget（expired_at 语义）", async () => {
    const { c } = await client();
    const mem = await c.mcpCall<{ id: string }>("remember", { fact: "面板测试事实", provenance: "panel", entity: "test-entity" });
    expect(mem.id).toBeTruthy();
    const before = await c.mcpCall<{ facts: { fact_id: string; expired_at: string | null }[] }>("recall", { entity: "test-entity", include_expired: true });
    expect(before.facts.some(f => f.fact_id === mem.id && !f.expired_at)).toBe(true);
    const fg = await c.mcpCall<{ expired: boolean }>("forget", { id: mem.id, reason: "测试遗忘" });
    expect(fg.expired).toBe(true);
    const after = await c.mcpCall<{ facts: { fact_id: string; expired_at: string | null }[] }>("recall", { entity: "test-entity", include_expired: true });
    expect(after.facts.some(f => f.fact_id === mem.id && f.expired_at)).toBe(true);
  });

  test("isError：fail 分支带 isError 标记（经 mcpCall 应抛错——此处直接验外壳）", async () => {
    const { c, h } = await client();
    // 直接发原始 JSON-RPC 看 isError 字段（mcpCall 抛错行为在 Task 2 的 client 层测）
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "delete_page", arguments: { slug: "no/such" } } }),
    });
    const payload = await res.json();
    expect(payload.result.isError).toBe(true);
    expect(JSON.parse(payload.result.content[0].text).error).toBeTruthy();
  });

  test("traverse_graph：out/in/both 三向", async () => {
    const { c } = await client();
    const out = await c.mcpCall<{ edges: { source: string; target: string }[]; nodes: { slug: string }[] }>("traverse_graph", { slug: "people/alice", depth: 1, direction: "out" });
    expect(out.edges.some(e => e.source === "people/alice" && e.target === "notes/seed-2")).toBe(true);
    const inbound = await c.mcpCall<{ edges: { source: string; target: string }[] }>("traverse_graph", { slug: "people/alice", depth: 1, direction: "in" });
    expect(inbound.edges.some(e => e.source === "notes/seed-1" && e.target === "people/alice")).toBe(true);
    const both = await c.mcpCall<{ edges: { source: string; target: string }[] }>("traverse_graph", { slug: "people/alice", depth: 1, direction: "both" });
    expect(both.edges.length).toBe(2);
  });

  test("entity：命中与未命中", async () => {
    const { c } = await client();
    const hit = await c.mcpCall<{ found: boolean; card?: { entity: { slug: string } } }>("entity", { name: "alice" });
    expect(hit.found).toBe(true);
    expect(hit.card?.entity.slug).toBe("people/alice");
    const miss = await c.mcpCall<{ found: boolean; suggestions?: unknown[] }>("entity", { name: "nobody" });
    expect(miss.found).toBe(false);
  });

  test("get_versions", async () => {
    const { c } = await client();
    const v = await c.mcpCall<{ versions: { version: number }[] }>("get_versions", { slug: "notes/seed-1" });
    expect(v.versions.length).toBe(2);
  });

  test("get_page 默认不含已删页；list_pages sort=updated", async () => {
    const { c } = await client();
    const dead = await c.mcpCall<{ found: boolean }>("get_page", { slug: "notes/dead-page" });
    expect(dead.found).toBe(false);
    const withDeleted = await c.mcpCall<{ page?: unknown; found: boolean }>("get_page", { slug: "notes/dead-page", include_deleted: true });
    expect(withDeleted.found).toBe(true);
    // 注：简报原文断言 sorted.pages[0]（包装形状）；基线已对齐真机裸数组形状（b97bdeb），此处取 sorted[0]
    const sorted = await c.mcpCall<{ slug: string }[]>("list_pages", { sort: "updated", limit: 3, include_deleted: true });
    expect(sorted[0].slug).toBe("notes/seed-2"); // 种子中最新
  });
});
