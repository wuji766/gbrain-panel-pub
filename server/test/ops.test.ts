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

  test("jobs 透传含 ts_ms/by_type/queue_health（WatchSnapshot 真实形状）", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/jobs`)).json() as any;
    expect(typeof json.ts_ms).toBe("number");
    expect(Array.isArray(json.by_type)).toBe(true);
    expect(json.by_type[0]).toMatchObject({ name: "embed", total: 3, completed: 2, failed: 1, dead: 0 });
    expect(json.queue_health).toMatchObject({ waiting: 0, active: 0, stalled: 0 });
    expect(typeof json.lease_pressure_1h).toBe("number");
  }, 15000);

  test("agents 裸数组透传", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/agents`)).json() as any;
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(2);
    expect(json[0]).toMatchObject({ id: "uuid-1", name: "zcode-main", auth_type: "oauth", status: "active" });
    expect(json[1]).toMatchObject({ id: "uuid-2", name: "gbrain-panel", auth_type: "api_key", status: "active" });
  }, 15000);

  test("api-keys：GET 列表 / POST 签发返回一次性 token / revoke", async () => {
    const { panelPort } = await boot();
    const list = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys`)).json() as any;
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((k: any) => k.name === "gbrain-panel" && k.status === "active")).toBe(true);
    const created = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "manual-test" }) })).json() as any;
    expect(created.token).toBeTruthy();
    const revoked = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "manual-test" }) })).json() as any;
    expect(revoked.revoked).toBe(true);
    // 状态机一致性：revoke 后 GET 列表中同名条目应变为 revoked
    const after = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys`)).json() as any;
    const manual = after.filter((k: any) => k.name === "manual-test");
    expect(manual.length).toBeGreaterThanOrEqual(1);
    expect(manual.every((k: any) => k.status === "revoked")).toBe(true);
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

  test("SSE 空闲心跳：上游无数据时面板注入 : ping 保活（M6）", async () => {
    const { panelPort } = await boot();
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // fake 的 /admin/events 握手写一次 ": connected" 后挂起——空闲期只能来自面板心跳
    const reader = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 6500; // 首个 ping ~5s，留 1.5s 余量
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<undefined>(r => setTimeout(() => r(undefined), Math.max(0, deadline - Date.now()))),
      ]);
      if (!chunk) break;
      text += new TextDecoder().decode(chunk.value);
      if (text.includes(": ping")) break;
    }
    ctrl.abort();
    expect(text).toContain(": ping");
  }, 15000);
});
