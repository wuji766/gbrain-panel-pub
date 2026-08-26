# gbrain 可视化面板 M1（地基）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成面板的地基：Bun+Hono 后端能编排 gbrain serve 生命周期（spawn/attach/整树退出），Vue 3 前端骨架 + 仪表盘可用，并为 M2 产出真实接口形状探测数据（discovery）。

**Architecture:** 面板后端（127.0.0.1:7070）spawn `gbrain serve --http --surface full`（:3131）作为唯一持锁子进程；admin cookie 会话 + 自签 API key 走 `/mcp` JSON-RPC；前端 SPA 由后端静态托管。设计规格见 `docs/superpowers/specs/2026-08-26-gbrain-panel-design.md`。

**Tech Stack:** Bun ≥1.3.10、Hono 4、TypeScript；Vue 3 + Vite + Naive UI + Pinia + vue-router（hash）。

## Global Constraints

- 平台 Windows；所有网络监听仅 127.0.0.1。
- **严禁修改 `D:\gbrain-stock` 内任何文件**；对 gbrain 只做 HTTP 访问。
- **严禁写系统盘临时目录**（%TEMP% 等）；测试临时文件统一用 `server/test/.tmp/`（已 gitignore，测试自建自清）。
- `config.json` 含 bootstrap token，**必须 gitignore**，永不提交。
- 构建类命令（`vite build`、dev server、`bun run dev`）**由用户手动执行**，执行者不得运行；`bun test` 允许执行。
- 提交信息用 conventional commits（feat:/test:/docs:/chore:）。
- 测试中 spawn 的子进程必须在测试结束前杀干净，防孤儿占端口。

---

### Task 1: 项目脚手架（workspace 结构）

**Files:**
- Create: `package.json`、`.gitignore`、`server/package.json`、`server/tsconfig.json`、`web/package.json`、`web/tsconfig.json`、`README.md`（占位，Task 9 完整化）

**Interfaces:**
- Produces: bun workspace（root workspaces: `["server","web"]`）；后续所有任务在此结构内工作。

- [ ] **Step 1: 写根 package.json 与 .gitignore**

```json
// package.json
{
  "name": "gbrain-panel",
  "private": true,
  "workspaces": ["server", "web"],
  "scripts": {
    "dev:server": "bun run server/src/index.ts",
    "test": "bun test server/",
    "discover": "bun run server/scripts/discover.ts"
  }
}
```

```gitignore
# .gitignore
node_modules/
web/dist/
config.json
server/test/.tmp/
*.log
```

- [ ] **Step 2: 写 server/package.json 与 server/tsconfig.json**

```json
// server/package.json
{
  "name": "gbrain-panel-server",
  "private": true,
  "type": "module",
  "dependencies": { "hono": "^4.6.0" },
  "devDependencies": { "@types/bun": "^1.3.0", "typescript": "^5.6.0" }
}
```

