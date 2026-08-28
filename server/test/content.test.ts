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
  }, 15000);

  test("PUT 缺 content → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages/x`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  }, 15000);

  test("?q= 走 search（面板统一归一化为 {pages,total}）", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?q=seed`)).json() as any;
    expect(Array.isArray(json.pages)).toBe(true);
    expect(json.pages.length).toBeGreaterThan(0);
  }, 15000);

  test("软删 → 回收站可见（含 deleted_at）→ 恢复", async () => {
    const { panelPort } = await boot();
    await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) });
    await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`, { method: "DELETE" });
    const alive = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages`)).json() as any;
    expect(alive.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(false);
    const recycled = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?include_deleted=true`)).json() as any;
    const row = recycled.pages.find((p: { slug: string }) => p.slug === "notes/m2-test");
    expect(row).toBeTruthy();
    expect(row.deleted_at).toBeTruthy();
    const restore = await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test/restore`, { method: "POST" });
    expect(restore.status).toBe(200);
    const again = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages`)).json() as any;
    expect(again.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(true);
  }, 15000);

  test("下游死掉 → 502", async () => {
    const { panelPort, fake } = await boot();
    await fake.stop();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages`);
    expect(res.status).toBe(502);
  }, 15000);
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
    const afterRow = after.facts.find((f: { fact_id: string }) => f.fact_id === created.id);
    expect(afterRow.expired).toBe(true);       // 服务端由 expired_at 归一化出的布尔（真实 recall 行无此字段）
    expect(afterRow.expired_at).toBeTruthy();
  }, 15000);

  test("缺 fact → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  }, 15000);
});

describe("/api/full-stats", () => {
  test("透传 admin full-stats（fake 未实现该路径时 502 也可接受）", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/full-stats`);
    expect([200, 502]).toContain(res.status);
  }, 15000);
});

describe("/api/update-check", () => {
  test("返回 current/latest/networkError 形状；网络不可达时不报 5xx", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/update-check`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(["current", "latest", "networkError", "upToDate", "checkedAt"].every(k => k in json)).toBe(true);
  }, 15000);
});

describe("M3 server 加固", () => {
  test("op 级错误（isError）→ 502 而非 200 假成功", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages/no/such/page`, { method: "DELETE" });
    expect(res.status).toBe(502);
  }, 15000);

  test("q + type 组合：type 映射进 search types 参数", async () => {
    const { panelPort } = await boot();
    // fake 的 search 不认 types——仅断言不 500 且仍是 search 形状（面板统一归一化为 {pages,total}）
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages?q=seed&type=note`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(Array.isArray(json.pages)).toBe(true);
  }, 15000);

  test("limit=abc 回退默认不产生 NaN 下传", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages?limit=abc`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(Array.isArray(json.pages)).toBe(true);
    // NaN 下传时下游 slice(0, NaN) 得空列表；守卫生效则默认 limit=50 能拿到种子页
    expect(json.pages.length).toBeGreaterThan(0);
  }, 15000);

  test("详情默认含已删页（可看 deleted_at）", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/dead-page`)).json() as any;
    expect(json.page.deleted_at).toBeTruthy();
  }, 15000);

  test("GET /api/pages/:slug/versions 返回版本列表", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/seed-1/versions`)).json() as any;
    expect(json.versions.length).toBe(2);
  }, 15000);
});

describe("回收站差集补齐", () => {
  test("include_deleted=true 只对已删行发 get_page（fake 记数）", async () => {
    const b = await boot();
    await fetch(`http://127.0.0.1:${b.panelPort}/api/pages?include_deleted=true&limit=50`);
    // fake 的 /__calls 计数端点（bootPanelWithFake 直连 fake 子进程，计数自 fake 启动累计）
    const counters = await (await fetch(`http://127.0.0.1:${b.fake.port}/__calls`)).json() as Record<string, number>;
    expect(counters.list_pages).toBe(2);                    // 存活集 + 全集
    expect(counters.get_page ?? 0).toBeLessThanOrEqual(2);  // 仅已删行（种子 1 条 + 容差）
  }, 15000);
});
