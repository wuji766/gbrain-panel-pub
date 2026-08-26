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

describe("fake /mcp 分发器", () => {
  test("put→list→get→delete→restore 全链路", async () => {
    const { c } = await client();
    await c.mcpCall("put_page", { slug: "notes/new-page", content: "---\ntitle: 新页\n---\n\n正文" });
    const list = await c.mcpCall<{ pages: { slug: string }[]; total: number }>("list_pages", { include_deleted: false });
    expect(list.pages.some(p => p.slug === "notes/new-page")).toBe(true);
    const got = await c.mcpCall<{ page: { title?: string } }>("get_page", { slug: "notes/new-page", include_content: true });
    expect(got.page.title).toBe("新页");
    await c.mcpCall("delete_page", { slug: "notes/new-page" });
    const alive = await c.mcpCall<{ pages: { slug: string }[] }>("list_pages", { include_deleted: false });
    expect(alive.pages.some(p => p.slug === "notes/new-page")).toBe(false);
    const deleted = await c.mcpCall<{ pages: { slug: string }[] }>("list_pages", { include_deleted: true });
    expect(deleted.pages.some(p => p.slug === "notes/new-page")).toBe(true);
    await c.mcpCall("restore_page", { slug: "notes/new-page" });
    const restored = await c.mcpCall<{ pages: { slug: string }[] }>("list_pages", { include_deleted: false });
    expect(restored.pages.some(p => p.slug === "notes/new-page")).toBe(true);
  });

  test("search 子串匹配", async () => {
    const { c } = await client();
    const r = await c.mcpCall<{ results: { slug: string }[] }>("search", { query: "seed" });
    expect(r.results.length).toBeGreaterThan(0);
  });

  test("remember→recall(include_expired)→forget", async () => {
    const { c } = await client();
    const mem = await c.mcpCall<{ id: string }>("remember", { fact: "面板测试事实", provenance: "panel", entity: "test-entity" });
    expect(mem.id).toBeTruthy();
    const before = await c.mcpCall<{ facts: { fact_id: string; expired: boolean }[] }>("recall", { entity: "test-entity", include_expired: true });
    expect(before.facts.some(f => f.fact_id === mem.id && !f.expired)).toBe(true);
    const fg = await c.mcpCall<{ expired: boolean }>("forget", { id: mem.id, reason: "测试遗忘" });
    expect(fg.expired).toBe(true);
    const after = await c.mcpCall<{ facts: { fact_id: string; expired: boolean }[] }>("recall", { entity: "test-entity", include_expired: true });
    expect(after.facts.some(f => f.fact_id === mem.id && f.expired)).toBe(true);
  });
});
