# gbrain 面板 M2（内容 CRUD）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 页面库（列表/搜索/详情/编辑/软删/恢复/回收站）+ 记忆库（facts 增查遗忘）+ 快速记事，外加 M1 遗留加固（fallback 端口跟随等 6 项）。

**Architecture:** 面板后端新增 content 路由层，全部经 `GbrainClient.mcpCall` 透传给 serve 的 `/mcp`（真实 op 签名已由 `docs/discovery.json` 核实）；fake-gbrain 的 /mcp 从 echo 升级为按 op 名分发的内存实现，支撑全链路测试；前端新增 4 个视图。

**Tech Stack:** 沿用 M1：Bun + Hono；Vue 3 + Naive UI + Pinia；新增 web 依赖 `markdown-it`（页面正文渲染）。

## Global Constraints（与 M1 相同，逐字有效）

- 平台 Windows；所有网络监听仅 127.0.0.1。
- **严禁修改 `D:\gbrain-stock` 内任何文件**；对 gbrain 只做 HTTP 访问。
- **严禁写系统盘临时目录**；测试临时文件统一用 `server/test/.tmp/`。
- `config.json` 含 bootstrap token，必须保持 gitignore。
- 构建类命令（`vite build`、`bun run dev`、dev server）**由用户手动执行**，执行者不得运行；`bun test`、`bunx tsc --noEmit`、`vue-tsc --noEmit` 允许执行。
- 提交信息 conventional commits；测试中 spawn 的子进程必须清理。
- 机器 3131 端口可能有用户自己的 gbrain serve 在跑，测试全用 `getFreePort()` 随机端口，任何情况下不得触碰 3131 上的进程。
- 工作分支：`m2-content`（从 main 切出）。

## 已核实的事实（来自 docs/discovery.json，实现时不得偏离）

**op 签名（`*`=必填）：**

| op | 参数 |
|---|---|
| list_pages | type, tag, limit, offset, updated_after, sort, include_deleted, source_id |
| get_page | slug*, fuzzy, include_content, include_deleted, source_id |
| put_page | slug*, content*, allow_empty, source_kind, source_uri, ingested_via |
| delete_page | slug*, source_id |
| restore_page | slug*, source_id |
| search | query*, limit, offset, mode, types, snippet_chars, source_id, salience, recency |
| get_links | slug* |
| get_timeline | slug*, after, before, since, until, limit |
| recall | entity, query, budget_tokens, since, session_id, include_expired, supersessions, limit, grep, include_pending |
| remember | fact*, provenance*, ttl, entity, kind, visibility |
| forget | id*, reason |

**其他核实结论：**
- **purge 类 op 不存在** → 回收站只做恢复，不做彻底清除（spec §9.1 预案生效）。
- admin `/admin/api/stats` 返回的是连接统计（connected_agents/active_tokens/active_api_keys/requests_today），**不含内容计数** → 内容统计走 `/admin/api/full-stats`（存在性已在 M1 源码勘察确认，形状实现期看）。
- API key 签发字段兼容（key|api_key|token 之一命中，值 71 位、前缀 gbrain）。
- **真实 op 的返回体形状未经实测**（discovery 只有目录与入参 schema）→ 后端路由一律透传；**前端字段访问全部可选链 + 未知字段 JSON 兜底渲染**，M2 手动验收时按真实数据修正展示。

## 文件结构总览

```
server/src/routes/content.ts          # 新：内容路由（pages/facts）
server/src/app.ts                     # 改：挂 content 路由、/api/full-stats
server/src/gbrain-client.ts           # 改：端口 getter、签 key 根因透出
server/src/orchestrator.ts            # 改：killServe 死 PID 守卫、pipeLogs 类型修正
server/src/index.ts                   # 改：SIGBREAK、shutdown once 守卫、client 端口跟随
server/test/fixtures/fake-gbrain.ts   # 改：/mcp 按名分发（内存 pages/facts）
server/test/fake-mcp.test.ts          # 新
server/test/content.test.ts           # 新
server/test/helpers.ts                # 改：bootPanelWithFake 提取共用
server/test/app.test.ts               # 改：改用共用 helper
server/test/gbrain-client.test.ts     # 改：新增行为测试 + tsc 修复
README.md                             # 改：fallback 说明、M2 验收清单
web/package.json                      # 改：+markdown-it
web/src/views/Pages.vue               # 新：页面库+回收站
web/src/views/PageDetail.vue          # 新：详情+编辑
web/src/views/Facts.vue               # 新：记忆库
web/src/views/Capture.vue             # 新：快速记事
web/src/router.ts / App.vue           # 改：路由与导航
web/src/views/Dashboard.vue           # 改：内容统计卡
```

---

### Task 1: fake-gbrain /mcp 分发器（内存数据）

**Files:**
- Modify: `server/test/fixtures/fake-gbrain.ts`
- Test: `server/test/fake-mcp.test.ts`（新建）

**Interfaces:**
- Consumes: `GbrainClient.mcpCall(op, args)`（M1 已有）、`startFakeGbrain`（helpers）。
- Produces: fake 的 `/mcp` 支持按 `params.name` 分发下列 op，返回与真实 MCP 一致的外壳 `{jsonrpc,id,result:{content:[{type:"text",text:JSON.stringify(数据)}]}}`：
  - `list_pages` → `{pages:[{slug,title,type,updated_at,deleted_at}], total}`（过滤 type/include_deleted，offset/limit 分页，默认种子 3 页其中 1 页已软删）
  - `get_page` → `{page:{slug,title,type,content,updated_at,deleted_at}}`（include_content=false 时不带 content；未找到返回 `{found:false}`）
  - `put_page` → upsert（content 以 `---` 开头时解析 frontmatter 的 title/tags），返回 `{slug,status:"upserted"}`
  - `delete_page` → 置 deleted_at，返回 `{slug,deleted:true}`；不存在 → rpc error（result 里 `{isError:true}` 或抛 rpc error 均可，fake 用 `{error:"not found"}` 放 content）
  - `restore_page` → 清 deleted_at，返回 `{slug,restored:true}`
  - `search` → `{results:[{slug,title,chunk}], total}`（slug/title 子串匹配）
  - `get_links` → `{links:[{type:"note",direction:"out",slug:"seed-link"}]}`
  - `get_timeline` → `{entries:[{date:"2026-08-01",summary:"seed entry"}]}`
  - `recall` → `{facts:[{fact_id,entity_slug,fact,kind,visibility,expired}], total}`（entity 过滤、include_expired，种子 2 条）
  - `remember` → 新增 fact（expired=false, fact_id=递增字符串），返回 `{id,status:"inserted",entity_slug}`
  - `forget` → 置 expired=true，返回 `{id,expired:true,reason}`；未知 id 返回错误内容
