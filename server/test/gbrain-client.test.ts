// server/test/gbrain-client.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { adminLoginRequest, GbrainClient } from "../src/gbrain-client";

// tsc 兼容留痕（M2 Task 2）：bun-types 的 expect 重载会把「内联 await 泛型返回值」的 T 推断为
// undefined，使 toEqual 参数类型报错；对内联 await 的值加 as 收窄即可（as 编译期擦除，零运行时影响）。
// 同因：mockFetch 的 c 对象与 calls/responder 声明形状不完全一致，在两处用 as 收窄。

const PORT = 4567;
const realFetch = globalThis.fetch;
let calls: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
let responder: (c: { method: string; url: string; body?: any }) => { status: number; json?: any; cookie?: string };

function mockFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const c = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c as typeof calls[number]);
    const r = responder({ ...c, headers: {} } as Parameters<typeof responder>[0]);
    return new Response(r.json ? JSON.stringify(r.json) : null, {
      status: r.status,
      headers: { ...(r.cookie ? { "set-cookie": `gbrain_admin=${r.cookie}; Path=/` } : {}), "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => { calls = []; mockFetch(); });
afterEach(() => { globalThis.fetch = realFetch; });

describe("adminLoginRequest", () => {
  test("成功返回 cookie 值", async () => {
    responder = () => ({ status: 204, cookie: "sess123" });
    expect(await adminLoginRequest(PORT, "tok")).toBe("sess123");
  });
  test("401 返回 null", async () => {
    responder = () => ({ status: 401 });
    expect(await adminLoginRequest(PORT, "bad")).toBeNull();
  });
});

describe("GbrainClient", () => {
  test("adminGet 带 cookie，401 时重登重试一次", async () => {
    let authed = false;
    responder = (c) => {
      if (c.url.endsWith("/admin/login")) { authed = true; return { status: 204, cookie: "s2" }; }
      const ok = authed && c.method === "GET";
      return ok ? { status: 200, json: { pages: 1 } } : { status: 401 };
    };
    const client = new GbrainClient(PORT, "tok");
    expect((await client.adminGet("/admin/api/stats")) as { pages: number }).toEqual({ pages: 1 });
    expect(calls.filter(c => c.url.endsWith("/admin/api/stats")).length).toBe(2); // 首次401+重试
  });

  test("issueApiKey 用 POST，兼容 key 字段", async () => {
    responder = (c) => c.url.endsWith("/admin/api/api-keys")
      ? { status: 200, json: { key: "kkk" } } : { status: 204, cookie: "s" };
    const client = new GbrainClient(PORT, "tok");
    expect(await client.issueApiKey("panel")).toBe("kkk");
    expect(calls.find(c => c.url.endsWith("/admin/api/api-keys"))?.method).toBe("POST");
  });

  test("mcpCall 走 Bearer key + tools/call，解包 content[0].text", async () => {
    responder = (c) => {
      if (c.url.endsWith("/admin/api/api-keys")) return { status: 200, json: { key: "kkk" } };
      if (c.url.endsWith("/mcp")) return { status: 200, json: { jsonrpc: "2.0", id: c.body.id, result: { content: [{ type: "text", text: '{"rows":[]}' }] } } };
      return { status: 204, cookie: "s" };
    };
    const client = new GbrainClient(PORT, "tok");
    expect((await client.mcpCall("list_pages", { limit: 5 })) as { rows: unknown[] }).toEqual({ rows: [] });
    const mcpCall = calls.find(c => c.url.endsWith("/mcp"));
    expect(mcpCall?.body.method).toBe("tools/call");
    expect(mcpCall?.body.params.name).toBe("list_pages");
  });

  test("mcpRequest 方法级调用（tools/list）", async () => {
    responder = (c) => {
      if (c.url.endsWith("/mcp")) return { status: 200, json: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_pages" }] } } };
      return { status: 200, json: { key: "kkk" } };
    };
    const client = new GbrainClient(PORT, "tok");
    expect((await client.mcpRequest("tools/list")) as { tools: { name: string }[] }).toEqual({ tools: [{ name: "list_pages" }] });
  });

  test("HTTP 错误抛出含 op 名与状态码", async () => {
    responder = (c) => c.url.endsWith("/mcp") ? { status: 500 } : { status: 204, cookie: "s" };
    const client = new GbrainClient(PORT, "tok");
    await expect(client.mcpCall("search")).rejects.toThrow(/mcp search -> HTTP 500/);
  });

  test("端口 getter：函数形式动态取端口", async () => {
    let port = 1111;
    responder = (c) => c.url.includes(":1111") || c.url.includes(":2222")
      ? { status: 200, json: { ok: true } } : { status: 404 };
    const client = new GbrainClient(() => port, "tok");
    expect((await client.adminGet("/admin/api/stats")) as { ok: boolean }).toEqual({ ok: true });
    port = 2222;
    expect((await client.adminGet("/admin/api/stats")) as { ok: boolean }).toEqual({ ok: true });
    expect(calls.filter(c => c.url.includes(":1111")).length).toBeGreaterThan(0);
    expect(calls.filter(c => c.url.includes(":2222")).length).toBeGreaterThan(0);
  });

  test("签 key 失败 + /mcp 401 时错误含根因", async () => {
    responder = (c) => {
      if (c.url.endsWith("/admin/api/api-keys")) return { status: 200, json: { no_key_field: true } };
      if (c.url.endsWith("/mcp")) return { status: 401 };
      return { status: 204, cookie: "s" };
    };
    const client = new GbrainClient(PORT, "tok");
    await expect(client.mcpCall("list_pages")).rejects.toThrow(/根因.*api-keys 响应无 key 字段/);
  });

  test("mcpCall 检查工具级 isError 并抛错", async () => {
    responder = (c) => {
      if (c.url.endsWith("/admin/api/api-keys")) return { status: 200, json: { key: "kkk" } };
      if (c.url.endsWith("/mcp")) return { status: 200, json: { jsonrpc: "2.0", id: c.body.id, result: { content: [{ type: "text", text: '{"error":"not found"}' }], isError: true } } };
      return { status: 204, cookie: "s" };
    };
    const client = new GbrainClient(PORT, "tok");
    await expect(client.mcpCall("delete_page", { slug: "x" })).rejects.toThrow(/delete_page 工具级错误.*not found/);
  });

  test("并发首次 mcpRequest 只签一把 key（single-flight，防同名 active 累积）", async () => {
    // 语义对齐真实 fake/gbrain：revoke 清空同名 active，issue 追加一条 active
    const active: string[] = [];
    responder = (c) => {
      if (c.url.endsWith("/admin/api/api-keys/revoke")) { active.length = 0; return { status: 200, json: { revoked: true } }; }
      if (c.url.endsWith("/admin/api/api-keys")) { active.push(`k${active.length + 1}`); return { status: 200, json: { key: `k${active.length}` } }; }
      if (c.url.endsWith("/mcp")) return { status: 200, json: { jsonrpc: "2.0", id: c.body.id, result: { tools: [] } } };
      return { status: 204, cookie: "s" };
    };
    const client = new GbrainClient(PORT, "tok");
    await Promise.all([
      client.mcpRequest("tools/list"),
      client.mcpRequest("tools/list"),
      client.mcpRequest("tools/list"),
    ]);
    // 旧代码：3 个调用都在任何签发落地前看到 apiKey===null → 3 撤 3 签 → 3 条 active（M6 验收实证）
    expect(active.length).toBe(1);
    expect(calls.filter(c => c.url.endsWith("/admin/api/api-keys")).length).toBe(1);
  });
});
