# gbrain 面板 M3（知识图谱 + 时间线）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 知识图谱视图（G6 力导向 + 懒展开 + 实体卡侧栏）、全局时间线（页面流降级）、页面版本历史 tab，外加 M3 待办必修（orchestrator 重入守卫、mcpCall isError 检查、facts 上限提示）与若干一行级修正。

**Architecture:** 图谱数据走新后端路由归一化 `traverse_graph` 的防御式响应；全局时间线无跨页 op（已核实），按规格 §9.6 降级为"页面流"（list_pages sort=updated 按日分组）；server 加固项全部 TDD。fake-gbrain 先行扩展支撑测试。

**Tech Stack:** 沿用 M1/M2；web 新增 `@antv/g6` ^5（力导向图）。

## Global Constraints（与 M1/M2 相同，逐字有效）

- 平台 Windows；所有网络监听仅 127.0.0.1。
- **严禁修改 `D:\gbrain-stock` 内任何文件**；对 gbrain 只做 HTTP 访问。
- **严禁写系统盘临时目录**；测试临时文件统一用 `server/test/.tmp/`。
- `config.json` 保持 gitignore。
- 构建类命令（`vite build`、`bun run dev`、dev server）**由用户手动执行**，执行者不得运行；`bun test`、`bunx tsc --noEmit -p server/tsconfig.json`、`web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json` 允许执行（**禁 bunx vue-tsc**，会拉远端包留系统盘缓存）。
- 提交信息 conventional commits；测试中 spawn 的子进程必须清理。
- 机器 3131 端口可能有用户自己的 gbrain serve，绝不得触碰。
- 工作分支：`m3-graph-timeline`（从 main 切出）。

## 已核实的事实（来自 docs/discovery.json 与 M2 验收，不得偏离）

| op | 参数 | 备注 |
|---|---|---|
| traverse_graph | slug*, depth(默认5,cap10), link_type, direction(enum: in\|out\|both, 默认 out) | 返回 GraphPath[]，**响应体形状未知**→后端防御式归一化 |
| entity | name*（自由文本/别名/slug） | 零 LLM；返回 card{entity{slug,title,type},aka,summary,edges,backlink_count,active_fact_count}；miss 时 {found:false, suggestions} |
| get_versions | slug* | 版本历史列表 |
| list_pages | …sort, updated_after… | sort 值域未实测；"recent"场景官方推荐 list_pages |
| recall | limit **cap 100**、无 offset 参数 | → facts 只能做"上限提示 + 实体过滤"，无法真分页 |

- 无跨页 timeline op（已核实）→ 全局时间线走规格 §9.6 降级方案。
- M2 验收已证 get_page 返回 `{page:{slug,title,content,…}}` 与前端假设吻合；full-stats 正常。

## 文件结构总览

```
server/src/orchestrator.ts           # 改：重入守卫
server/src/gbrain-client.ts          # 改：mcpCall 检查 result.isError
server/src/routes/content.ts         # 改：q+type 映射、NaN 守卫、详情默认含已删、versions 路由
server/src/routes/graph.ts           # 新：graph expand / entity 卡片
server/src/app.ts                    # 改：挂 graph 路由
server/test/fixtures/fake-gbrain.ts  # 改：traverse_graph/entity/get_versions/fail→isError/get_page include_deleted/list sort
server/test/fake-mcp.test.ts         # 改：新增 op 用例
server/test/graph.test.ts            # 新
server/test/content.test.ts          # 改：isError→502、q+type、NaN、versions
server/test/orchestrator.test.ts     # 改：重入守卫用例
web/package.json                     # 改：+@antv/g6 ^5
web/src/views/Graph.vue              # 新：图谱视图
web/src/views/Timeline.vue           # 新：时间线（页面流）
web/src/views/PageDetail.vue         # 改：版本 tab
web/src/views/Facts.vue              # 改：上限提示
web/src/views/Capture.vue            # 改：kind 可选
web/src/router.ts / App.vue          # 改：路由与导航
README.md                            # 改：M3 使用说明与验收清单
```

---

### Task 1: fake-gbrain 扩展（graph/entity/versions + isError + 修正）

**Files:**
- Modify: `server/test/fixtures/fake-gbrain.ts`、`server/test/fake-mcp.test.ts`