```json
// server/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 3: 写 web/package.json 与 web/tsconfig.json**

```json
// web/package.json
{
  "name": "gbrain-panel-web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "naive-ui": "^2.40.0",
    "pinia": "^2.3.0",
    "vue": "^3.5.0",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vue-tsc": "^2.1.0"
  }
}
```

```json
// web/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "preserve",
    "lib": ["ESNext", "DOM"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 4: 写 README 占位并安装依赖**

```markdown
# gbrain-panel

gbrain 可视化操作面板。设计规格：docs/superpowers/specs/2026-08-26-gbrain-panel-design.md
（完整使用说明在 M1 收尾任务补充。）
```

Run: `cd /d D:\gbrain-panel && bun install`
Expected: 依赖安装成功，生成 bun.lock。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: 项目脚手架（bun workspace: server + web）"
```

---

### Task 2: config 模块（加载/首启生成）

**Files:**
- Create: `server/src/config.ts`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(path: string): PanelConfig`、`saveConfig(path, cfg)`、`generateToken(): string`、`interface PanelConfig { gbrainBin; gbrainHome; panelPort; gbrainPort; bootstrapToken; backupDir; backupRetention }`、`DEFAULTS`。后续任务全部从这拿配置。

- [ ] **Step 1: 写失败测试**

```ts
// server/test/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, generateToken } from "../src/config";

const TMP = join(import.meta.dir, ".tmp");
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(TMP, "cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  test("首启生成配置文件，token 为 43 位 base64url", () => {
    const p = join(dir, "config.json");
    const cfg = loadConfig(p);
    expect(existsSync(p)).toBe(true);
    expect(cfg.bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfg.panelPort).toBe(7070);
    expect(cfg.gbrainPort).toBe(3131);
  });
  test("二次加载返回相同 token（持久）", () => {
    const p = join(dir, "config.json");
    const a = loadConfig(p); const b = loadConfig(p);
    expect(b.bootstrapToken).toBe(a.bootstrapToken);
  });
  test("已有配置的字段被尊重，缺省字段补默认且回写 token", () => {
    const p = join(dir, "config.json");
    writeManual(p, { panelPort: 8080 });
    const cfg = loadConfig(p);
    expect(cfg.panelPort).toBe(8080);
    expect(cfg.gbrainPort).toBe(3131);
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.bootstrapToken).toBe(cfg.bootstrapToken);
  });
});

function writeManual(p: string, obj: unknown) {
  const { writeFileSync } = require("node:fs");
  writeFileSync(p, JSON.stringify(obj));
}
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/config.test.ts`
Expected: FAIL（cannot find module `../src/config`）

- [ ] **Step 3: 实现 config.ts**

```ts
// server/src/config.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface PanelConfig {
  gbrainBin: string;
  gbrainHome: string;
  panelPort: number;
  gbrainPort: number;
  bootstrapToken: string;
  backupDir: string;
  backupRetention: number;
}

export const DEFAULTS = {
  gbrainBin: "C:\\Users\\wuji\\.bun\\bin\\gbrain.exe",
  gbrainHome: "D:\\gbrain-stock\\brain-data",
  panelPort: 7070,
  gbrainPort: 3131,
  backupDir: "D:\\gbrain-backup",
  backupRetention: 5,
};

export function generateToken(): string {
  return randomBytes(32).toString("base64url"); // 43 位，[A-Za-z0-9_-]
}

export function saveConfig(path: string, cfg: PanelConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

export function loadConfig(path: string): PanelConfig {
  if (!existsSync(path)) {
    const cfg = { ...DEFAULTS, bootstrapToken: generateToken() };
    saveConfig(path, cfg);
    return cfg;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PanelConfig>;
  const cfg = { ...DEFAULTS, ...parsed } as PanelConfig;
  if (!parsed.bootstrapToken) { cfg.bootstrapToken = generateToken(); saveConfig(path, cfg); }
  return cfg;
}
```

注意测试里 `mkdtempSync` 需要 `server/test/.tmp` 目录存在——若报错，在 beforeEach 前加 `mkdirSync(TMP, { recursive: true })`（导入 `node:fs` 的 `mkdirSync`）。

- [ ] **Step 4: 运行确认通过**

Run: `bun test server/test/config.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat: config 模块（首启生成 token、缺省合并回写）"
```

---

### Task 3: 健康探测 + fake-gbrain 测试替身

**Files:**
- Create: `server/src/health.ts`、`server/test/fixtures/fake-gbrain.ts`、`server/test/helpers.ts`
- Test: `server/test/health.test.ts`

**Interfaces:**
- Produces: `probeHealth(port: number, timeoutMs?: number): Promise<boolean>`；`startFakeGbrain(opts): Promise<{ port: number; stop(): Promise<void> }>`（helpers 导出，opts: `{ mode: "healthy" | "foreign"; token: string; port?: number; healthDelayMs?: number }`，port 省略则自动找空闲端口）。Task 5/7 的测试依赖此替身。

- [ ] **Step 1: 写失败测试**

```ts
// server/test/health.test.ts
import { describe, test, expect } from "bun:test";
import { probeHealth } from "../src/health";
import { startFakeGbrain } from "./helpers";

describe("probeHealth", () => {
  test("健康端口返回 true", async () => {
    const fake = await startFakeGbrain({ mode: "healthy", token: "t" });
    try { expect(await probeHealth(fake.port, 2000)).toBe(true); }
    finally { await fake.stop(); }
  });
  test("无人监听的端口返回 false", async () => {
    expect(await probeHealth(59999, 500)).toBe(false);
  });
});
```

```ts
// server/test/helpers.ts
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { probeHealth } from "../src/health";

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface FakeGbrainHandle { port: number; child: ReturnType<typeof spawn>; stop(): Promise<void> }

export async function startFakeGbrain(opts: {
  mode: "healthy" | "foreign"; token: string; port?: number; healthDelayMs?: number;
}): Promise<FakeGbrainHandle> {
  const port = opts.port ?? await getFreePort();
  const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "fake-gbrain.ts")], {
    env: {
      ...process.env,
      FAKE_PORT: String(port),
      FAKE_TOKEN: opts.token,
      FAKE_MODE: opts.mode,
      HEALTH_DELAY_MS: String(opts.healthDelayMs ?? 0),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fake-gbrain 提前退出 code=${child.exitCode}`);
    if (await probeHealth(port, 500)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (child.exitCode !== null) throw new Error("fake-gbrain 未就绪");
  return {
    port, child,
    stop: async () => {
      if (process.platform === "win32") {
        await new Promise<void>(res => spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", () => res()));
      } else { child.kill("SIGKILL"); }
      await new Promise(r => setTimeout(r, 200));
    },
  };
}
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/health.test.ts`
Expected: FAIL（cannot find module `../src/health`）

- [ ] **Step 3: 实现 health.ts 与 fake-gbrain.ts**

```ts
// server/src/health.ts
export async function probeHealth(port: number, timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
}
```

```ts
// server/test/fixtures/fake-gbrain.ts
// 用 Bun 起一个 HTTP 服务模拟 gbrain serve --http 的最小行为。
// 模式由环境变量控制：FAKE_MODE=healthy|foreign|crash|hang
const mode = process.env.FAKE_MODE ?? "healthy";
const port = Number(process.env.FAKE_PORT ?? 3999);
const token = process.env.FAKE_TOKEN ?? "";
const delay = Number(process.env.HEALTH_DELAY_MS ?? 0);

if (mode === "crash") { console.error("fake crash"); process.exit(1); }

if (mode === "hang") {
  setInterval(() => {}, 60000); // 不监听任何端口，模拟卡死
} else {
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        await new Promise(r => setTimeout(r, delay));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/admin/login") {
        if (mode === "foreign") return new Response("401", { status: 401 });
        const body = await req.json().catch(() => ({}) as { token?: string });
        if (body.token === token) {
          return new Response(null, { status: 204, headers: { "set-cookie": "gbrain_admin=fakesess; Path=/; HttpOnly" } });
        }
        return new Response("401", { status: 401 });
      }
      if (url.pathname === "/admin/api/stats") {
        return Response.json({ pages: 42, facts: 100, sources: 3 });
      }
      if (url.pathname === "/admin/api/health-indicators") {
        return Response.json({ status: "ok", checks: [{ name: "db", ok: true }] });
      }
      if (url.pathname === "/admin/api/api-keys" && req.method === "POST") {
        return Response.json({ key: "fake-api-key-123", name: (await req.json().catch(() => ({}))).name ?? "" });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        const body = await req.json();
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ echo: body.params }) }] } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`fake-gbrain(${mode}) listening :${server.port}`);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test server/test/health.test.ts`
Expected: 2 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/health.ts server/test/health.test.ts server/test/helpers.ts server/test/fixtures/fake-gbrain.ts
git commit -m "test: probeHealth 与 fake-gbrain 测试替身"
```

---

### Task 4: gbrain-client（admin 会话 + API key + MCP JSON-RPC）

**Files:**
- Create: `server/src/gbrain-client.ts`
- Test: `server/test/gbrain-client.test.ts`

**Interfaces:**
- Consumes: 无（纯 HTTP 客户端）。
- Produces:
  - `adminLoginRequest(port: number, token: string): Promise<string | null>`（返回会话 cookie 值，失败 null）——Task 5 orchestrator 的 attach 判定用它。
  - `class GbrainClient { constructor(port: number, bootstrapToken: string); adminGet<T>(path): Promise<T>; adminPost<T>(path, body): Promise<T>; issueApiKey(name): Promise<string>; mcpRequest<T>(method: string, params?: unknown): Promise<T>; mcpCall<T>(op: string, args?: Record<string, unknown>): Promise<T> }`
  - 401 自动重登一次再重试；`mcpCall` 内部按需 `issueApiKey("gbrain-panel")`。
  - API key 响应字段兼容 `key | api_key | token`（真实形状由 Task 9 discovery 验证，规格 §9.2）。