- 状态是模块级内存（fake 进程生命周期内一致），种子数据在启动时写入。

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/fake-mcp.test.ts`
Expected: FAIL（put/list 等仍走 echo 分支，断言不匹配）

- [ ] **Step 3: 实现分发器（替换 fake-gbrain.ts 的 /mcp 分支）**

```ts
// fake-gbrain.ts 顶部（模式判断之前）加内存状态：
interface FakePage { slug: string; title: string; type: string; content: string; deletedAt: string | null; updatedAt: string }
interface FakeFact { factId: string; entity: string; fact: string; kind: string; visibility: string; expired: boolean }
const pages = new Map<string, FakePage>();
const facts = new Map<string, FakeFact>();
let factSeq = 0;
function seed(): void {
  pages.set("notes/seed-1", { slug: "notes/seed-1", title: "种子页一", type: "note", content: "# 种子页一\n\n内容", deletedAt: null, updatedAt: "2026-08-20T00:00:00Z" });
  pages.set("people/alice", { slug: "people/alice", title: "Alice", type: "person", content: "# Alice", deletedAt: null, updatedAt: "2026-08-21T00:00:00Z" });
  pages.set("notes/dead-page", { slug: "notes/dead-page", title: "已删页", type: "note", content: "x", deletedAt: "2026-08-22T00:00:00Z", updatedAt: "2026-08-22T00:00:00Z" });
  facts.set("1", { factId: "1", entity: "people/alice", fact: "Alice 喜欢咖啡", kind: "preference", visibility: "world", expired: false });
  facts.set("2", { factId: "2", entity: "people/alice", fact: "旧事实", kind: "event", visibility: "private", expired: true });
}
seed();

function parseFrontmatter(content: string): { title?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const fm = content.slice(3, end);
  const m = /^title:\s*(.+)$/m.exec(fm);
  return { title: m?.[1]?.trim() };
}