**Interfaces:**
- Produces（fake 新行为，后续任务测试依赖）：
  - `fail(msg)` 改为 MCP 规范的工具级失败：`result: { content: [{type:"text",text:JSON.stringify({error:msg})}], isError: true }`（ok() 不变，不带 isError）
  - `get_page` 尊重 include_deleted=false 时不返回已删页（返回 `{found:false}`）——M2 遗留盲区
  - `list_pages` 支持 `sort === "updated"`（按 updatedAt 降序）
  - `traverse_graph`：fake 维护模块级 `links: Array<{from,to,type}>`，种子：`notes/seed-1→people/alice`（note）、`people/alice→notes/seed-2`（note，**新增种子页 notes/seed-2**）。BFS 按 direction（out=from 匹配、in=to 匹配、both=双向）、depth（默认 5）扩展；返回 `{edges:[{source,target,type}], nodes:[{slug,title,type}]}`（edges 去重）
  - `entity`：按 name 匹配 pages 的 slug 或 title（大小写不敏感）；命中返回 `{found:true, card:{entity:{slug,title,type}, aka:[], summary:"fake summary", last_touched:"2026-08-01", open_threads:[], edges:[{type:"note",direction:"out",slug:"notes/seed-2"}], backlink_count:1, active_fact_count:1}}`；未命中 `{found:false, suggestions:[{slug:"people/alice",title:"Alice"}]}`
  - `get_versions`：slug 存在返回 `{versions:[{version:1, created_at:"2026-08-01T00:00:00Z", label:"初始"},{version:2, created_at:"2026-08-20T00:00:00Z", label:"编辑"}]}`；不存在 fail("not found")

- [ ] **Step 1: 写失败测试（追加到 fake-mcp.test.ts 的 describe 内）**

```ts
  test("isError：fail 分支带 isError 标记（经 mcpCall 应抛错——此处直接验外壳）", async () => {
    const { c, h } = await client();
    // 直接发原始 JSON-RPC 看 isError 字段（mcpCall 抛错行为在 Task 2 的 client 层测）
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "delete_page", arguments: { slug: "no/such" } } }),
    });
    const payload = await res.json();
    expect(payload.result.isError).toBe(true);
    expect(JSON.parse(payload.result.content[0].text).error).toBeTruthy();
  });

  test("traverse_graph：out/in/both 三向", async () => {
    const { c } = await client();
    const out = await c.mcpCall<{ edges: { source: string; target: string }[]; nodes: { slug: string }[] }>("traverse_graph", { slug: "people/alice", depth: 1, direction: "out" });
    expect(out.edges.some(e => e.source === "people/alice" && e.target === "notes/seed-2")).toBe(true);
    const inbound = await c.mcpCall<{ edges: { source: string; target: string }[] }>("traverse_graph", { slug: "people/alice", depth: 1, direction: "in" });
    expect(inbound.edges.some(e => e.source === "notes/seed-1" && e.target === "people/alice")).toBe(true);
    const both = await c.mcpCall<{ edges: { source: string; target: string }[] }>("traverse_graph", { slug: "people/alice", depth: 1, direction: "both" });
    expect(both.edges.length).toBe(2);
  });

  test("entity：命中与未命中", async () => {
    const { c } = await client();
    const hit = await c.mcpCall<{ found: boolean; card?: { entity: { slug: string } } }>("entity", { name: "alice" });
    expect(hit.found).toBe(true);
    expect(hit.card?.entity.slug).toBe("people/alice");
    const miss = await c.mcpCall<{ found: boolean; suggestions?: unknown[] }>("entity", { name: "nobody" });
    expect(miss.found).toBe(false);
  });

  test("get_versions", async () => {
    const { c } = await client();
    const v = await c.mcpCall<{ versions: { version: number }[] }>("get_versions", { slug: "notes/seed-1" });
    expect(v.versions.length).toBe(2);
  });

  test("get_page 默认不含已删页；list_pages sort=updated", async () => {
    const { c } = await client();
    const dead = await c.mcpCall<{ found: boolean }>("get_page", { slug: "notes/dead-page" });
    expect(dead.found).toBe(false);
    const withDeleted = await c.mcpCall<{ page?: unknown; found: boolean }>("get_page", { slug: "notes/dead-page", include_deleted: true });
    expect(withDeleted.found).toBe(true);
    const sorted = await c.mcpCall<{ pages: { slug: string }[] }>("list_pages", { sort: "updated", limit: 3, include_deleted: true });
    expect(sorted.pages[0].slug).toBe("notes/seed-2"); // 种子中最新
  });
```

