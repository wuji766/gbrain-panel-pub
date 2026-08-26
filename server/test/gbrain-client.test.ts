// server/test/gbrain-client.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { adminLoginRequest, GbrainClient } from "../src/gbrain-client";

const PORT = 4567;
const realFetch = globalThis.fetch;
let calls: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
let responder: (c: { method: string; url: string; body?: any }) => { status: number; json?: any; cookie?: string };

function mockFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const c = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = responder({ ...c, headers: {} });
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
    expect(await client.adminGet("/admin/api/stats")).toEqual({ pages: 1 });
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
    expect(await client.mcpCall("list_pages", { limit: 5 })).toEqual({ rows: [] });
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
    expect(await client.mcpRequest("tools/list")).toEqual({ tools: [{ name: "list_pages" }] });
  });

  test("HTTP 错误抛出含 op 名与状态码", async () => {
    responder = (c) => c.url.endsWith("/mcp") ? { status: 500 } : { status: 204, cookie: "s" };
    const client = new GbrainClient(PORT, "tok");
    await expect(client.mcpCall("search")).rejects.toThrow(/mcp search -> HTTP 500/);
  });
});
