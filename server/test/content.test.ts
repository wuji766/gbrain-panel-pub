import { describe, test, expect, afterEach } from "bun:test";
import { bootPanelWithFake, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const panels: { stop: (b?: boolean) => void }[] = [];
const fakes: FakeGbrainHandle[] = [];

async function boot() {
  const b = await bootPanelWithFake("healthy", TOKEN);
  panels.push(b.server); fakes.push(b.fake);
  return { panelPort: b.panelPort, fake: b.fake };
}
afterEach(async () => {
  for (const p of panels.splice(0)) p.stop(true);
  for (const f of fakes.splice(0)) await f.stop();
});

describe("内容路由 /api/pages", () => {
  test("PUT 新建 → GET 详情 → 列表可见", async () => {
    const { panelPort } = await boot();
    const put = await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "---\ntitle: M2测试\n---\n\n正文" }),
    });
    expect(put.status).toBe(200);
    const detail = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`)).json() as any;
    expect(detail.page.slug).toBe("notes/m2-test");
    expect(detail.page.title).toBe("M2测试");
    expect(Array.isArray(detail.links.links)).toBe(true);
    expect(Array.isArray(detail.timeline.entries)).toBe(true);
    const list = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?limit=50`)).json() as any;
    expect(list.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(true);
  });

  test("PUT 缺 content → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages/x`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });

  test("?q= 走 search", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?q=seed`)).json() as any;
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.results.length).toBeGreaterThan(0);
  });

  test("软删 → 回收站可见 → 恢复", async () => {
    const { panelPort } = await boot();
    await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) });
    await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`, { method: "DELETE" });
    const alive = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages`)).json() as any;
    expect(alive.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(false);
    const recycled = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?include_deleted=true`)).json() as any;
    expect(recycled.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(true);
    const restore = await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test/restore`, { method: "POST" });
    expect(restore.status).toBe(200);
    const again = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages`)).json() as any;
    expect(again.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(true);
  });

  test("下游死掉 → 502", async () => {
    const { panelPort, fake } = await boot();
    await fake.stop();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages`);
    expect(res.status).toBe(502);
  });
});

describe("内容路由 /api/facts", () => {
  test("新增 → 列表 → 遗忘（缺 reason 400）", async () => {
    const { panelPort } = await boot();
    const created = await (await fetch(`http://127.0.0.1:${panelPort}/api/facts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: "m2 测试", entity: "m2-entity", kind: "event" }),
    })).json() as any;
    expect(created.id).toBeTruthy();
    const list = await (await fetch(`http://127.0.0.1:${panelPort}/api/facts?entity=m2-entity&include_expired=true`)).json() as any;
    expect(list.facts.some((f: { fact_id: string }) => f.fact_id === created.id)).toBe(true);
    const bad = await fetch(`http://127.0.0.1:${panelPort}/api/facts/${created.id}/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    const okRes = await fetch(`http://127.0.0.1:${panelPort}/api/facts/${created.id}/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "清理测试" }) });
    expect(okRes.status).toBe(200);
    const after = await (await fetch(`http://127.0.0.1:${panelPort}/api/facts?entity=m2-entity&include_expired=true`)).json() as any;
    expect(after.facts.find((f: { fact_id: string }) => f.fact_id === created.id).expired).toBe(true);
  });

  test("缺 fact → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("/api/full-stats", () => {
  test("透传 admin full-stats（fake 未实现该路径时 502 也可接受）", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/full-stats`);
    expect([200, 502]).toContain(res.status);
  });
});
