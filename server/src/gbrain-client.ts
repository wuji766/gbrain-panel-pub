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

  constructor(private port: number, private bootstrapToken: string) {}

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

  async issueApiKey(name: string): Promise<string> {
    // 响应字段形状由 discovery（规格 §9.2）确认，这里兼容三种常见命名
    const json = await this.adminPost<Record<string, unknown> | undefined>("/admin/api/api-keys", { name });
    const key = (json?.key ?? json?.api_key ?? json?.token) as string | undefined;
    if (!key) throw new Error(`api-keys 响应无 key 字段: ${JSON.stringify(json)}`);
    return key;
  }

  async mcpRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    // key 按需自签；签发失败（如 admin 会话不可用）不阻塞，匿名直连由服务端裁决
    if (!this.apiKey) {
      try { this.apiKey = await this.issueApiKey("gbrain-panel"); } catch { this.apiKey = null; }
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
    if (!res.ok) throw new Error(`mcp ${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const ctype = res.headers.get("content-type") ?? "";
    const payload: any = ctype.includes("text/event-stream")
      ? parseSseJson(await res.text())
      : await res.json();
    if (payload?.error) throw new Error(`mcp ${method} rpc 错误: ${JSON.stringify(payload.error)}`);
    return payload.result as T;
  }

  async mcpCall<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      const result = await this.mcpRequest<{ content?: { type: string; text?: string }[] }>("tools/call", { name: op, arguments: args });
      const text = result?.content?.[0]?.text;
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
