// server/src/gbrain-client.ts
export async function adminLoginRequest(port: number, token: string): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    const m = /gbrain_admin=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
    return m ? m[1] : null;
  } catch { return null; }
}

let rpcId = 0;

export class GbrainClient {
  private cookie: string | null = null;
  private apiKey: string | null = null;
  // 端口支持 getter：fallback 换端口后 client 自动跟随（数字用法不变）
  private readonly portRef: number | (() => number);

  constructor(port: number | (() => number), private bootstrapToken: string) {
    this.portRef = port;
  }

  private get port(): number { return typeof this.portRef === "function" ? this.portRef() : this.portRef; }

  private base() { return `http://127.0.0.1:${this.port}`; }

  private async ensureSession(): Promise<void> {
    if (this.cookie) return;
    this.cookie = await adminLoginRequest(this.port, this.bootstrapToken);
    if (!this.cookie) throw new Error("admin 登录失败（bootstrap token 不匹配？）");
  }

  // 惰性会话：首次不带 cookie 直发，401 才用 bootstrap token 登录并重试一次
  // （与简报差异：简报先 ensureSession 再请求，但其测试 responder 要求首个请求发生在登录前，
  //  否则"首次 401 + 重试"路径永远走不到；按 TDD 以测试为准。）
  private async withSession<T>(fn: (cookie: string | null) => Promise<Response>): Promise<T> {
    let res = await fn(this.cookie);
    if (res.status === 401) {
      this.cookie = null;
      await this.ensureSession();
      res = await fn(this.cookie);
    }
    if (!res.ok) throw new Error(`admin -> HTTP ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  adminGet<T>(path: string): Promise<T> {
    return this.withSession(cookie =>
      fetch(this.base() + path, { headers: { ...(cookie ? { cookie: `gbrain_admin=${cookie}` } : {}) } }));
  }

  adminPost<T>(path: string, body: unknown): Promise<T> {
    return this.withSession(cookie =>
      fetch(this.base() + path, {
        method: "POST",
        headers: { ...(cookie ? { cookie: `gbrain_admin=${cookie}` } : {}), "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
  }

  // 原始 fetch（带 cookie 会话）：供 SSE 等流式响应透传。401 重登一次（同 withSession 语义），
  // 但返回 Response 本身且不解析/不因非 2xx 抛错——错误处理交由调用方（如 SSE 路由的 502 分支）。
  async adminFetchRaw(path: string): Promise<Response> {
    const doFetch = (cookie: string | null) =>
      fetch(this.base() + path, { headers: { ...(cookie ? { cookie: `gbrain_admin=${cookie}` } : {}) } });
    let res = await doFetch(this.cookie);
    if (res.status === 401) {
      this.cookie = null;
      await this.ensureSession();
      res = await doFetch(this.cookie);
    }
    return res;
  }

  async issueApiKey(name: string): Promise<string> {
    // 同名先撤销（源码：revoke 按 name 撤所有 active 行；先撤后签防累积，冷启动至多 1 条 active）
    await this.adminPost("/admin/api/api-keys/revoke", { name }).catch(() => null);
    // 响应字段形状由 discovery（规格 §9.2）确认：真实返回 {name,token,id}，token 优先，兼容三种命名
    const json = await this.adminPost<Record<string, unknown>>("/admin/api/api-keys", { name });
    const key = (json.token ?? json.key ?? json.api_key) as string | undefined;
    if (!key) throw new Error(`api-keys 响应无 key 字段: ${JSON.stringify(json)}`);
    return key;
  }

  async mcpRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    // key 按需自签；签发失败（如 admin 会话不可用）不阻塞，匿名直连由服务端裁决。
    // 失败原因记入 issuanceError：匿名又遭 401/403 时附进错误消息，透出真正根因。
    let issuanceError: unknown = null;
    if (!this.apiKey) {
      try { this.apiKey = await this.issueApiKey("gbrain-panel"); }
      catch (e) { issuanceError = e; this.apiKey = null; }
    }
    const res = await fetch(this.base() + "/mcp", {
      method: "POST",
      headers: {
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? {} }),
    });
    if (!res.ok) {
      let msg = `mcp ${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      if ((res.status === 401 || res.status === 403) && issuanceError) {
        msg += `（根因：API key 签发失败——${String(issuanceError)}）`;
      }
      throw new Error(msg);
    }
    const ctype = res.headers.get("content-type") ?? "";
    const payload: any = ctype.includes("text/event-stream")
      ? parseSseJson(await res.text())
      : await res.json();
    if (payload?.error) throw new Error(`mcp ${method} rpc 错误: ${JSON.stringify(payload.error)}`);
    return payload.result as T;
  }

  async mcpCall<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      const result = await this.mcpRequest<{ content?: { type: string; text?: string }[]; isError?: boolean }>("tools/call", { name: op, arguments: args });
      const text = result?.content?.[0]?.text;
      // 工具级错误：HTTP 200 且 rpc 层无 error，但工具执行失败（isError=true）。
      // 不拦截的话错误体会被当正常数据解包返回，路由层 200 假成功（M3-2 加固）。
      if (result?.isError) {
        throw new Error(`mcp ${op} 工具级错误: ${typeof text === "string" ? text.slice(0, 300) : JSON.stringify(result.content)}`);
      }
      if (typeof text === "string") {
        try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
      }
      return result as unknown as T;
    } catch (err) {
      // 错误归因到具体 op 名：把 mcpRequest 抛出的 tools/call 层错误改写为 op（如 "mcp search -> HTTP 500"）
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("tools/call")) throw new Error(msg.replace("tools/call", () => op));
      throw err;
    }
  }
}

function parseSseJson(raw: string): any {
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* 跳过非 JSON 行 */ }
    }
  }
  throw new Error(`SSE 响应无 JSON data: ${raw.slice(0, 200)}`);
}