（`notes/seed-2` 种子：`{ slug:"notes/seed-2", title:"种子页二", type:"note", content:"# 二", deletedAt:null, updatedAt:"2026-08-25T00:00:00Z" }`，加进 seed() 并让 seed-1 的 updatedAt 早于它。）

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/fake-mcp.test.ts`
Expected: 新增 5 个 FAIL

- [ ] **Step 3: 实现**

fake-gbrain.ts 改动清单：
1. 模块级加 `const links = [{ from: "notes/seed-1", to: "people/alice", type: "note" }, { from: "people/alice", to: "notes/seed-2", type: "note" }]`；seed() 加 notes/seed-2 并把 seed-1 的 updatedAt 调整为 `"2026-08-20T00:00:00Z"`（已是）、people/alice `"2026-08-21T00:00:00Z"`（已是）——seed-2 的 08-25 最新的排序断言成立。
2. `fail` 改为：
```ts
const fail = (msg: string) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true } });
```
3. `get_page` 分支在 `pages.get(a.slug)` 后加：`if (p && p.deletedAt && !a.include_deleted) return ok({ found: false });`
4. `list_pages` 在过滤后加排序：`if (a.sort === "updated") all.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));`
5. 新增三个 case（switch 内，风格与现有一致）：

```ts
    case "traverse_graph": {
      const direction = a.direction ?? "out";
      const depth = Math.min(a.depth ?? 5, 10);
      const seen = new Set<string>();
      const edges: { source: string; target: string; type: string }[] = [];
      const slugs = new Set<string>([a.slug]);
      let frontier = [a.slug];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const s of frontier) {
          for (const l of links) {
            if (direction === "in" ? l.to === s : direction === "out" ? l.from === s : l.from === s || l.to === s) {
              const edge = { source: l.from, target: l.to, type: l.type };
              const key = `${l.from}->${l.to}`;
              if (!seen.has(key)) { seen.add(key); edges.push(edge); }
              const other = l.from === s ? l.to : l.from;
              if (!slugs.has(other)) { slugs.add(other); next.push(other); }
            }
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }
      const nodes = [...slugs].map(sg => pages.get(sg)).filter(Boolean).map((p: FakePage) => ({ slug: p.slug, title: p.title, type: p.type }));
      return ok({ edges, nodes });
    }
    case "entity": {
      const q = String(a.name ?? "").toLowerCase();
      const hit = [...pages.values()].find(p => p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
      if (!hit) return ok({ found: false, suggestions: [{ slug: "people/alice", title: "Alice" }] });
      return ok({ found: true, card: {
        entity: { slug: hit.slug, title: hit.title, type: hit.type }, aka: [], summary: "fake summary",
        last_touched: hit.updatedAt, open_threads: [],
        edges: [{ type: "note", direction: "out", slug: "notes/seed-2" }], backlink_count: 1, active_fact_count: 1,
      } });
    }
    case "get_versions": {
      const p = pages.get(a.slug);
      if (!p) return fail("not found");
      return ok({ versions: [
        { version: 1, created_at: "2026-08-01T00:00:00Z", label: "初始" },
        { version: 2, created_at: "2026-08-20T00:00:00Z", label: "编辑" },
      ] });
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test`
Expected: 50 PASS（45+5）

- [ ] **Step 5: Commit**

```bash
git add server/test/fixtures/fake-gbrain.ts server/test/fake-mcp.test.ts
git commit -m "test: fake-gbrain 扩展（traverse_graph/entity/get_versions/isError/include_deleted/sort）"
```

---

### Task 2: server 加固（isError / 重入守卫 / q+type / NaN / 详情含已删）

**Files:**
- Modify: `server/src/gbrain-client.ts`、`server/src/orchestrator.ts`、`server/src/routes/content.ts`、`server/test/gbrain-client.test.ts`、`server/test/orchestrator.test.ts`、`server/test/content.test.ts`

**Interfaces:**
- Produces:
  - `mcpCall`：解包后检查 `result.isError === true` → 抛 `Error(\`mcp <op> 工具级错误: <content text 前 300 字>\`)`（rpc 层检查不变）
  - `Orchestrator.start()`/`spawnOnFallbackPort()` 入口守卫：state 为 `starting`/`own` 时直接返回当前状态不重入；`spawnAt` 开头若 `this.proc` 存在且未退出（`exitCode === null && signalCode === null`）先 `await this.killServe()`（自己的子进程，安全）
  - `content.ts`：search 分支映射 `type → types:[type]`；limit/offset 用 NaN 守卫（非有限数或负数回默认）；`GET /pages/:slug` 的 include_deleted **默认改为 true**（详情页要展示已删页并允许恢复；显式 `?include_deleted=false` 可关闭）
  - 新路由 `GET /api/pages/:slug/versions` → get_versions 透传（502 模式同既有）

- [ ] **Step 1: 写失败测试**

gbrain-client.test.ts 的 describe("GbrainClient") 内追加：

```ts
  test("mcpCall 检查工具级 isError 并抛错", async () => {
    responder = (c) => {
      if (c.url.endsWith("/admin/api/api-keys")) return { status: 200, json: { key: "kkk" } };
      if (c.url.endsWith("/mcp")) return { status: 200, json: { jsonrpc: "2.0", id: c.body.id, result: { content: [{ type: "text", text: '{"error":"not found"}' }], isError: true } } };
      return { status: 204, cookie: "s" };
    };
    const client = new GbrainClient(PORT, "tok");
    await expect(client.mcpCall("delete_page", { slug: "x" })).rejects.toThrow(/delete_page 工具级错误.*not found/);
  });
```

orchestrator.test.ts 的 describe("Orchestrator.start") 内追加：

```ts
  test("own 态重入 start() 直接返回 own，不重新 spawn", async () => {
    const port = await getFreePort();
    const orch = makeOrch(port);
    expect(await orch.start()).toBe("own");
    expect(await orch.start()).toBe("own"); // 不变 attached/不重拉
    expect(orch.getEffectivePort()).toBe(port);
    expect(await probeHealth(port, 2000)).toBe(true); // 原进程仍活
  });
```

content.test.ts 追加（新 describe 或并入现有）：

```ts
describe("M3 server 加固", () => {
  test("op 级错误（isError）→ 502 而非 200 假成功", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages/no%2Fsuch%2Fpage`, { method: "DELETE" });
    expect(res.status).toBe(502);
  });

  test("q + type 组合：type 映射进 search types 参数", async () => {
    const { panelPort } = await boot();
    // fake 的 search 不认 types——仅断言不 500 且仍是 search 形状
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages?q=seed&type=note`)).json() as any;
    expect(Array.isArray(json.results)).toBe(true);
  });

  test("limit=abc 回退默认不产生 NaN 下传", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/pages?limit=abc`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(Array.isArray(json.pages)).toBe(true);
  });

  test("详情默认含已删页（可看 deleted_at）", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages/${encodeURIComponent("notes/dead-page")}`)).json() as any;
    expect(json.page.deleted_at).toBeTruthy();
  });

  test("GET /api/pages/:slug/versions 返回版本列表", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/pages/${encodeURIComponent("notes/seed-1")}/versions`)).json() as any;
    expect(json.versions.length).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/gbrain-client.test.ts server/test/orchestrator.test.ts server/test/content.test.ts`
Expected: 新增 7 个测试中 isError×2（client+route）、重入、versions 4 类 FAIL（q+type 与 NaN 可能因现实现碰巧过——若过则核对实现仍按 Step 3 补齐防御）

- [ ] **Step 3: 实现**

gbrain-client.ts 的 `mcpCall`（保持 mcpRequest 不动，在解包处加检查）：

```ts
  async mcpCall<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.mcpRequest<{ content?: { type: string; text?: string }[]; isError?: boolean }>("tools/call", { name: op, arguments: args });
    const text = result?.content?.[0]?.text;
    if (result?.isError) {
      throw new Error(`mcp ${op} 工具级错误: ${typeof text === "string" ? text.slice(0, 300) : JSON.stringify(result.content)}`);
    }
    if (typeof text === "string") {
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    }
    return result as unknown as T;
  }