// /mcp 分支替换为：
if (url.pathname === "/mcp" && req.method === "POST") {
  const body = await req.json();
  const name = body?.params?.name as string;
  const a = (body?.params?.arguments ?? {}) as Record<string, any>;
  const ok = (data: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
  const fail = (msg: string) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: msg }) }] } });
  switch (name) {
    case "list_pages": {
      const all = [...pages.values()].filter(p => (a.include_deleted ? true : !p.deletedAt) && (!a.type || p.type === a.type));
      const offset = a.offset ?? 0, limit = a.limit ?? 50;
      ok({ pages: all.slice(offset, offset + limit).map(p => ({ slug: p.slug, title: p.title, type: p.type, updated_at: p.updatedAt, deleted_at: p.deletedAt })), total: all.length });
      break;
    }
    case "get_page": {
      const p = pages.get(a.slug);
      if (!p) { ok({ found: false }); break; }
      ok({ page: { slug: p.slug, title: p.title, type: p.type, ...(a.include_content ? { content: p.content } : {}), updated_at: p.updatedAt, deleted_at: p.deletedAt } });
      break;
    }
    case "put_page": {
      const existing = pages.get(a.slug);
      const title = parseFrontmatter(a.content ?? "").title ?? existing?.title ?? a.slug;
      pages.set(a.slug, { slug: a.slug, title, type: existing?.type ?? "note", content: a.content ?? "", deletedAt: existing?.deletedAt ?? null, updatedAt: new Date().toISOString() });
      ok({ slug: a.slug, status: "upserted" });
      break;
    }
    case "delete_page": {
      const p = pages.get(a.slug);
      if (!p) { fail("not found"); break; }
      p.deletedAt = new Date().toISOString();
      ok({ slug: a.slug, deleted: true });
      break;
    }
    case "restore_page": {
      const p = pages.get(a.slug);
      if (!p) { fail("not found"); break; }
      p.deletedAt = null;
      ok({ slug: a.slug, restored: true });
      break;
    }
    case "search": {
      const q = String(a.query ?? "").toLowerCase();
      const hits = [...pages.values()].filter(p => !p.deletedAt && (p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)));
      const offset = a.offset ?? 0, limit = a.limit ?? 50;
      ok({ results: hits.slice(offset, offset + limit).map(p => ({ slug: p.slug, title: p.title, chunk: p.content.slice(0, 80) })), total: hits.length });
      break;
    }
    case "get_links": ok({ links: [{ type: "note", direction: "out", slug: "seed-link" }] }); break;
    case "get_timeline": ok({ entries: [{ date: "2026-08-01", summary: "seed entry" }] }); break;
    case "recall": {
      const all = [...facts.values()].filter(f => (a.include_expired ? true : !f.expired) && (!a.entity || f.entity === a.entity));
      const limit = a.limit ?? 100;
      ok({ facts: all.slice(0, limit).map(f => ({ fact_id: f.factId, entity_slug: f.entity, fact: f.fact, kind: f.kind, visibility: f.visibility, expired: f.expired })), total: all.length });
      break;
    }
    case "remember": {
      const id = String(++factSeq + 100);
      facts.set(id, { factId: id, entity: a.entity ?? "unknown", fact: a.fact ?? "", kind: a.kind ?? "fact", visibility: a.visibility ?? "world", expired: false });
      ok({ id, status: "inserted", entity_slug: a.entity ?? "unknown" });
      break;
    }
    case "forget": {
      const f = facts.get(String(a.id));
      if (!f) { fail("not_found"); break; }
      f.expired = true;
      ok({ id: String(a.id), expired: true, reason: a.reason ?? "" });
      break;
    }
    default: fail(`unknown op ${name}`);
  }
  break; // switch 后需要结束 fetch；实际代码里用 return ok(...)/return fail(...) 形式，避免 break 落空
}
```

实现注意：上面 switch 示意用 `ok(...)`/`fail(...)` 后接 `break`，落地时改成 `return ok(...)` / `return fail(...)` 直接返回（Bun.serve fetch 支持 return Response）。

- [ ] **Step 4: 运行确认通过**

Run: `bun test server/test/fake-mcp.test.ts && bun test`
Expected: 新增 3 PASS；全量 32 PASS（29+3）

- [ ] **Step 5: Commit**

```bash
git add server/test/fixtures/fake-gbrain.ts server/test/fake-mcp.test.ts
git commit -m "test: fake-gbrain /mcp 按名分发（内存 pages/facts）"
```

---

### Task 2: M1 遗留加固（M2 待办 #1/#2/#3/#5/#6/#8）

**Files:**
- Modify: `server/src/gbrain-client.ts`、`server/src/orchestrator.ts`、`server/src/index.ts`、`server/test/gbrain-client.test.ts`、`server/test/orchestrator.test.ts`、`README.md`

**Interfaces:**
- Consumes: M1 各模块现有接口。
- Produces:
  - `GbrainClient` 构造函数第一参数变为 `number | (() => number)`（端口 getter，fallback 切端口后自动跟随；数字用法不变，现有测试零改动通过）。
  - `mcpRequest` 在匿名 401/403 时把签 key 的真实失败原因附进错误消息（根因透出）。
  - `Orchestrator.killServe` 对已自行退出的子进程跳过 taskkill（日志含 `无需 taskkill`）。
  - `index.ts`：shutdown 加 once 守卫 + 注册 SIGBREAK；client 用 `() => orch.getEffectivePort()` 构造。
  - tsc 全仓 0 错误（修 orchestrator.ts ×2 与 gbrain-client.test.ts ×5 遗留）。
  - README 增加 fallback 适用前提说明。

- [ ] **Step 1: 写失败测试（gbrain-client 端口 getter + 根因透出）**

在 `server/test/gbrain-client.test.ts` 的 `describe("GbrainClient")` 内追加：

```ts
  test("端口 getter：函数形式动态取端口", async () => {
    let port = 1111;
    responder = (c) => c.url.includes(":1111") || c.url.includes(":2222")
      ? { status: 200, json: { ok: true } } : { status: 404 };
    const client = new GbrainClient(() => port, "tok");
    expect(await client.adminGet("/admin/api/stats")).toEqual({ ok: true });
    port = 2222;
    expect(await client.adminGet("/admin/api/stats")).toEqual({ ok: true });
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
```

在 `server/test/orchestrator.test.ts` 的 `describe("killServe")` 内追加：

```ts
  test("子进程已自行退出时 killServe 跳过 taskkill", async () => {
    const port = await getFreePort();
    const orch = new Orchestrator(
      { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 },
      { spawnSpec: { bin: process.execPath, baseArgs: [FIXTURE] }, healthTimeoutMs: 8000, pollIntervalMs: 100, spawnEnvExtra: { FAKE_MODE: "crash" } },
    );
    orchs.push(orch);
    await orch.start(); // → error（子进程已退）
    await orch.killServe();
    expect(orch.getState()).toBe("stopped");
    expect(orch.getRecentLogs().join("\n")).toMatch(/无需 taskkill/);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/gbrain-client.test.ts server/test/orchestrator.test.ts`
Expected: 新增 3 个测试 FAIL（getter 不支持 / 根因不透出 / 无"无需 taskkill"日志）

- [ ] **Step 3: 实现**

`gbrain-client.ts`：

```ts
export class GbrainClient {
  private cookie: string | null = null;
  private apiKey: string | null = null;
  private readonly portRef: number | (() => number);

  constructor(port: number | (() => number), private bootstrapToken: string) {
    this.portRef = port;
  }

  private get port(): number { return typeof this.portRef === "function" ? this.portRef() : this.portRef; }
  private base() { return `http://127.0.0.1:${this.port}`; }
  // 其余方法里所有 this.port 原私有字段引用改为 this.port（getter）……
```

`mcpRequest` 改为（保持原匿名容忍行为，仅透出根因）：

```ts
  async mcpRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    let issuanceError: unknown = null;
    if (!this.apiKey) {
      try { this.apiKey = await this.issueApiKey("gbrain-panel"); }
      catch (e) { issuanceError = e; }
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
    // ……SSE/JSON 解析与 rpc error 部分保持原样
```

`orchestrator.ts` 的 `killServe` 开头加守卫：

```ts
  async killServe(): Promise<void> {
    if (!this.proc) { this.setState("stopped"); return; }
    if (this.proc.exitCode !== null) {
      this.log(`serve 已自行退出（code=${this.proc.exitCode}），无需 taskkill`);
      this.proc = null;
      this.setState("stopped");
      return;
    }
    // ……原 taskkill 逻辑不变
```

`index.ts`：

```ts
const orch = new Orchestrator(cfg);
let server: ReturnType<typeof Bun.serve> | undefined;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) { console.log("[panel] 已在退出流程中，忽略重复信号"); return; }
  shuttingDown = true;
  console.log("[panel] 退出：停止 gbrain serve …");
  try { await orch.killServe(); } catch (e) { console.error("[panel] killServe 异常:", e); }
  finally { server?.stop(); process.exit(0); }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGBREAK", shutdown);

const state = await orch.start();
// ……（原日志/错误分支不变）
const client = new GbrainClient(() => orch.getEffectivePort(), cfg.bootstrapToken);
const app = createApp({ cfg, orch, client });
server = Bun.serve({ port: cfg.panelPort, hostname: "127.0.0.1", fetch: app.fetch });
```

tsc 修复：运行 `bunx tsc --noEmit -p server/tsconfig.json`，逐个修完全部错误（orchestrator.ts 的 pipeLogs 参数类型用 `Bun.Subprocess["stdout"]` 收窄；gbrain-client.test.ts 的 mock 类型按编译器提示加 `as` 收窄）。修复不得改变运行时行为——改完 `bun test` 全绿为准。

README 在「与 ZCode / CLI 的关系」节末尾追加：

```markdown
- fallback（面板换 3132+ 自建 serve）仅适用于「3131 被占但 PGLite 锁空闲」的场景；若锁被
  ZCode 的 stdio MCP 或其他进程持有，新端口上的 serve 也会因锁冲突启动失败（表现：面板 error
  态 + 日志含锁冲突信息），此时请先释放锁再启动面板。
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`
Expected: 32 PASS（29+3）；tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src server/test README.md
git commit -m "fix: M1 遗留加固（端口跟随/根因透出/死PID守卫/SIGBREAK/tsc清零）"
```

---

### Task 3: 后端内容路由

**Files:**
- Create: `server/src/routes/content.ts`、`server/test/content.test.ts`
- Modify: `server/src/app.ts`、`server/test/helpers.ts`、`server/test/app.test.ts`

**Interfaces:**
- Consumes: `GbrainClient.mcpCall`（Task 1 的 fake 分发器做测试后端）、`createApp`。
- Produces:
  - `contentRoutes(client: GbrainClient): Hono`，挂载于 `/api`：
    - `GET /api/pages?q&limit&offset&include_deleted&type&tag&sort&updated_after`（q 有值走 search，否则 list_pages）
    - `GET /api/pages/:slug?include_deleted`（并行 get_page + get_links + get_timeline，后两者失败降级为 `{links:[]}`/`{entries:[]}`）
    - `PUT /api/pages/:slug` body `{content}`（必填校验 400）→ put_page
    - `DELETE /api/pages/:slug` → delete_page；`POST /api/pages/:slug/restore` → restore_page
    - `GET /api/facts?entity&include_expired&limit&grep` → recall；`POST /api/facts` body `{fact, entity?, kind?, visibility?}`（fact 必填 400）→ remember（provenance 固定 "panel"）
    - `POST /api/facts/:id/forget` body `{reason}`（必填 400）→ forget
    - 全部失败路径 502 `{error}`
  - helpers.ts 新增 `bootPanelWithFake(mode: "healthy" | "foreign", token: string)`（从 app.test.ts 提取，返回 `{panelPort, fake, cfg, orch, client}`），app.test.ts 改用它（行为不变）。
  - app.ts：`app.route("/api", contentRoutes(client))`（注册在五条 M1 路由之后、catch-all 之前）+ `GET /api/full-stats`（adminGet 透传，失败 502）。

- [ ] **Step 1: 写失败测试**

```ts
// server/test/content.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { bootPanelWithFake } from "./helpers";
import type { FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const panels: { stop: (b?: boolean) => void }[] = [];
const fakes: FakeGbrainHandle[] = [];
const used: { panelPort: number; fake: FakeGbrainHandle }[] = [];

async function boot() {
  const b = await bootPanelWithFake("healthy", TOKEN);
  panels.push(b.server); fakes.push(b.fake); used.push({ panelPort: b.panelPort, fake: b.fake });
  return b;
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
    const detail = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`)).json();
    expect(detail.page.slug).toBe("notes/m2-test");
    expect(detail.page.title).toBe("M2测试");
    expect(Array.isArray(detail.links.links)).toBe(true);
    expect(Array.isArray(detail.timeline.entries)).toBe(true);
    const list = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?limit=50`)).json();
    expect(list.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(true);
  });

  test("PUT 缺 content → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages/x`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });

  test("?q= 走 search", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?q=seed`)).json();
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.results.length).toBeGreaterThan(0);
  });

  test("软删 → 回收站可见 → 恢复", async () => {
    const { panelPort } = await boot();
    await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) });
    await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test`, { method: "DELETE" });
    const alive = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages`)).json();
    expect(alive.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(false);
    const recycled = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?include_deleted=true`)).json();
    expect(recycled.pages.some((p: { slug: string }) => p.slug === "notes/m2-test")).toBe(true);
    const restore = await fetch(`http://127.0.0.1:${panelPort}/api/pages/notes/m2-test/restore`, { method: "POST" });
    expect(restore.status).toBe(200);
    const again = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages`)).json();
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
    })).json();
    expect(created.id).toBeTruthy();
    const list = await (await fetch(`http://127.0.0.1:${panelPort}/api/facts?entity=m2-entity&include_expired=true`)).json();
    expect(list.facts.some((f: { fact_id: string }) => f.fact_id === created.id)).toBe(true);
    const bad = await fetch(`http://127.0.0.1:${panelPort}/api/facts/${created.id}/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    const okRes = await fetch(`http://127.0.0.1:${panelPort}/api/facts/${created.id}/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "清理测试" }) });
    expect(okRes.status).toBe(200);
    const after = await (await fetch(`http://127.0.0.1:${panelPort}/api/facts?entity=m2-entity&include_expired=true`)).json();
    expect(after.facts.find((f: { fact_id: string }) => f.fact_id === created.id).expired).toBe(true);
  });

  test("缺 fact → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("/api/full-stats", () => {
  test("透传 admin full-stats（fake 未实现该路径时 502 也可接受——二选一断言）", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/full-stats`);
    expect([200, 502]).toContain(res.status);
  });
});
```

helpers.ts 新增（从 app.test.ts 原函数改造，多返回 server/引用）：

```ts
import { Orchestrator } from "../src/orchestrator";
import { GbrainClient } from "../src/gbrain-client";
import { createApp } from "../src/app";
import type { PanelConfig } from "../src/config";

export async function bootPanelWithFake(mode: "healthy" | "foreign", token: string) {
  const fake = await startFakeGbrain({ mode, token });
  const cfg: PanelConfig = { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: fake.port, bootstrapToken: token, backupDir: "", backupRetention: 5 };
  const orch = new Orchestrator(cfg, { spawnSpec: { bin: "unused", baseArgs: [] } });
  await orch.start();
  const client = new GbrainClient(orch.getEffectivePort(), token);
  const app = createApp({ cfg, orch, client });
  const panelPort = await getFreePort();
  const server = Bun.serve({ port: panelPort, hostname: "127.0.0.1", fetch: app.fetch });
  return { panelPort, fake, cfg, orch, client, server };
}
```

（app.test.ts 删掉本地 bootPanelWithFake 改 import，afterEach 同步改用返回的 server.stop(true)——行为不变，全量测试仍绿。）

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/content.test.ts`
Expected: FAIL（404：/api/pages 路由不存在）

- [ ] **Step 3: 实现 content.ts 与 app.ts 挂载**

`server/src/routes/content.ts`：

```ts
// server/src/routes/content.ts
import { Hono } from "hono";
import type { GbrainClient } from "../gbrain-client";

export function contentRoutes(client: GbrainClient) {
  const app = new Hono();

  app.get("/pages", async c => {
    const q = c.req.query("q")?.trim();
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const includeDeleted = c.req.query("include_deleted") === "true";
    try {
      if (q) return c.json(await client.mcpCall("search", { query: q, limit, offset }));
      const args: Record<string, unknown> = { limit, offset, include_deleted: includeDeleted };
      for (const k of ["type", "tag", "sort", "updated_after"] as const) {
        const v = c.req.query(k);
        if (v) args[k] = v;
      }
      return c.json(await client.mcpCall("list_pages", args));
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/pages/:slug", async c => {
    const slug = c.req.param("slug");
    const includeDeleted = c.req.query("include_deleted") === "true";
    try {
      const [page, links, timeline] = await Promise.all([
        client.mcpCall("get_page", { slug, include_content: true, include_deleted: includeDeleted }),
        client.mcpCall("get_links", { slug }).catch(() => ({ links: [] })),
        client.mcpCall("get_timeline", { slug, limit: 50 }).catch(() => ({ entries: [] })),
      ]);
      return c.json({ page, links, timeline });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.put("/pages/:slug", async c => {
    const body = await c.req.json().catch(() => null) as { content?: string } | null;
    if (!body || typeof body.content !== "string") return c.json({ error: "body.content 必填" }, 400);
    try { return c.json(await client.mcpCall("put_page", { slug: c.req.param("slug"), content: body.content })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.delete("/pages/:slug", async c => {
    try { return c.json(await client.mcpCall("delete_page", { slug: c.req.param("slug") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.post("/pages/:slug/restore", async c => {
    try { return c.json(await client.mcpCall("restore_page", { slug: c.req.param("slug") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/facts", async c => {
    const args: Record<string, unknown> = {
      include_expired: c.req.query("include_expired") === "true",
      limit: Number(c.req.query("limit") ?? 100),
    };
    const entity = c.req.query("entity");
    if (entity) args.entity = entity;
    const grep = c.req.query("grep");
    if (grep) args.grep = grep;
    try { return c.json(await client.mcpCall("recall", args)); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.post("/facts", async c => {
    const body = await c.req.json().catch(() => null) as { fact?: string; entity?: string; kind?: string; visibility?: string } | null;
    if (!body?.fact?.trim()) return c.json({ error: "body.fact 必填" }, 400);
    try {
      return c.json(await client.mcpCall("remember", {
        fact: body.fact, provenance: "panel",
        ...(body.entity ? { entity: body.entity } : {}),
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.visibility ? { visibility: body.visibility } : {}),
      }));
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.post("/facts/:id/forget", async c => {
    const body = await c.req.json().catch(() => null) as { reason?: string } | null;
    if (!body?.reason?.trim()) return c.json({ error: "body.reason 必填" }, 400);
    try { return c.json(await client.mcpCall("forget", { id: c.req.param("id"), reason: body.reason })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  return app;
}
```

`app.ts` 在 `/api/spawn-fallback` 路由之后加：

```ts
  app.get("/api/full-stats", async c => {
    try { return c.json(await client.adminGet("/admin/api/full-stats")); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.route("/api", contentRoutes(client));
```

（import：`import { contentRoutes } from "./routes/content";`）

- [ ] **Step 4: 运行确认通过**

Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`
Expected: 40 PASS（32+8）；tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/content.ts server/src/app.ts server/test/content.test.ts server/test/helpers.ts server/test/app.test.ts
git commit -m "feat: 内容路由（pages CRUD/搜索/回收站 + facts 增查遗忘）"
```

---

### Task 4: 前端 页面库（含回收站）

**Files:**
- Create: `web/src/views/Pages.vue`
- Modify: `web/src/router.ts`、`web/src/App.vue`、`web/package.json`（+markdown-it，本任务只加依赖不使用）

**Interfaces:**
- Consumes: Task 3 的 `GET /api/pages`（含 q/limit/offset/include_deleted/type）、`DELETE /api/pages/:slug`、`POST /api/pages/:slug/restore`。
- Produces: `/pages` 路由视图；`api` 客户端支持 DELETE/POST（M1 的 api() 已通用支持，直接用）。行数据字段防御规则：`row.slug ?? row.name`、`row.title ?? row.frontmatter?.title`。

本任务无单测（前端手动验收，规格 §8）；`vue-tsc --noEmit` 必须通过。

- [ ] **Step 1: router.ts 与 App.vue 启用页面库**

router.ts 的 routes 数组改为：

```ts
const routes = [
  { path: "/", name: "dashboard", component: () => import("./views/Dashboard.vue") },
  { path: "/pages", name: "pages", component: () => import("./views/Pages.vue") },
  { path: "/pages/:slug", name: "pageDetail", component: () => import("./views/PageDetail.vue") },
  { path: "/facts", name: "facts", component: () => import("./views/Facts.vue") },
  { path: "/capture", name: "capture", component: () => import("./views/Capture.vue") },
  { path: "/:rest(.*)", name: "coming", component: () => import("./views/ComingSoon.vue") },
];
```

（PageDetail/Facts/Capture 由 Task 5/6 创建；本任务先建三个最小占位文件避免懒加载报错——Task 5/6 替换。）

App.vue 的 nav 数组改为：

```ts
const nav = [
  { to: "/", label: "仪表盘" },
  { to: "/pages", label: "页面库" },
  { to: "/facts", label: "记忆库（M2）", disabled: true },
  { to: "/capture", label: "快速记事（M2）", disabled: true },
  { to: "/m3", label: "图谱 · 时间线 · 回收站（M3）", disabled: true },
  { to: "/m4", label: "运维 · 维护（M4）", disabled: true },
];
```

`web/package.json` dependencies 加 `"markdown-it": "^14.0.0"`（Task 5 渲染用，先装好），随后运行 `bun install`（允许，非构建）。

- [ ] **Step 2: 写 Pages.vue**

```vue
<!-- web/src/views/Pages.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NInput, NButton, NDataTable, NTabs, NTabPane, NPopconfirm, useMessage } from "naive-ui";
import { api } from "../api/client";
import { h } from "vue";

interface Row { slug?: string; name?: string; title?: string; frontmatter?: { title?: string }; type?: string; updated_at?: string; deleted_at?: string | null }

const router = useRouter();
const message = useMessage();
const loading = ref(false);
const rows = ref<Row[]>([]);
const total = ref(0);
const query = ref("");
const typeFilter = ref("");
const page = ref(1);          // 1-based
const pageSize = 20;
const recycled = ref<Row[]>([]);

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String((page.value - 1) * pageSize) });
    if (query.value.trim()) params.set("q", query.value.trim());
    if (typeFilter.value.trim()) params.set("type", typeFilter.value.trim());
    const json = await api<{ pages?: Row[]; results?: Row[]; total?: number }>(`/pages?${params}`);
    rows.value = (json.pages ?? json.results ?? []) as Row[];
    total.value = json.total ?? rows.value.length;
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function loadRecycled() {
  try {
    const json = await api<{ pages?: Row[] }>(`/pages?include_deleted=true&limit=100`);
    recycled.value = (json.pages ?? []).filter(r => r.deleted_at);
  } catch (e) { message.error(String(e)); }
}

async function softDelete(slug: string) {
  try { await api(`/pages/${encodeURIComponent(slug)}`, { method: "DELETE" }); message.success(`已软删除 ${slug}`); await Promise.all([load(), loadRecycled()]); }
  catch (e) { message.error(String(e)); }
}

async function restore(slug: string) {
  try { await api(`/pages/${encodeURIComponent(slug)}/restore`, { method: "POST" }); message.success(`已恢复 ${slug}`); await Promise.all([load(), loadRecycled()]); }
  catch (e) { message.error(String(e)); }
}

const columns = [
  { title: "slug", key: "slug", render: (r: Row) => r.slug ?? r.name ?? "(?)" },
  { title: "标题", key: "title", render: (r: Row) => r.title ?? r.frontmatter?.title ?? "" },
  { title: "类型", key: "type", render: (r: Row) => r.type ?? "" },
  { title: "更新", key: "updated_at", render: (r: Row) => (r.updated_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "操作", key: "actions", render: (r: Row) => h("div", { style: "display:flex;gap:8px" }, [
      h(NButton, { size: "tiny", onClick: () => router.push(`/pages/${encodeURIComponent(r.slug ?? r.name ?? "")}`) }, { default: () => "详情" }),
      h(NPopconfirm, { onPositiveClick: () => softDelete(r.slug ?? r.name ?? "") }, { trigger: () => h(NButton, { size: "tiny", type: "warning" }, { default: () => "软删" }), default: () => "确认软删除？（72h 内可恢复）" }),
  ]) },
];

const recycleColumns = [
  { title: "slug", key: "slug", render: (r: Row) => r.slug ?? r.name ?? "(?)" },
  { title: "删除时间", key: "deleted_at", render: (r: Row) => (r.deleted_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "操作", key: "actions", render: (r: Row) => h(NButton, { size: "tiny", onClick: () => restore(r.slug ?? r.name ?? "") }, { default: () => "恢复" }) },
];

onMounted(() => { load(); loadRecycled(); });
</script>

<template>
  <div class="page">
    <h2>页面库</h2>
    <div class="toolbar">
      <NInput v-model:value="query" placeholder="搜索（全文+语义）" clearable style="width: 260px" @keyup.enter="page = 1; load()" />
      <NInput v-model:value="typeFilter" placeholder="类型过滤（如 note）" clearable style="width: 160px" @keyup.enter="page = 1; load()" />
      <NButton size="small" @click="page = 1; load()">查询</NButton>
      <NButton v-if="page > 1" size="small" @click="page--; load()">上一页</NButton>
      <NButton v-if="rows.length === pageSize" size="small" @click="page++; load()">下一页</NButton>
      <span class="muted">共 {{ total }} 条（第 {{ page }} 页）</span>
    </div>
    <NDataTable :columns="columns" :data="rows" :loading="loading" :bordered="false" size="small" />
    <NTabs type="line" style="margin-top: 16px">
      <NTabPane name="recycle" tab="回收站（软删除，仅恢复）">
        <NDataTable :columns="recycleColumns" :data="recycled" :bordered="false" size="small" />
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.muted { color: #888; font-size: 12px; }
</style>
```

注意：App.vue 根组件需要包一层 `n-message-provider` 才能用 `useMessage`——App.vue 模板最外层加：

```vue
<template>
  <n-message-provider>
    <div class="shell">……原内容不变……</div>
  </n-message-provider>
</template>
```

并在 script 中补 import `{ NMessageProvider }`。

三个占位视图（Task 5/6 替换）：

```vue
<!-- web/src/views/PageDetail.vue / Facts.vue / Capture.vue（占位，内容相同） -->
<template><div style="padding: 40px; color: #888">建设中（后续任务）</div></template>
```

- [ ] **Step 3: 类型检查**

Run: `web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`
Expected: 0 错误（bunx vue-tsc 会拉远端包并留系统盘缓存，禁止使用；必须用本地 bin）

- [ ] **Step 4: Commit**

```bash
git add web/src web/package.json bun.lock
git commit -m "feat: 页面库视图（列表/搜索/分页/软删/回收站恢复）"
```

---

### Task 5: 前端 页面详情 + 编辑器

**Files:**
- Create: `web/src/views/PageDetail.vue`（替换占位）
- Create: `web/src/components/MarkdownView.vue`

**Interfaces:**
- Consumes: `GET /api/pages/:slug`（返回 `{page, links, timeline}`）、`PUT /api/pages/:slug`、`DELETE`、`POST restore`。
- Produces: `/pages/:slug` 视图；`MarkdownView.vue`（props: `source: string`，markdown-it 渲染，M3 复用）。

无单测；`vue-tsc --noEmit` 通过。

- [ ] **Step 1: 写 MarkdownView.vue**

```vue
<!-- web/src/components/MarkdownView.vue -->
<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";

const props = defineProps<{ source: string }>();
const md = new MarkdownIt({ html: false, linkify: true });
const html = computed(() => md.render(props.source ?? ""));
</script>

<template>
  <div class="md" v-html="html"></div>
</template>

<style scoped>
.md :deep(h1) { font-size: 1.4em; margin: 0.6em 0 0.3em; }
.md :deep(h2) { font-size: 1.2em; margin: 0.6em 0 0.3em; }
.md :deep(p) { margin: 0.4em 0; }
.md :deep(code) { background: #f3f3f6; padding: 1px 4px; border-radius: 3px; }
.md :deep(pre) { background: #f6f6fa; padding: 10px; border-radius: 6px; overflow: auto; }
</style>
```

（`html:false` 禁原始 HTML，XSS 面收敛；v-html 只喂 markdown-it 输出。）

- [ ] **Step 2: 写 PageDetail.vue**

```vue
<!-- web/src/views/PageDetail.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NTabs, NTabPane, NInput, NPopconfirm, useMessage } from "naive-ui";
import { api } from "../api/client";
import MarkdownView from "../components/MarkdownView.vue";

interface PageData { page: Record<string, unknown>; links: { links?: unknown[] }; timeline: { entries?: unknown[] } }

const route = useRoute();
const router = useRouter();
const message = useMessage();
const slug = decodeURIComponent(String(route.params.slug));

const data = ref<PageData | null>(null);
const error = ref<string | null>(null);
const editing = ref(false);
const editTitle = ref("");
const editTags = ref("");
const editBody = ref("");
const saving = ref(false);

function splitContent(raw: string): { title: string; tags: string; body: string } {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end > 0) {
      const fm = raw.slice(3, end);
      const t = /^title:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? "";
      const tags = /^tags:\s*\[(.*)\]$/m.exec(fm)?.[1]?.trim() ?? "";
      return { title: t, tags, body: raw.slice(end + 4).replace(/^\s+/, "") };
    }
  }
  return { title: "", tags: "", body: raw };
}

function assemble(): string {
  const fm: string[] = [];
  if (editTitle.value.trim()) fm.push(`title: ${editTitle.value.trim()}`);
  if (editTags.value.trim()) fm.push(`tags: [${editTags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(", ")}]`);
  return fm.length ? `---\n${fm.join("\n")}\n---\n\n${editBody.value}` : editBody.value;
}

async function load() {
  error.value = null;
  try {
    data.value = await api<PageData>(`/pages/${encodeURIComponent(slug)}`);
    const p = data.value.page as { content?: string };
    if (typeof p.content === "string") {
      const s = splitContent(p.content);
      editTitle.value = s.title; editTags.value = s.tags; editBody.value = s.body;
    }
  } catch (e) { error.value = String(e); }
}

async function save() {
  saving.value = true;
  try {
    await api(`/pages/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify({ content: assemble() }) });
    message.success("已保存");
    editing.value = false;
    await load();
  } catch (e) { message.error(String(e)); }
  finally { saving.value = false; }
}

async function softDelete() {
  try { await api(`/pages/${encodeURIComponent(slug)}`, { method: "DELETE" }); message.success("已软删除（回收站可恢复）"); router.push("/pages"); }
  catch (e) { message.error(String(e)); }
}

async function restore() {
  try { await api(`/pages/${encodeURIComponent(slug)}/restore`, { method: "POST" }); message.success("已恢复"); await load(); }
  catch (e) { message.error(String(e)); }
}

const content = () => (data.value?.page as { content?: string } | undefined)?.content ?? "";
const deleted = () => Boolean((data.value?.page as { deleted_at?: string | null } | undefined)?.deleted_at);

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>{{ slug }}</h2>
      <div class="actions">
        <NButton size="small" v-if="!editing" @click="editing = true">编辑</NButton>
        <NButton size="small" type="primary" v-if="editing" :loading="saving" @click="save">保存</NButton>
        <NButton size="small" v-if="editing" @click="editing = false">取消</NButton>
        <NButton size="small" v-if="deleted()" type="success" @click="restore">恢复</NButton>
        <NPopconfirm v-if="!deleted()" @positive-click="softDelete">
          <template #trigger><NButton size="small" type="warning">软删除</NButton></template>
          确认软删除？（72h 内可恢复）
        </NPopconfirm>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="editing" class="editor">
      <div class="fm-row">
        <NInput v-model:value="editTitle" placeholder="标题（frontmatter title）" />
        <NInput v-model:value="editTags" placeholder="标签（逗号分隔，frontmatter tags）" />
      </div>
      <textarea v-model="editBody" class="body-editor" placeholder="正文（markdown）"></textarea>
      <p class="muted">保存时按 title/tags 是否填写自动组装 frontmatter；清空即移除对应字段。</p>
    </div>

    <NTabs v-else-if="data" type="line">
      <NTabPane name="content" tab="正文">
        <MarkdownView v-if="content()" :source="content()" />
        <p v-else class="muted">无内容（或真实 get_page 未返回 content 字段——见下方元数据）</p>
      </NTabPane>
      <NTabPane name="meta" tab="元数据">
        <pre>{{ JSON.stringify(data.page, null, 2) }}</pre>
      </NTabPane>
      <NTabPane name="links" tab="关联链接">
        <pre>{{ JSON.stringify(data.links, null, 2) }}</pre>
      </NTabPane>
      <NTabPane name="timeline" tab="时间线">
        <pre>{{ JSON.stringify(data.timeline, null, 2) }}</pre>
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.head { display: flex; justify-content: space-between; align-items: center; }
.actions { display: flex; gap: 8px; }
.error { color: #d03050; }
.fm-row { display: flex; gap: 8px; margin-bottom: 8px; }
.body-editor { width: 100%; min-height: 320px; font-family: Consolas, monospace; border: 1px solid #e0e0e6; border-radius: 6px; padding: 10px; }
.muted { color: #888; font-size: 12px; }
</style>
```

（api 客户端 POST/PUT 已带 content-type，body 直传字符串即可。）

- [ ] **Step 3: 类型检查**

Run: `web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: 页面详情（markdown 渲染/元数据/链接/时间线 + frontmatter 编辑器）"
```

---

### Task 6: 前端 记忆库 + 快速记事

**Files:**
- Create: `web/src/views/Facts.vue`、`web/src/views/Capture.vue`（替换占位）
- Modify: `web/src/App.vue`（导航启用全部 M2 项）

**Interfaces:**
- Consumes: `GET /api/facts`（entity/include_expired）、`POST /api/facts`、`POST /api/facts/:id/forget`。
- Produces: `/facts`、`/capture` 视图；App.vue 导航四项全部启用（内容管理组）。

无单测；`vue-tsc --noEmit` 通过。

- [ ] **Step 1: 写 Facts.vue**

```vue
<!-- web/src/views/Facts.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { NInput, NButton, NDataTable, NCheckbox, NModal, NSelect, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Fact { fact_id?: string; id?: string; entity_slug?: string; entity?: string; fact?: string; kind?: string; visibility?: string; expired?: boolean }

const message = useMessage();
const facts = ref<Fact[]>([]);
const entity = ref("");
const includeExpired = ref(false);
const loading = ref(false);
const showForget = ref(false);
const forgetTarget = ref<Fact | null>(null);
const forgetReason = ref("");

const showNew = ref(false);
const newFact = ref("");
const newEntity = ref("");
const newKind = ref<string | null>(null);
const kindOptions = [
  { label: "event（事件）", value: "event" }, { label: "preference（偏好）", value: "preference" },
  { label: "commitment（承诺）", value: "commitment" }, { label: "belief（信念）", value: "belief" },
  { label: "fact（事实）", value: "fact" },
];

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ include_expired: String(includeExpired.value), limit: "200" });
    if (entity.value.trim()) params.set("entity", entity.value.trim());
    const json = await api<{ facts?: Fact[] }>(`/facts?${params}`);
    facts.value = json.facts ?? [];
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function submitForget() {
  if (!forgetTarget.value || !forgetReason.value.trim()) { message.warning("理由必填"); return; }
  const id = forgetTarget.value.fact_id ?? forgetTarget.value.id ?? "";
  try {
    await api(`/facts/${encodeURIComponent(id)}/forget`, { method: "POST", body: JSON.stringify({ reason: forgetReason.value.trim() }) });
    message.success("已遗忘（过期，审计保留）");
    showForget.value = false; forgetReason.value = "";
    await load();
  } catch (e) { message.error(String(e)); }
}

async function createFact() {
  if (!newFact.value.trim()) { message.warning("内容必填"); return; }
  try {
    await api("/facts", { method: "POST", body: JSON.stringify({ fact: newFact.value.trim(), ...(newEntity.value.trim() ? { entity: newEntity.value.trim() } : {}), ...(newKind.value ? { kind: newKind.value } : {}) }) });
    message.success("已记住");
    newFact.value = ""; showNew.value = false;
    await load();
  } catch (e) { message.error(String(e)); }
}

const columns = [
  { title: "ID", key: "id", render: (f: Fact) => f.fact_id ?? f.id ?? "" },
  { title: "实体", key: "entity", render: (f: Fact) => f.entity_slug ?? f.entity ?? "" },
  { title: "内容", key: "fact", render: (f: Fact) => f.fact ?? "" },
  { title: "类型", key: "kind", render: (f: Fact) => f.kind ?? "" },
  { title: "可见性", key: "visibility", render: (f: Fact) => f.visibility ?? "" },
  { title: "状态", key: "expired", render: (f: Fact) => f.expired ? "已过期" : "生效中" },
  { title: "操作", key: "actions", render: (f: Fact) => (!f.expired ? hForget(f) : "") },
];

import { h } from "vue";
function hForget(f: Fact) {
  return h(NButton, { size: "tiny", type: "warning", onClick: () => { forgetTarget.value = f; showForget.value = true; } }, { default: () => "遗忘" });
}

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>记忆库</h2>
    <div class="toolbar">
      <NInput v-model:value="entity" placeholder="按实体过滤（如 people/alice）" clearable style="width: 260px" @keyup.enter="load" />
      <NCheckbox v-model:checked="includeExpired" @update:checked="load">含已过期（审计视角）</NCheckbox>
      <NButton size="small" @click="load">查询</NButton>
      <NButton size="small" type="primary" @click="showNew = true">新增记忆</NButton>
    </div>
    <NDataTable :columns="columns" :data="facts" :loading="loading" :bordered="false" size="small" />

    <NModal v-model:show="showForget" title="遗忘记忆（需填理由，审计保留）" preset="dialog" positive-text="确认遗忘" negative-text="取消" @positive-click="submitForget">
      <p class="muted">目标：{{ forgetTarget?.fact ?? "" }}</p>
      <NInput v-model:value="forgetReason" placeholder="遗忘理由（必填）" />
    </NModal>

    <NModal v-model:show="showNew" title="新增记忆" preset="dialog" positive-text="记住" negative-text="取消" @positive-click="createFact">
      <NInput v-model:value="newFact" type="textarea" placeholder="记忆内容（必填）" :rows="3" />
      <div style="display:flex; gap:8px; margin-top:8px">
        <NInput v-model:value="newEntity" placeholder="实体（可选，如 people/alice）" />
        <NSelect v-model:value="newKind" :options="kindOptions" placeholder="类型（可选）" clearable style="width: 200px" />
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.muted { color: #888; font-size: 12px; }
</style>
```

- [ ] **Step 2: 写 Capture.vue 并启用导航**

```vue
<!-- web/src/views/Capture.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { NInput, NButton, useMessage } from "naive-ui";
import { api } from "../api/client";

const message = useMessage();
const fact = ref("");
const entity = ref("");
const submitting = ref(false);

async function submit() {
  if (!fact.value.trim()) { message.warning("内容必填"); return; }
  submitting.value = true;
  try {
    await api("/facts", { method: "POST", body: JSON.stringify({ fact: fact.value.trim(), ...(entity.value.trim() ? { entity: entity.value.trim() } : {}) }) });
    message.success("已记住");
    fact.value = "";
  } catch (e) { message.error(String(e)); }
  finally { submitting.value = false; }
}
</script>

<template>
  <div class="page">
    <h2>快速记事</h2>
    <NInput v-model:value="fact" type="textarea" :rows="5" placeholder="想到什么记什么……（Ctrl+Enter 提交）" @keydown.ctrl.enter="submit" />
    <div class="bar">
      <NInput v-model:value="entity" placeholder="归属实体（可选，如 people/alice）" style="width: 280px" />
      <NButton type="primary" :loading="submitting" @click="submit">记住</NButton>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 20px; max-width: 760px; }
.bar { display: flex; gap: 8px; margin-top: 8px; }
</style>
```

App.vue 的 nav 数组改为（M2 全启用）：

```ts
const nav = [
  { to: "/", label: "仪表盘" },
  { to: "/pages", label: "页面库" },
  { to: "/facts", label: "记忆库" },
  { to: "/capture", label: "快速记事" },
  { to: "/m3", label: "图谱 · 时间线 · 回收站（M3）", disabled: true },
  { to: "/m4", label: "运维 · 维护（M4）", disabled: true },
];
```

- [ ] **Step 3: 类型检查**

Run: `web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: 记忆库与快速记事视图（M2 导航全启用）"
```

---

### Task 7: 仪表盘内容统计 + README + M2 收尾

**Files:**
- Modify: `web/src/views/Dashboard.vue`、`README.md`

**Interfaces:**
- Consumes: Task 3 的 `GET /api/full-stats`。
- Produces: 仪表盘新增「内容统计」卡（full-stats 的数值字段，防御式渲染：数值做统计卡、其余 JSON）；README 的 M2 使用说明与验收清单。

- [ ] **Step 1: Dashboard.vue 增加内容统计**

在 Dashboard.vue 的 script 中，`health` 声明后加：

```ts
const fullStats = ref<Record<string, unknown> | null>(null);
```

onMounted 的 Promise.all 改为：

```ts
    const [s, h, f] = await Promise.all([
      api<Record<string, unknown>>("/stats"),
      api<Record<string, unknown>>("/health-indicators"),
      api<Record<string, unknown>>("/full-stats").catch(() => null),
    ]);
    stats.value = s; health.value = h; fullStats.value = f;
```

新增 computed（放在 otherEntries 后）：

```ts
const fullNumeric = computed(() =>
  Object.entries(fullStats.value ?? {}).filter(([, v]) => typeof v === "number"));
const fullOther = computed(() =>
  Object.entries(fullStats.value ?? {}).filter(([, v]) => typeof v !== "number"));
```

模板在「健康指标」卡之前加：

```vue
    <NCard title="内容统计（full-stats）" size="small" style="margin-top: 12px">
      <NGrid v-if="fullNumeric.length" :cols="4" :x-gap="12" :y-gap="12">
        <NGi v-for="[k, v] in fullNumeric" :key="k">
          <NStatistic :label="k" :value="v" />
        </NGi>
      </NGrid>
      <pre v-if="fullOther.length">{{ JSON.stringify(Object.fromEntries(fullOther), null, 2) }}</pre>
      <p v-if="!fullStats" class="muted">full-stats 不可用（502 时隐藏）</p>
    </NCard>
```

（`.muted` 样式类补进 style：`.muted { color: #888; font-size: 12px; }`）

- [ ] **Step 2: README 更新**

README「里程碑」节之前插入：

```markdown
## M2 使用说明（内容管理）

- **页面库**：列表/搜索（全文+语义混合）/类型过滤/分页；详情页看正文（markdown）、元数据、
  关联链接、时间线；编辑器支持 frontmatter（title/tags）+ 正文；软删除后可在回收站恢复。
  （gbrain 无 purge op，M2 不提供彻底清除。）
- **记忆库**：按实体过滤、含已过期（审计视角）；新增记忆（类型/可见性可选）；遗忘必须填理由
  （过期语义，审计保留）。
- **快速记事**：一句话记事，可选归属实体。

### M2 验收清单（手动，需先 build:web 并启动面板）

1. 页面库能看到真实页面列表；搜索框输入关键词出混合检索结果。
2. 点进一个页面：正文 markdown 正常渲染；「元数据」tab 的 JSON 与真实 get_page 形状一致
   ——若正文空白而元数据里有内容字段，说明字段名与前端假设不符，记入 M2 修正。
3. 编辑一个页面（改 title 保存）→ 重新打开确认生效。
4. 软删除一个页面 → 回收站出现 → 恢复 → 列表回归。
5. 快速记事记一条 → 记忆库按实体过滤能看到 → 遗忘（填理由）→ 勾"含已过期"能看到已过期状态。
6. 仪表盘出现「内容统计」卡（若 502 则显示隐藏提示，需核对 full-stats 真实形状）。
```

- [ ] **Step 3: 全量回归**

Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json && web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`
Expected: 40 PASS；server tsc 0 错误；web vue-tsc 0 错误

- [ ] **Step 4: Commit**

```bash
git add web/src/views/Dashboard.vue README.md
git commit -m "feat: 仪表盘内容统计卡与 M2 使用/验收文档"
```

- [ ] **Step 5: 用户手动验收**

把 README「M2 验收清单」6 条交给用户执行（先 `bun run build:web` 再启动面板）。重点回收第 2 条的
**真实 get_page 返回形状核对**——前端字段假设（slug/title/content/deleted_at）如有出入，修 Dashboard/Pages/PageDetail 的字段访问后小版本提交。

---

## 计划自审记录

- **规格覆盖**：spec §3「内容」四项（页面库/详情编辑软删恢复/记忆库/快速记事）→ Task 3/4/5/6；回收站仅恢复（purge 不存在，预案生效）→ Task 4；§7 M2 边界一致。M2 待办 #1→Task 2、#2→Task 2 README、#3→Task 2、#4（重入守卫）**未纳入**——终审判"建议修"，与 M2 内容无耦合，留 M3 前处理（记录于此，防丢失）；#5→Task 2、#6→Task 2、#7 留 M4（key 管理）、#8→Task 2、#10 已由 discovery 完成。
- **占位符扫描**：无 TBD/TODO；Task 4 的三个占位视图是显式的临时交付物，由 Task 5/6 明确替换。
- **类型一致性**：`contentRoutes(client): Hono` 在 Task 3 定义并挂载；`bootPanelWithFake(mode, token)` 返回 `{panelPort, fake, cfg, orch, client, server}` 在 Task 3 定义、content.test.ts 消费；`GbrainClient` 构造签名 `number | (() => number)` 在 Task 2 变更后，Task 3 helpers 传数字（兼容）；前端 api() 调用路径与 Task 3 路由一一对应；fake 分发器返回形状与 Task 1 测试、Task 3 路由断言一致。