- [ ] **Step 1: 写失败测试**

```ts
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
      if (c.url.endsWith("/mcp")) return { status: 200, json: { jsonrpc: "2.0", id: c.body.id, result: { content: [{ type: "text", text: '{"rows":[]}' }] } };
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
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/gbrain-client.test.ts`
Expected: FAIL（cannot find module）

- [ ] **Step 3: 实现 gbrain-client.ts**

```ts
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

  private async withSession<T>(fn: (cookie: string) => Promise<Response>): Promise<T> {
    await this.ensureSession();
    let res = await fn(this.cookie!);
    if (res.status === 401) {
      this.cookie = null;
      await this.ensureSession();
      res = await fn(this.cookie!);
    }
    if (!res.ok) throw new Error(`admin -> HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }

  adminGet<T>(path: string): Promise<T> {
    return this.withSession(cookie =>
      fetch(this.base() + path, { headers: { cookie: `gbrain_admin=${cookie}` } }));
  }

  adminPost<T>(path: string, body: unknown): Promise<T> {
    return this.withSession(cookie =>
      fetch(this.base() + path, {
        method: "POST",
        headers: { cookie: `gbrain_admin=${cookie}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
  }

  async issueApiKey(name: string): Promise<string> {
    // 响应字段形状由 discovery（规格 §9.2）确认，这里兼容三种常见命名
    const json = await this.adminPost<Record<string, unknown>>("/admin/api/api-keys", { name });
    const key = (json.key ?? json.api_key ?? json.token) as string | undefined;
    if (!key) throw new Error(`api-keys 响应无 key 字段: ${JSON.stringify(json)}`);
    return key;
  }

  async mcpRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.apiKey) this.apiKey = await this.issueApiKey("gbrain-panel");
    const res = await fetch(this.base() + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
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
    const result = await this.mcpRequest<{ content?: { type: string; text?: string }[] }>("tools/call", { name: op, arguments: args });
    const text = result?.content?.[0]?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    }
    return result as unknown as T;
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
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test server/test/gbrain-client.test.ts`
Expected: 6 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/gbrain-client.ts server/test/gbrain-client.test.ts
git commit -m "feat: gbrain-client（admin 会话保活/自签 key/MCP JSON-RPC 封装）"
```

---

### Task 5: Orchestrator（serve 生命周期状态机）

**Files:**
- Create: `server/src/orchestrator.ts`
- Test: `server/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `PanelConfig`（Task 2）、`probeHealth`（Task 3）、`adminLoginRequest`（Task 4）、`startFakeGbrain`/`getFreePort`（Task 3）。
- Produces:
  - `type OrchState = "idle" | "probing" | "spawning" | "starting" | "own" | "attached" | "foreign" | "stopped" | "error"`
  - `class Orchestrator { constructor(cfg: PanelConfig, opts?: { spawnSpec?: { bin: string; baseArgs: string[] }; healthTimeoutMs?: number; pollIntervalMs?: number }); start(): Promise<OrchState>; spawnOnFallbackPort(): Promise<OrchState>; killServe(): Promise<void>; getState(): OrchState; getEffectivePort(): number; getRecentLogs(): string[]; onStateChange(cb: (s: OrchState) => void): () => void }`
  - `spawnSpec` 供测试注入（真实运行用 `cfg.gbrainBin`）；`getEffectivePort()` 在 attached 模式 = cfg.gbrainPort，自有子进程 = 实际监听端口（含 fallback）。
  - attach 模式下 `killServe()` **不杀**别人的进程（幂等置 stopped）。

- [ ] **Step 1: 写失败测试**

```ts
// server/test/orchestrator.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { Orchestrator, type OrchState } from "../src/orchestrator";
import { probeHealth } from "../src/health";
import { startFakeGbrain, getFreePort, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const FIXTURE = join(import.meta.dir, "fixtures", "fake-gbrain.ts");
const spawned: FakeGbrainHandle[] = [];
const orchs: Orchestrator[] = [];

function makeOrch(port: number, opts: { healthTimeoutMs?: number } = {}) {
  const orch = new Orchestrator(
    { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 },
    {
      spawnSpec: { bin: process.execPath, baseArgs: [FIXTURE] },
      healthTimeoutMs: opts.healthTimeoutMs ?? 8000,
      pollIntervalMs: 100,
    },
  );
  orchs.push(orch);
  return orch;
}

afterEach(async () => {
  for (const o of orchs.splice(0)) await o.killServe();
  for (const f of spawned.splice(0)) await f.stop();
});

describe("Orchestrator.start", () => {
  test("无 serve 时 spawn 自己的子进程 → own", async () => {
    const port = await getFreePort();
    const orch = makeOrch(port);
    expect(await orch.start()).toBe("own");
    expect(await probeHealth(port, 2000)).toBe(true);
    expect(orch.getEffectivePort()).toBe(port);
    expect(orch.getRecentLogs().join("\n")).not.toBeNull();
  });

  test("已有 token 匹配的 serve → attached，killServe 不杀它", async () => {
    const port = await getFreePort();
    const fake = await startFakeGbrain({ mode: "healthy", token: TOKEN, port });
    spawned.push(fake);
    const orch = makeOrch(port);
    expect(await orch.start()).toBe("attached");
    await orch.killServe();
    expect(orch.getState()).toBe("stopped");
    expect(await probeHealth(port, 1000)).toBe(true); // fake 仍活着
    await fake.stop();
  });

  test("端口上有 token 不匹配的 serve → foreign", async () => {
    const port = await getFreePort();
    const fake = await startFakeGbrain({ mode: "foreign", token: "other", port });
    spawned.push(fake);
    const orch = makeOrch(port);
    expect(await orch.start()).toBe("foreign");
  });

  test("子进程秒退 → error，日志有退出码", async () => {
    const port = await getFreePort();
    const orch = new Orchestrator(
      { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 },
      { spawnSpec: { bin: process.execPath, baseArgs: [FIXTURE] }, healthTimeoutMs: 8000, pollIntervalMs: 100, spawnEnvExtra: { FAKE_MODE: "crash" } },
    );
    orchs.push(orch);
    expect(await orch.start()).toBe("error");
    expect(orch.getRecentLogs().join("\n")).toMatch(/code=1|exited/);
  });

  test("健康超时（hang 模式）→ error", async () => {
    const port = await getFreePort();
    const orch = new Orchestrator(
      { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 },
      { spawnSpec: { bin: process.execPath, baseArgs: [FIXTURE] }, healthTimeoutMs: 1500, pollIntervalMs: 100, spawnEnvExtra: { FAKE_MODE: "hang" } },
    );
    orchs.push(orch);
    expect(await orch.start()).toBe("error");
  });
});

describe("killServe", () => {
  test("own 模式杀掉整棵进程树并置 stopped", async () => {
    const port = await getFreePort();
    const orch = makeOrch(port);
    await orch.start();
    await orch.killServe();
    expect(orch.getState()).toBe("stopped");
    await new Promise(r => setTimeout(r, 300));
    expect(await probeHealth(port, 500)).toBe(false);
  });
});

describe("spawnOnFallbackPort", () => {
  test("foreign 时在 gbrainPort+1 起自己的 serve", async () => {
    const foreignPort = await getFreePort();
    const fake = await startFakeGbrain({ mode: "foreign", token: "other", port: foreignPort });
    spawned.push(fake);
    const orch = makeOrch(foreignPort);
    await orch.start();
    expect(await orch.spawnOnFallbackPort()).toBe("own");
    expect(orch.getEffectivePort()).toBeGreaterThan(foreignPort);
    expect(orch.getEffectivePort()).toBeLessThanOrEqual(foreignPort + 5);
  });
});
```

（测试引入了 `spawnEnvExtra` 可选项——实现里要支持。）

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/orchestrator.test.ts`
Expected: FAIL（cannot find module `../src/orchestrator`）

- [ ] **Step 3: 实现 orchestrator.ts**

```ts
// server/src/orchestrator.ts
import type { PanelConfig } from "./config";
import { probeHealth } from "./health";
import { adminLoginRequest } from "./gbrain-client";

export type OrchState = "idle" | "probing" | "spawning" | "starting" | "own" | "attached" | "foreign" | "stopped" | "error";

export interface OrchestratorOpts {
  spawnSpec?: { bin: string; baseArgs: string[] };
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnEnvExtra?: Record<string, string>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Orchestrator {
  private proc: Bun.Subprocess | null = null;
  private state: OrchState = "idle";
  private effectivePort: number;
  private logs: string[] = [];
  private listeners = new Set<(s: OrchState) => void>();
  private readonly spawnSpec: { bin: string; baseArgs: string[] };
  private readonly healthTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private cfg: PanelConfig, opts: OrchestratorOpts = {}) {
    this.spawnSpec = opts.spawnSpec ?? { bin: cfg.gbrainBin, baseArgs: [] };
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.effectivePort = cfg.gbrainPort;
  }

  getState(): OrchState { return this.state; }
  getEffectivePort(): number { return this.effectivePort; }
  getRecentLogs(): string[] { return [...this.logs]; }
  onStateChange(cb: (s: OrchState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(s: OrchState, log?: string) {
    this.state = s;
    if (log) this.log(log);
    for (const cb of this.listeners) cb(s);
  }
  private log(line: string) {
    this.logs.push(`[${new Date().toISOString()}] ${line}`);
    if (this.logs.length > 200) this.logs.shift();
  }

  async start(): Promise<OrchState> {
    this.setState("probing");
    if (await probeHealth(this.cfg.gbrainPort, 2000)) {
      const ok = (await adminLoginRequest(this.cfg.gbrainPort, this.cfg.bootstrapToken)) !== null;
      this.setState(ok ? "attached" : "foreign");
      return this.state;
    }
    return this.spawnAt(this.cfg.gbrainPort);
  }

  async spawnOnFallbackPort(): Promise<OrchState> {
    if (this.state !== "foreign" && this.state !== "error") {
      this.log(`spawnOnFallbackPort 拒绝：当前状态 ${this.state}`);
      return this.state;
    }
    for (let p = this.cfg.gbrainPort + 1; p <= this.cfg.gbrainPort + 5; p++) {
      if (await probeHealth(p, 500)) continue;
      const result = await this.spawnAt(p);
      if (result === "own") return result;
    }
    this.setState("error", "fallback 端口全部失败");
    return this.state;
  }

  private async spawnAt(port: number): Promise<OrchState> {
    this.setState("spawning", `spawn serve @${port}`);
    this.effectivePort = port;
    const args = [...this.spawnSpec.baseArgs, "serve", "--http", "--surface", "full",
      "--port", String(port), "--suppress-bootstrap-token"];
    this.proc = Bun.spawn([this.spawnSpec.bin, ...args], {
      env: {
        ...process.env,
        ...(this.spawnSpecExtraEnv() ?? {}),
        GBRAIN_HOME: this.cfg.gbrainHome,
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: this.cfg.bootstrapToken,
      },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
      windowsHide: true,
    });
    this.pipeLogs(this.proc.stdout, "out");
    this.pipeLogs(this.proc.stderr, "err");
    this.proc.exited.then(code => {
      if (this.state === "starting" || this.state === "own") {
        this.setState("error", `serve 意外退出 code=${code}`);
      } else if (this.state !== "stopped") {
        this.setState("stopped", `serve 退出 code=${code}`);
      }
    });
    this.setState("starting");
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (await probeHealth(port, 1000)) { this.setState("own", `serve 就绪 @${port}`); return "own"; }
      if (this.proc.exitCode !== null) break; // 已退出
      await sleep(this.pollIntervalMs);
    }
    if (this.state !== "own") this.setState("error", "健康等待超时");
    return this.state;
  }

  private spawnSpecExtraEnv(): Record<string, string> | undefined {
    // 测试注入 fake-gbrain 模式用；生产为 undefined
    return (this as unknown as { opts?: { spawnEnvExtra?: Record<string, string> } }).opts?.spawnEnvExtra;
  }

  private pipeLogs(stream: ReadableStream<Uint8Array> | null, tag: string) {
    if (!stream) return;
    (async () => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split(/\r?\n/)) {
          if (line.trim()) this.log(`[serve/${tag}] ${line}`);
        }
      }
    })().catch(() => {});
  }

  async killServe(): Promise<void> {
    if (!this.proc) { this.setState("stopped"); return; } // attached/foreign：绝不杀别人的进程
    const pid = this.proc.pid;
    this.log(`taskkill /PID ${pid} /T /F`);
    await new Promise<void>(res => {
      Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true }).exited.then(() => res());
    });
    this.proc = null;
    this.setState("stopped", "serve 已停止");
  }
}
```

实现注意：`spawnSpecExtraEnv` 里读 `this.opts` 的写法别扭——直接把构造参数 opts 存为私有字段 `private opts: OrchestratorOpts`，`spawnAt` 里 `...(this.opts.spawnEnvExtra ?? {})`。写代码时按这个来（测试传 `spawnEnvExtra: { FAKE_MODE: "crash" }` 即生效，因为 fake-gbrain 读环境变量 FAKE_MODE）。

- [ ] **Step 4: 运行确认通过**

Run: `bun test server/test/orchestrator.test.ts`
Expected: 7 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/orchestrator.ts server/test/orchestrator.test.ts
git commit -m "feat: orchestrator（spawn/attach/foreign/fallback/整树退出状态机）"
```

---

### Task 6: 陈旧锁检测

**Files:**
- Create: `server/src/stale-lock.ts`
- Test: `server/test/stale-lock.test.ts`

**Interfaces:**
- Consumes: `cfg.gbrainHome`（锁目录 = `<gbrainHome>/.gbrain/.gbrain-lock`，gbrain 源码 src/core/pglite-lock.ts）。
- Produces: `readLockStatus(gbrainHome: string, now?: number): { present: boolean; stale: boolean; lockDir: string }`；`clearStaleLock(gbrainHome: string): boolean`（仅 stale 时删除锁目录并返回 true）。判 stale 规则：目录内所有文件最新 mtime 距 now 超过 90s（心跳 30s × 3 容忍），不依赖具体文件名。

- [ ] **Step 1: 写失败测试**

```ts
// server/test/stale-lock.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { readLockStatus, clearStaleLock } from "../src/stale-lock";

const TMP = join(import.meta.dir, ".tmp");
let home: string;
beforeEach(() => { home = mkdtempSync(join(TMP, "lock-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function makeLock(ageSec: number) {
  const lockDir = join(home, ".gbrain", ".gbrain-lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), "{}");
  const t = new Date(Date.now() - ageSec * 1000);
  utimesSync(join(lockDir, "owner.json"), t, t);
  return lockDir;
}

describe("readLockStatus", () => {
  test("无锁目录 → present:false", () => {
    const s = readLockStatus(home);
    expect(s.present).toBe(false);
    expect(s.stale).toBe(false);
  });
  test("新鲜心跳（10s 前）→ present 且非 stale", () => {
    makeLock(10);
    const s = readLockStatus(home);
    expect(s.present).toBe(true);
    expect(s.stale).toBe(false);
  });
  test("心跳超龄（120s 前）→ stale", () => {
    makeLock(120);
    expect(readLockStatus(home).stale).toBe(true);
  });
});

describe("clearStaleLock", () => {
  test("stale 时删除并返回 true", () => {
    const lockDir = makeLock(120);
    expect(clearStaleLock(home)).toBe(true);
    const { existsSync } = require("node:fs");
    expect(existsSync(lockDir)).toBe(false);
  });
  test("新鲜锁拒绝删除返回 false", () => {
    makeLock(5);
    expect(clearStaleLock(home)).toBe(false);
    const { existsSync } = require("node:fs");
    expect(existsSync(join(home, ".gbrain", ".gbrain-lock"))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/stale-lock.test.ts`
Expected: FAIL（cannot find module）

- [ ] **Step 3: 实现 stale-lock.ts**

```ts
// server/src/stale-lock.ts
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LockStatus { present: boolean; stale: boolean; lockDir: string }

// gbrain 心跳 30s 一次（src/core/pglite-lock.ts）；容忍 3 个周期
const STALE_AFTER_MS = 90_000;

export function readLockStatus(gbrainHome: string, now = Date.now()): LockStatus {
  const lockDir = join(gbrainHome, ".gbrain", ".gbrain-lock");
  if (!existsSync(lockDir)) return { present: false, stale: false, lockDir };
  let newest = 0;
  for (const f of readdirSync(lockDir)) {
    const st = statSync(join(lockDir, f));
    newest = Math.max(newest, st.mtimeMs);
  }
  return { present: true, stale: now - newest > STALE_AFTER_MS, lockDir };
}

export function clearStaleLock(gbrainHome: string): boolean {
  const s = readLockStatus(gbrainHome);
  if (s.present && s.stale) {
    rmSync(s.lockDir, { recursive: true, force: true });
    return true;
  }
  return false;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test server/test/stale-lock.test.ts`
Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/stale-lock.ts server/test/stale-lock.test.ts
git commit -m "feat: 陈旧锁检测与保守清理（90s 心跳超龄判定）"
```

---

### Task 7: Hono 应用、路由与入口装配

**Files:**
- Create: `server/src/app.ts`、`server/src/index.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: `PanelConfig`、`Orchestrator`、`GbrainClient`、`readLockStatus`（前置任务）。
- Produces:
  - `createApp(deps: { cfg: PanelConfig; orch: Orchestrator; client: GbrainClient }): Hono`，路由：
    - `GET /api/status` → `{ state, effectivePort, panelPort, logs }`
    - `GET /api/stats` → 代理 `/admin/api/stats`（失败 502 `{error}`）
    - `GET /api/health-indicators` → 代理同上
    - `GET /api/stale-lock` → `{ present, stale, lockDir }`
    - `POST /api/spawn-fallback` → 触发 `orch.spawnOnFallbackPort()`
    - `GET /api/*` 之外的 GET → 静态托管 `web/dist`（存在时），无 dist 返回提示文本
  - `server/src/index.ts`：loadConfig → Orchestrator.start → GbrainClient(orch.getEffectivePort()) → Bun.serve(127.0.0.1:panelPort) → SIGINT/SIGTERM 时 killServe 再退出。

- [ ] **Step 1: 写失败测试**

```ts
// server/test/app.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { Orchestrator } from "../src/orchestrator";
import { GbrainClient } from "../src/gbrain-client";
import { startFakeGbrain, getFreePort, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const handles: FakeGbrainHandle[] = [];
const panels: ReturnType<typeof Bun.serve>[] = [];

async function bootPanelWithFake(fakeMode: "healthy" | "foreign" = "healthy") {
  const fake = await startFakeGbrain({ mode: fakeMode, token: TOKEN });
  handles.push(fake);
  const cfg = { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: fake.port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 };
  const orch = new Orchestrator(cfg, { spawnSpec: { bin: "unused", baseArgs: [] } });
  await orch.start();
  const client = new GbrainClient(orch.getEffectivePort(), TOKEN);
  const app = createApp({ cfg, orch, client });
  const panelPort = await getFreePort();
  const server = Bun.serve({ port: panelPort, hostname: "127.0.0.1", fetch: app.fetch });
  panels.push(server);
  return { panelPort, fake };
}

afterEach(async () => {
  for (const s of panels.splice(0)) s.stop(true);
  for (const h of handles.splice(0)) await h.stop();
});

describe("panel API（attached 模式）", () => {
  test("/api/status 反映 attached 与端口", async () => {
    const { panelPort, fake } = await bootPanelWithFake("healthy");
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state).toBe("attached");
    expect(json.effectivePort).toBe(fake.port);
  });

  test("/api/stats 代理 fake 的 admin 接口", async () => {
    const { panelPort } = await bootPanelWithFake("healthy");
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(await res.json()).toEqual({ pages: 42, facts: 100, sources: 3 });
  });

  test("下游死掉时 /api/stats 返回 502 + error", async () => {
    const { panelPort, fake } = await bootPanelWithFake("healthy");
    await fake.stop();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBeTruthy();
  });

  test("/api/stale-lock 无锁时 present:false", async () => {
    const { panelPort } = await bootPanelWithFake("healthy");
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/stale-lock`)).json();
    expect(json.present).toBe(false);
  });
});
```

注意：`/api/stale-lock` 用的 gbrainHome 是空字符串——`readLockStatus("")` 会查 `/.gbrain/.gbrain-lock`（不存在），返回 present:false，测试可过；实现时 home 取 `cfg.gbrainHome`。

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/app.test.ts`
Expected: FAIL（cannot find module `../src/app`）