```

orchestrator.ts：`start()` 第一行（setState("probing") 之前）加：

```ts
    if (this.state === "starting" || this.state === "own") return this.state;
```

`spawnAt(port)` 开头（setState("spawning") 之前）加：

```ts
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.log("spawn 前清理仍存活的上一个子进程");
      await this.killServe();
    }
```

content.ts：
1. 顶部加辅助 `const numOr = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };`，`GET /pages` 的 limit/offset 改用它。
2. search 分支加 types 映射：

```ts
      if (q) return c.json(await client.mcpCall("search", { query: q, limit, offset, ...(includeDeleted ? {} : {}), ...(typeParam ? { types: [typeParam] } : {}) }));
```

（typeFilter 变量从 query 提取后命名 `typeParam`，避免与 list 分支混淆。）
3. `GET /pages/:slug` 的 includeDeleted 默认 true：

```ts
    const includeDeleted = c.req.query("include_deleted") !== "false"; // 默认含已删（详情/恢复需要）
```

4. 新路由（restore 路由之后）：

```ts
  app.get("/pages/:slug/versions", async c => {
    try { return c.json(await client.mcpCall("get_versions", { slug: c.req.param("slug") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`
Expected: 57 PASS（50+7）；tsc 0 错误。**注意**：若既有测试因"详情默认含已删"行为变化而失败（如断言 found:false 的用例），按新契约修测试断言并在提交说明中记录。

- [ ] **Step 5: Commit**

```bash
git add server/src server/test
git commit -m "fix: mcpCall isError/重入守卫/q+type 映射/NaN 守卫/详情默认含已删/versions 路由"
```

---

### Task 3: 后端图谱与实体路由

**Files:**
- Create: `server/src/routes/graph.ts`、`server/test/graph.test.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Consumes: `GbrainClient.mcpCall`（traverse_graph/entity，Task 1 fake 已支持）。
- Produces（挂载 `/api`）：
  - `GET /api/graph/expand?slug&depth=1&direction=both` → 归一化 `{nodes:[{slug,title,type}], edges:[{source,target,type}]}`。实现：调 traverse_graph；响应防御式提取 `res.edges ?? res.paths ?? []`，条目字段取 `source??from`、`target??to`；nodes 取 `res.nodes`（若有）否则从 edges 两端 + get_page 兜底（不额外调用——nodes 缺失时由 slug/title 兜底对象 `[{slug, title: sourceSlug}]`）。slug 必填 400，失败 502。
  - `GET /api/entity/:name` → entity op 透传（name 为 URL 段，前端 encodeURIComponent）。

- [ ] **Step 1: 写失败测试**

```ts
// server/test/graph.test.ts
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

describe("图谱与实体路由", () => {
  test("expand 返回归一化 nodes/edges", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("people/alice")}&depth=1&direction=both`)).json() as any;
    expect(Array.isArray(json.nodes)).toBe(true);
    expect(json.nodes.some((n: { slug: string }) => n.slug === "notes/seed-1")).toBe(true);
    expect(json.edges.some((e: { source: string; target: string }) => e.source === "notes/seed-1" && e.target === "people/alice")).toBe(true);
  });

  test("expand 缺 slug → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand`);
    expect(res.status).toBe(400);
  });

  test("entity 透传 found:true 卡片", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/entity/${encodeURIComponent("people/alice")}`)).json() as any;
    expect(json.found).toBe(true);
    expect(json.card.entity.slug).toBe("people/alice");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test server/test/graph.test.ts`
Expected: FAIL（404）

- [ ] **Step 3: 实现 graph.ts 与挂载**

```ts
// server/src/routes/graph.ts
import { Hono } from "hono";
import type { GbrainClient } from "../gbrain-client";

interface RawEdge { source?: string; from?: string; target?: string; to?: string; type?: string; link_type?: string }

export function graphRoutes(client: GbrainClient) {
  const app = new Hono();

  app.get("/graph/expand", async c => {
    const slug = c.req.query("slug")?.trim();
    if (!slug) return c.json({ error: "slug 必填" }, 400);
    const depth = Math.min(Number(c.req.query("depth") ?? 1) || 1, 3);
    const direction = (c.req.query("direction") ?? "both") as "in" | "out" | "both";
    try {
      const res = await client.mcpCall<{ edges?: RawEdge[]; paths?: RawEdge[]; nodes?: { slug: string; title?: string; type?: string }[] }>(
        "traverse_graph", { slug, depth, direction });
      const raw = res.edges ?? res.paths ?? [];
      const edges = raw.map(e => ({
        source: e.source ?? e.from ?? "",
        target: e.target ?? e.to ?? "",
        type: e.type ?? e.link_type ?? "link",
      })).filter(e => e.source && e.target);
      const nodes = (res.nodes && res.nodes.length ? res.nodes : edges.flatMap(e => [{ slug: e.source }, { slug: e.target }])
        .filter((n, i, arr) => arr.findIndex(x => x.slug === n.slug) === i))
        .map(n => ({ slug: n.slug, title: (n as { title?: string }).title ?? n.slug, type: (n as { type?: string }).type ?? "" }));
      return c.json({ nodes, edges });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });

  app.get("/entity/:name", async c => {
    try { return c.json(await client.mcpCall("entity", { name: c.req.param("name") })); }
    catch (e) { return c.json({ error: String(e) }, 502); }
  });

  return app;
}
```

app.ts 在 contentRoutes 挂载之后加（import `graphRoutes`）：

```ts
  app.route("/api", graphRoutes(client));
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`
Expected: 60 PASS（57+3）；tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/graph.ts server/src/app.ts server/test/graph.test.ts
git commit -m "feat: 图谱展开与实体卡片路由（traverse_graph 防御式归一化）"
```

---

### Task 4: 前端图谱视图（G6 + 实体卡侧栏）

**Files:**
- Create: `web/src/views/Graph.vue`
- Modify: `web/package.json`（+`@antv/g6` ^5）、`web/src/router.ts`、`web/src/App.vue`

**Interfaces:**
- Consumes: `GET /api/pages?limit=&sort=updated`（种子节点）、`GET /api/graph/expand?slug&depth=1&direction=both`、`GET /api/entity/:name`。
- Produces: `/graph` 路由视图；导航启用「知识图谱」。G6 v5 API——**若实际安装版本 API 与参考代码有出入，以官方文档最小适配，行为契约不变：初始渲染种子节点、点节点取一度邻居合并、点节点显示实体卡**。

无单测；vue-tsc 0 错误；不运行构建。

- [ ] **Step 1: 装依赖并注册路由导航**

web/package.json dependencies 加 `"@antv/g6": "^5.0.0"`，仓库根 `bun install`。

router.ts routes 数组的 `/:rest(.*)` 之前加：

```ts
  { path: "/graph", name: "graph", component: () => import("./views/Graph.vue") },
  { path: "/timeline", name: "timeline", component: () => import("./views/Timeline.vue") },
```

（Timeline.vue 由 Task 5 创建——本任务先建最小占位 `<template><div style="padding:40px;color:#888">建设中</div></template>`，Task 5 替换。）

App.vue nav 数组改为：

```ts
const nav = [
  { to: "/", label: "仪表盘" },
  { to: "/pages", label: "页面库" },
  { to: "/facts", label: "记忆库" },
  { to: "/capture", label: "快速记事" },
  { to: "/graph", label: "知识图谱" },
  { to: "/timeline", label: "时间线（M3）", disabled: true },
  { to: "/m4", label: "运维 · 维护（M4）", disabled: true },
];
```

- [ ] **Step 2: 写 Graph.vue**

```vue
<!-- web/src/views/Graph.vue -->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { NInput, NButton, NCard, NTag, NSpin, useMessage } from "naive-ui";
import { Graph } from "@antv/g6";
import { api } from "../api/client";

interface GNode { id: string; label: string; nodeType: string }
interface GEdge { source: string; target: string; type: string }
interface EntityCard { found?: boolean; card?: { entity?: { slug?: string; title?: string; type?: string }; aka?: string[]; summary?: string; edges?: { type?: string; direction?: string; slug?: string }[]; backlink_count?: number; active_fact_count?: number }; suggestions?: { slug?: string; title?: string }[] }

const router = useRouter();
const message = useMessage();
const container = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const filterType = ref("");
const card = ref<EntityCard | null>(null);
let graph: Graph | null = null;
const nodes = new Map<string, GNode>();
const edges = new Map<string, GEdge>();

function pushNode(id: string, label: string, nodeType: string) {
  if (!nodes.has(id)) nodes.set(id, { id, label, nodeType });
}
function pushEdge(e: GEdge) {
  const key = `${e.source}->${e.target}`;
  if (!edges.has(key)) edges.set(key, e);
}

async function seed() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: "30", sort: "updated" });
    if (filterType.value.trim()) params.set("type", filterType.value.trim());
    const json = await api<{ pages?: { slug?: string; title?: string; type?: string }[] }>(`/pages?${params}`);
    for (const p of json.pages ?? []) {
      if (p.slug) pushNode(p.slug, p.title ?? p.slug, p.type ?? "");
    }
    await redraw();
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function expand(slug: string) {
  loading.value = true;
  try {
    const json = await api<{ nodes?: { slug?: string; title?: string; type?: string }[]; edges?: { source: string; target: string; type?: string }[] }>(
      `/graph/expand?slug=${encodeURIComponent(slug)}&depth=1&direction=both`);
    for (const n of json.nodes ?? []) if (n.slug) pushNode(n.slug, n.title ?? n.slug, n.type ?? "");
    for (const e of json.edges ?? []) { pushNode(e.source, e.source, ""); pushNode(e.target, e.target, ""); pushEdge({ source: e.source, target: e.target, type: e.type ?? "link" }); }
    await redraw();
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function showCard(slug: string) {
  try {
    card.value = await api<EntityCard>(`/entity/${encodeURIComponent(slug)}`);
    await expand(slug); // 点节点即懒展开一度邻居
  } catch (e) { message.error(String(e)); }
}

async function redraw() {
  const data = {
    nodes: [...nodes.values()].map(n => ({ id: n.id, data: { label: n.label, nodeType: n.nodeType } })),
    edges: [...edges.values()].map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  };
  if (!graph && container.value) {
    graph = new Graph({
      container: container.value,
      autoFit: "view",
      data,
      node: { style: { size: 36, labelText: (d: { data?: { label?: string } }) => d.data?.label ?? d.id } },
      edge: { style: { endArrow: true } },
      layout: { type: "force", linkDistance: 130 },
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
    });
    graph.on("node:click", (evt: { target: { id: string } }) => { void showCard(evt.target.id); });
    graph.on("node:dblclick", (evt: { target: { id: string } }) => { router.push(`/pages/${encodeURIComponent(evt.target.id)}`); });
    await graph.render();
  } else if (graph) {
    await graph.setData(data);
    await graph.render();
  }
}

onMounted(seed);
onBeforeUnmount(() => { graph?.destroy(); graph = null; });
</script>

<template>
  <div class="page">
    <h2>知识图谱</h2>
    <div class="toolbar">
      <NInput v-model:value="filterType" placeholder="种子类型过滤（如 note）" clearable style="width: 200px" @keyup.enter="seed" />
      <NButton size="small" @click="nodes.clear(); edges.clear(); card = null; seed()">重置</NButton>
      <span class="muted">单击节点：展开一度邻居 + 实体卡；双击：进详情。节点 {{ nodes.size }} / 边 {{ edges.size }}</span>
    </div>
    <div class="body">
      <div class="canvas-wrap">
        <NSpin :show="loading"><div ref="container" class="canvas"></div></NSpin>
      </div>
      <NCard v-if="card" class="side" :title="card.card?.entity?.slug ?? '实体'" size="small">
        <template v-if="card.found && card.card">
          <p><NTag size="small">{{ card.card.entity?.type ?? "?" }}</NTag> {{ card.card.entity?.title }}</p>
          <p class="muted">{{ card.card.summary ?? "（无摘要）" }}</p>
          <p class="muted">反链 {{ card.card.backlink_count ?? 0 }} · 活跃事实 {{ card.card.active_fact_count ?? 0 }}</p>
          <div v-if="card.card.edges?.length">
            <p class="muted">关联：</p>
            <p v-for="(e, i) in card.card.edges.slice(0, 10)" :key="i" class="muted">
              [{{ e.direction }}/{{e.type}}] {{ e.slug }}
            </p>
          </div>
        </template>
        <template v-else>
          <p class="muted">未找到实体。建议：</p>
          <p v-for="(s, i) in card.suggestions?.slice(0, 5)" :key="i" class="muted">{{ s.slug }} — {{ s.title }}</p>
        </template>
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.muted { color: #888; font-size: 12px; }
.body { display: flex; gap: 12px; }
.canvas-wrap { flex: 1; min-width: 0; }
.canvas { height: 560px; border: 1px solid #e0e0e6; border-radius: 6px; }
.side { width: 280px; flex-shrink: 0; }
</style>
```

- [ ] **Step 3: 类型检查**

Run: `web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`
Expected: 0 错误（G6 类型缺失时按编译器提示最小收窄，方法同前两次先例：类型谓词或 as，留注释）

- [ ] **Step 4: Commit**

```bash
git add web/src web/package.json bun.lock
git commit -m "feat: 知识图谱视图（G6 力导向/懒展开/实体卡侧栏）"
```

---

### Task 5: 前端时间线 + 版本 tab + facts 上限提示 + capture kind

**Files:**
- Create: `web/src/views/Timeline.vue`（替换占位）
- Modify: `web/src/views/PageDetail.vue`、`web/src/views/Facts.vue`、`web/src/views/Capture.vue`、`web/src/App.vue`

**Interfaces:**
- Consumes: `GET /api/pages?limit=100&sort=updated`（时间线数据源）、`GET /api/pages/:slug/versions`（Task 2）。
- Produces: `/timeline` 视图（页面流按日分组）；PageDetail 第 5 个 tab「版本」；Facts 上限提示；Capture kind 下拉；导航启用时间线。

- [ ] **Step 1: 写 Timeline.vue**

```vue
<!-- web/src/views/Timeline.vue -->
<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NInput, NButton, NSpin, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Row { slug?: string; title?: string; type?: string; updated_at?: string }

const router = useRouter();
const message = useMessage();
const rows = ref<Row[]>([]);
const typeFilter = ref("");
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: "100", sort: "updated" });
    if (typeFilter.value.trim()) params.set("type", typeFilter.value.trim());
    const json = await api<{ pages?: Row[] }>(`/pages?${params}`);
    rows.value = json.pages ?? [];
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

// gbrain 无跨页 timeline op（规格 §9.6）：按更新日分组的"近期页面流"
const byDay = computed(() => {
  const groups = new Map<string, Row[]>();
  for (const r of rows.value) {
    const day = (r.updated_at ?? "").slice(0, 10) || "未知日期";
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(r);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
});

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>时间线（近期页面流）</h2>
    <p class="muted">gbrain 暂无跨页时间线接口，本视图按最后更新日期归组展示最近 100 个页面。</p>
    <div class="toolbar">
      <NInput v-model:value="typeFilter" placeholder="类型过滤" clearable style="width: 180px" @keyup.enter="load" />
      <NButton size="small" @click="load">查询</NButton>
    </div>
    <NSpin :show="loading">
      <div v-for="[day, items] in byDay" :key="day" class="day">
        <h3>{{ day }}</h3>
        <div v-for="r in items" :key="r.slug" class="item" @click="r.slug && router.push(`/pages/${encodeURIComponent(r.slug)}`)">
          <span class="time">{{ (r.updated_at ?? "").slice(11, 19) }}</span>
          <span class="title">{{ r.title ?? r.slug }}</span>
          <span class="muted">{{ r.type }} · {{ r.slug }}</span>
        </div>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.muted { color: #888; font-size: 12px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.day { margin-bottom: 16px; }
.item { padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
.item:hover { background: #f3f3f6; }
.time { font-family: Consolas, monospace; color: #888; font-size: 12px; }
.title { font-weight: 500; }
</style>
```

- [ ] **Step 2: PageDetail 版本 tab、Facts 上限提示、Capture kind、导航**

PageDetail.vue：script 加版本状态与加载（load 成功后并行拉，失败静默为 null）：

```ts
const versions = ref<{ versions?: unknown[] } | null>(null);
// load() 内 data.value 赋值后追加：
    versions.value = await api<{ versions?: unknown[] }>(`/pages/${encodeURIComponent(slug)}/versions`).catch(() => null);
```

模板 NTabs 内（timeline tab 之后）加：

```vue
      <NTabPane name="versions" tab="版本">
        <pre>{{ versions ? JSON.stringify(versions, null, 2) : "不可用" }}</pre>
      </NTabPane>
```

Facts.vue：`load()` 的 `finally` 前加截断提示逻辑：

```ts
    if (facts.value.length >= 100) message.warning("已达 gbrain recall 上限 100 条，请用实体过滤缩小范围", { duration: 5000 });
```

（放在 try 内赋值之后；`facts.value.length >= 100` 即触达 cap。）

Capture.vue：script 补 `const newKind = ref<string | null>(null);` 与 kindOptions（从 Facts.vue 复制五项数组）；bar 区 entity 输入后加：

```vue
        <NSelect v-model:value="newKind" :options="kindOptions" placeholder="类型（可选）" clearable style="width: 200px" />
```

submit 的 body 加 `...(newKind.value ? { kind: newKind.value } : {})`（成功后不清 newKind，保留便捷）。

App.vue nav 的 timeline 项改 `{ to: "/timeline", label: "时间线" }`（去掉 disabled）。

- [ ] **Step 3: 类型检查**

Run: `web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: 时间线视图/版本 tab/facts 上限提示/capture 类型"
```

---

### Task 6: README + M3 收尾

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 更新**

「里程碑」节之前插入：

```markdown
## M3 使用说明（图谱与时间线）

- **知识图谱**：以最近更新的 30 个页面为种子；单击节点展开一度邻居并显示实体卡片
  （摘要/反链数/活跃事实/关联边）；双击节点进页面详情；可按类型过滤种子、重置画布。
- **时间线**：gbrain 无跨页时间线接口，本视图按最后更新日期归组展示最近 100 个页面（降级方案）。
- **版本历史**：页面详情新增「版本」tab（get_versions 透传，只列不 diff）。
- 记忆库触达 recall 上限（100 条）时会提示改用实体过滤；快速记事支持类型选择。

### M3 验收清单（手动，需先 build:web 并启动面板）

1. 图谱页初始出现节点；单击一个节点 → 画布长出一度邻居 + 右侧实体卡（真实 entity op 的
   card 形状首次实测——若字段名与假设不符，侧栏降级为"未找到/建议"或 JSON 兜底属预期，记录即可）。
2. 图谱里 traverse_graph 的真实返回形状若与归一化假设不符（edges/paths、source/from），
   节点/边会缺失——记录实际形状以便 M4 修正归一化层。
3. 双击节点跳详情正常。
4. 时间线按日分组显示，点击条目进详情。
5. 详情页「版本」tab 显示真实版本列表（形状首次实测，JSON 展示即可）。
6. 记忆库在不过滤实体时能看到上限提示（若真实库不足 100 条则不出现，属预期）。
```

- [ ] **Step 2: 全量回归**

Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json && web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`
Expected: 60 PASS；双 tsc 0 错误

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: M3 使用说明与验收清单"
```

- [ ] **Step 4: 用户手动验收**

README「M3 验收清单」6 条交用户执行（先 `bun run build:web`）。第 1/2/5 条是真实形状首轮实测
（entity card / traverse_graph 响应 / get_versions），结果反馈后小版本修正。

---

## 计划自审记录

- **规格覆盖**：spec §3 图谱（G6 力导向/懒展开/实体卡/过滤/深度限制——深度由后端 cap 3 控制）→ Task 3/4；时间线（§9.6 降级方案）→ Task 5；版本历史（§10 只列不 diff）→ Task 2/5；M3 待办 #1→Task 2、#2→Task 2、#8 cap 提示→Task 5、#3/#4→Task 2、#5→Task 1、#7 恢复按钮死 UI→Task 2（后端默认含已删，前端 deleted() 自然激活）+验收确认、#9 capture kind→Task 5。#6 chunk 列/tag 过滤 UI 与 #10 YAML 留 M4（backlog 不变）。
- **占位符扫描**：无 TBD；Timeline.vue 占位是显式临时交付物（Task 5 替换）；G6 API 版本出入的处理指令是明确契约而非占位。
- **类型一致性**：graphRoutes(client) 与 contentRoutes 同签名挂载；fake traverse_graph 返回 {edges,nodes} 与 Task 3 归一化输入、Task 4 前端消费一致；entity 卡字段与 Graph.vue 侧栏渲染字段一致；versions 路由（Task 2 定义、Task 5 消费）路径 `/api/pages/:slug/versions` 一致。
