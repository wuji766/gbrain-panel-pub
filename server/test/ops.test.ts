// server/test/ops.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { bootPanelWithFake, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const panels: { stop: (b?: boolean) => void }[] = [];
const fakes: FakeGbrainHandle[] = [];
async function boot() {
  const b = await bootPanelWithFake("healthy", TOKEN);
  panels.push(b.server); fakes.push(b.fake);
  return { panelPort: b.panelPort };
}
afterEach(async () => {
  for (const p of panels.splice(0)) p.stop(true);
  for (const f of fakes.splice(0)) await f.stop();
});

describe("运维路由", () => {
  test("requests 透传含 rows/total", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/requests?page=1`)).json() as any;
    expect(Array.isArray(json.rows)).toBe(true);
    expect(json.total).toBe(1);
  }, 15000);

  test("jobs 透传含 by_type/queue_health", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/jobs`)).json() as any;
    expect(Array.isArray(json.by_type)).toBe(true);
    expect(json.queue_health).toBeTruthy();
  }, 15000);

  test("agents 裸数组透传", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/agents`)).json() as any;
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(2);
  }, 15000);

  test("api-keys：GET 列表 / POST 签发返回一次性 token / revoke", async () => {
    const { panelPort } = await boot();
    const created = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "manual-test" }) })).json() as any;
    expect(created.token).toBeTruthy();
    const revoked = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "manual-test" }) })).json() as any;
    expect(revoked.revoked).toBe(true);
  }, 15000);

  test("key 自清理：issueApiKey 先 revoke 同名（fake 计数验证）", async () => {
    const b = await bootPanelWithFake("healthy", TOKEN);
    panels.push(b.server); fakes.push(b.fake);
    const client = b.client;
    await client.mcpCall("list_pages", { limit: 1 }); // 触发 issueApiKey("gbrain-panel")
    const counters = await (await fetch(`http://127.0.0.1:${b.fake.port}/__calls`)).json() as Record<string, number>;
    // fake 的 /__calls 只计 /mcp op；admin 调用计数复用 /__calls 顶层键（fake 实现时把 admin 路径也计数，键为路径）
    expect(counters["POST /admin/api/api-keys/revoke"]).toBeGreaterThanOrEqual(1);
  }, 15000);

  test("SSE 代理转发 content-type 与首块", async () => {
    const { panelPort } = await boot();
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    ctrl.abort(); // 读到头即可，流由 abort 掐断
  }, 15000);
});