- [ ] **Step 3: 实现 app.ts 与 index.ts**

```ts
// server/src/app.ts
import { Hono } from "hono";
import { join } from "node:path";
import type { PanelConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { GbrainClient } from "./gbrain-client";
import { readLockStatus } from "./stale-lock";

export function createApp(deps: { cfg: PanelConfig; orch: Orchestrator; client: GbrainClient }) {
  const { cfg, orch, client } = deps;
  const app = new Hono();

  app.get("/api/status", c =>
    c.json({ state: orch.getState(), effectivePort: orch.getEffectivePort(), panelPort: cfg.panelPort, logs: orch.getRecentLogs().slice(-30) }));

  app.get("/api/stats", async c => {
    try { return c.json(await client.adminGet("/admin/api/stats")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/api/health-indicators", async c => {
    try { return c.json(await client.adminGet("/admin/api/health-indicators")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/api/stale-lock", c => c.json(readLockStatus(cfg.gbrainHome)));

  app.post("/api/spawn-fallback", async c => {
    const state = await orch.spawnOnFallbackPort();
    return c.json({ state, effectivePort: orch.getEffectivePort() });
  });

  // 静态托管 web/dist（SPA 回退）；无 dist 时给出可读提示
  const distRoot = join(import.meta.dir, "..", "..", "web", "dist");
  app.all("*", async c => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "");
    const file = Bun.file(join(distRoot, rel));
    if (await file.exists()) return new Response(file);
    const index = Bun.file(join(distRoot, "index.html"));
    if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    return c.text("web/dist 未构建：请在 web/ 目录执行 bun run build（由用户手动执行）", 200);
  });

  return app;
}
```

```ts
// server/src/index.ts
import { join } from "node:path";
import { loadConfig } from "./config";
import { Orchestrator } from "./orchestrator";
import { GbrainClient } from "./gbrain-client";
import { createApp } from "./app";

const cfgPath = process.env.GBRAIN_PANEL_CONFIG ?? join(import.meta.dir, "..", "..", "config.json");
const cfg = loadConfig(cfgPath);
const orch = new Orchestrator(cfg);

const state = await orch.start();
console.log(`[panel] gbrain 状态: ${state} (port ${orch.getEffectivePort()})`);
if (state === "error") {
  console.error("[panel] serve 启动失败，最近日志：\n" + orch.getRecentLogs().slice(-20).join("\n"));
  console.error("[panel] 面板仍将启动，可在界面上查看日志并重试。");
}

const client = new GbrainClient(orch.getEffectivePort(), cfg.bootstrapToken);
const app = createApp({ cfg, orch, client });

const server = Bun.serve({ port: cfg.panelPort, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`[panel] http://127.0.0.1:${server.port}`);

const shutdown = async () => {
  console.log("[panel] 退出：停止 gbrain serve …");
  await orch.killServe();
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test server/test/app.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/test/app.test.ts
git commit -m "feat: Hono 应用（status/stats/health/stale-lock/fallback）与入口装配"
```

---

### Task 8: Vue 前端骨架 + 仪表盘

**Files:**
- Create: `web/index.html`、`web/vite.config.ts`、`web/src/main.ts`、`web/src/App.vue`、`web/src/router.ts`、`web/src/api/client.ts`、`web/src/stores/connection.ts`、`web/src/views/Dashboard.vue`、`web/src/views/ComingSoon.vue`

**Interfaces:**
- Consumes: Task 7 的 `/api/status`、`/api/stats`、`/api/health-indicators`。
- Produces: 可构建的前端骨架；`api<T>(path, init?)` fetch 封装与 `useConnection` pinia store（M2+ 复用）。

本任务无单测（规格 §8：前端手动验收）。**构建由用户执行**——代码写完后提交，验收步骤见 Task 9。

- [ ] **Step 1: 写基础文件（index.html / vite.config.ts / main.ts / router.ts）**

```html
<!-- web/index.html -->
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>gbrain 面板</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

```ts
// web/vite.config.ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: { proxy: { "/api": "http://127.0.0.1:7070" } },
});
```

```ts
// web/src/main.ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";

createApp(App).use(createPinia()).use(router).mount("#app");
```

```ts
// web/src/router.ts
import { createRouter, createWebHashHistory } from "vue-router";

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "dashboard", component: () => import("./views/Dashboard.vue") },
    { path: "/:rest(.*)", name: "coming", component: () => import("./views/ComingSoon.vue") },
  ],
});
```

- [ ] **Step 2: 写 api 客户端与连接 store**

```ts
// web/src/api/client.ts
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}
```

```ts
// web/src/stores/connection.ts
import { defineStore } from "pinia";
import { api } from "../api/client";

export interface PanelStatus { state: string; effectivePort: number; panelPort: number; logs: string[] }

export const useConnection = defineStore("connection", {
  state: () => ({
    online: false,
    status: null as PanelStatus | null,
  }),
  actions: {
    async refresh() {
      try {
        this.status = await api<PanelStatus>("/status");
        this.online = true;
      } catch {
        this.online = false;
      }
    },
  },
});
```

- [ ] **Step 3: 写 App.vue（布局 + 断线遮罩）与两个视图**

```vue
<!-- web/src/App.vue -->
<script setup lang="ts">
import { onMounted, onUnmounted, computed } from "vue";
import { NTag } from "naive-ui";
import { useConnection } from "./stores/connection";

const conn = useConnection();
let timer: number | undefined;
onMounted(() => {
  conn.refresh();
  timer = window.setInterval(() => conn.refresh(), 5000);
});
onUnmounted(() => clearInterval(timer));

const stateType = computed(() => {
  const s = conn.status?.state ?? "unknown";
  return s === "own" || s === "attached" ? "success" : s === "foreign" || s === "error" ? "error" : "warning";
});

const nav = [
  { to: "/", label: "仪表盘" },
  { to: "/m2", label: "内容管理（M2）", disabled: true },
  { to: "/m3", label: "图谱 · 时间线 · 回收站（M3）", disabled: true },
  { to: "/m4", label: "运维 · 维护（M4）", disabled: true },
];
</script>

<template>
  <div class="shell">
    <aside class="sider">
      <h1 class="logo">gbrain 面板</h1>
      <nav>
        <template v-for="item in nav" :key="item.to">
          <RouterLink v-if="!item.disabled" :to="item.to" class="nav-item">{{ item.label }}</RouterLink>
          <span v-else class="nav-item disabled">{{ item.label }}</span>
        </template>
      </nav>
    </aside>
    <main class="main">
      <header class="topbar">
        <NTag :type="stateType" size="small">
          gbrain: {{ conn.status?.state ?? "…" }} :{{ conn.status?.effectivePort ?? "?" }}
        </NTag>
      </header>
      <RouterView />
      <div v-if="!conn.online" class="overlay">
        <div class="overlay-card">
          <h2>面板服务不可达</h2>
          <p>后端可能已退出。请重新启动面板（bun run dev:server 或 bun run server/src/index.ts）。</p>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell { display: flex; height: 100vh; }
.sider { width: 230px; border-right: 1px solid #e0e0e6; padding: 16px; }
.logo { font-size: 16px; margin: 0 0 16px; }
.nav-item { display: block; padding: 8px 10px; margin: 2px 0; border-radius: 6px; color: inherit; text-decoration: none; }
.nav-item:hover { background: #f3f3f6; }
.nav-item.disabled { color: #b0b0b8; cursor: not-allowed; }
.main { flex: 1; position: relative; overflow: auto; }
.topbar { padding: 12px 20px; border-bottom: 1px solid #e0e0e6; }
.overlay { position: absolute; inset: 0; background: rgba(255,255,255,.92); display: grid; place-items: center; }
.overlay-card { text-align: center; }
</style>
```

```vue
<!-- web/src/views/Dashboard.vue -->
<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { NCard, NStatistic, NGrid, NGi } from "naive-ui";
import { api } from "../api/client";

const stats = ref<Record<string, unknown> | null>(null);
const health = ref<Record<string, unknown> | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    [stats.value, health.value] = await Promise.all([
      api<Record<string, unknown>>("/stats"),
      api<Record<string, unknown>>("/health-indicators"),
    ]);
  } catch (e) { error.value = String(e); }
});

// stats 真实形状由 discovery 确认；M1 通用渲染：数值做统计卡，其余 JSON 展示
const numericEntries = computed(() =>
  Object.entries(stats.value ?? {}).filter(([, v]) => typeof v === "number"));
const otherEntries = computed(() =>
  Object.entries(stats.value ?? {}).filter(([, v]) => typeof v !== "number"));
</script>

<template>
  <div class="page">
    <h2>仪表盘</h2>
    <p v-if="error" class="error">加载失败：{{ error }}</p>
    <NGrid v-if="numericEntries.length" :cols="4" :x-gap="12" :y-gap="12">
      <NGi v-for="[k, v] in numericEntries" :key="k">
        <NCard size="small"><NStatistic :label="k" :value="v" /></NCard>
      </NGi>
    </NGrid>
    <NCard v-if="otherEntries.length" title="统计（其他字段）" size="small">
      <pre>{{ JSON.stringify(Object.fromEntries(otherEntries), null, 2) }}</pre>
    </NCard>
    <NCard title="健康指标" size="small">
      <pre>{{ health ? JSON.stringify(health, null, 2) : "…" }}</pre>
    </NCard>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.error { color: #d03050; }
</style>
```

```vue
<!-- web/src/views/ComingSoon.vue -->
<template>
  <div style="padding: 40px; color: #888">
    <h2>建设中</h2>
    <p>此功能属于后续里程碑（见设计规格 §7）。</p>
  </div>
</template>
```

- [ ] **Step 4: Commit**

```bash
git add web/
git commit -m "feat: Vue 前端骨架（导航/断线遮罩/仪表盘）"
```

---

### Task 9: discovery 脚本 + README + M1 验收

**Files:**
- Create: `server/scripts/discover.ts`
- Modify: `README.md`（完整化）

**Interfaces:**
- Consumes: `loadConfig`、`Orchestrator`、`GbrainClient`、`probeHealth`（前置任务）。
- Produces: `docs/discovery.json`——真实 serve 的 stats 形状、api-key 响应形状、`tools/list` 全目录（M2 计划的输入）；README 完整使用说明。

- [ ] **Step 1: 写 discover.ts**

```ts
// server/scripts/discover.ts
// 真实链路探测：spawn serve → admin 登录 → 签 key → tools/list → 落盘 docs/discovery.json → 关 serve。
// 注意：若 ZCode 的 stdio gbrain MCP 正持锁，serve 会起不来——先关闭 ZCode（或其 gbrain MCP）再跑本脚本。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Orchestrator } from "../src/orchestrator";
import { GbrainClient } from "../src/gbrain-client";
import { probeHealth } from "../src/health";

async function main() {
  const root = join(import.meta.dir, "..", "..");
  const cfg = loadConfig(process.env.GBRAIN_PANEL_CONFIG ?? join(root, "config.json"));

  if (await probeHealth(cfg.gbrainPort, 1500)) {
    console.error(`端口 ${cfg.gbrainPort} 上已有 serve 在跑。为避免误伤，请先手动处理后再运行本脚本。`);
    process.exit(1);
  }

  const orch = new Orchestrator(cfg);
  const state = await orch.start();
  if (state !== "own") {
    console.error(`serve 未就绪（${state}）：\n${orch.getRecentLogs().slice(-20).join("\n")}`);
    console.error("若报锁冲突：关闭正在使用 gbrain 的 ZCode 会话后重试。");
    process.exit(1);
  }

  try {
    const client = new GbrainClient(orch.getEffectivePort(), cfg.bootstrapToken);
    const stats = await client.adminGet<Record<string, unknown>>("/admin/api/stats");
    const apiKey = await client.issueApiKey("gbrain-panel-discover");
    const tools = await client.mcpRequest<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>("tools/list");

    mkdirSync(join(root, "docs"), { recursive: true });
    const out = {
      generatedAt: new Date().toISOString(),
      statsShape: stats,
      apiKeyShape: { prefix: apiKey.slice(0, 6), length: apiKey.length }, // 不落盘完整 key
      toolCount: tools.tools.length,
      tools: tools.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    };
    writeFileSync(join(root, "docs", "discovery.json"), JSON.stringify(out, null, 2));
    console.log(`docs/discovery.json 已写入，共 ${tools.tools.length} 个工具。M2 计划以此为准。`);
  } finally {
    await orch.killServe();
    console.log("serve 已停止，锁已释放。");
  }
}

main();
```

- [ ] **Step 2: 写完整 README**

```markdown
# gbrain-panel

gbrain 个人知识大脑的可视化操作面板。设计规格：`docs/superpowers/specs/2026-08-26-gbrain-panel-design.md`。

## 架构

面板后端（127.0.0.1:7070，Bun + Hono）spawn `gbrain serve --http --surface full`（127.0.0.1:3131）
作为唯一持锁子进程；admin cookie 会话 + 自签 API key 走 `/mcp`；Vue 3 SPA 由后端静态托管。

## 安装与运行（构建/启动均由用户手动执行）

```bash
bun install                 # 根目录一次即可（workspace）
bun run build:web           # 或 cd web && bun run build，构建前端
bun run server/src/index.ts # 启动面板，随后打开 http://127.0.0.1:7070
```

开发模式（两个终端）：`bun run dev:server` + `cd web && bun run dev`（Vite 代理 /api → 7070）。

## 测试

```bash
bun test
```

## 与 ZCode / CLI 的关系（重要）

- 面板运行期间，gbrain 的 PGLite 锁由面板的 serve 子进程持有：**ZCode 的 stdio gbrain MCP 与
  随手敲的 gbrain CLI 命令在此期间不可用**（属预期）。
- 面板正常退出（Ctrl+C）会整树杀掉 serve 并释放锁，ZCode MCP 随即恢复可用。
- 若面板被强杀留下孤儿 serve/锁：任务管理器结束 gbrain 相关进程，或用面板的
  `/api/stale-lock` 判定后清理（心跳超 90s 视为陈旧）。

## M1 验收清单（手动）

1. `bun run server/src/index.ts` → 控制台出现 `[panel] gbrain 状态: own (port 3131)` 与面板地址。
2. 浏览器打开面板 → 仪表盘显示统计卡片与健康指标（需先构建 web）。
3. Ctrl+C 退出面板 → `gbrain status`（CLI）可正常执行（锁已释放）。
4. ZCode 打开 gbrain MCP 正常（stdio 持锁）→ 启动面板 → 面板状态显示 `foreign` 或按提示
   fallback 换端口，**ZCode 的 serve 不被杀**。
5. `bun run discover`（需先关 ZCode 的 gbrain MCP）→ 生成 `docs/discovery.json`。

## 里程碑

- M1（本计划）：地基——编排、客户端、骨架、仪表盘。
- M2：内容 CRUD（页面库/记忆库/快速记事）。M3：图谱/时间线/回收站。M4：运维/备份/配置。
```

- [ ] **Step 3: 补 root scripts 并提交**

`package.json` scripts 增加 `"build:web": "bun run --cwd web build"`（与 README 命令一致）。

```bash
git add server/scripts/discover.ts README.md package.json
git commit -m "feat: discovery 探测脚本与 README（M1 收尾）"
```

- [ ] **Step 4: 全量回归**

Run: `bun test`
Expected: 全部 PASS（config 3 + health 2 + client 6 + orchestrator 7 + stale-lock 5 + app 4 = 27）。

- [ ] **Step 5: 用户手动验收**

把 README「M1 验收清单」5 条交给用户逐条执行；其中第 5 条 discovery 的输出
`docs/discovery.json` 是编写 M2 计划的直接输入。

```bash
git add docs/discovery.json
git commit -m "docs: M1 discovery 产物（真实 op 目录与接口形状）"
```

---

## 计划自审记录

- **规格覆盖**：M1 范围（orchestrator/client/仪表盘/README/discovery）全部有任务；规格 §5 错误处理表中 spawn 失败、attach token 不匹配+fallback、崩溃监听、整树清理、陈旧锁均有对应实现与测试；§9.2/§9.5 由 Task 9 discovery 落实。
- **占位符扫描**：无 TBD/TODO；「实现注意」两处是对代码的具体修正说明，非待定项。
- **类型一致性**：`PanelConfig` 字段、`OrchState` 九态、`Orchestrator.getEffectivePort()`、`GbrainClient.adminGet/adminPost/issueApiKey/mcpRequest/mcpCall`、`probeHealth(port, timeoutMs?)`、helpers `startFakeGbrain/getFreePort` 在各任务间引用一致；测试用 PanelConfig 字面量含全部 7 个字段。
