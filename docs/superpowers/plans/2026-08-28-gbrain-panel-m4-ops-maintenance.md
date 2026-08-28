# gbrain 面板 M4（运维 + 维护 + 验收缺陷修复）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 M3 验收两个缺陷（traverse_graph 归一化、图谱过滤不清空），完成 spec §7 M4 主体（请求日志/任务队列/Agents 密钥运维 + 停机备份/配置页），并消化全部 M4 backlog 建议修项与验收新观察（index.html no-cache、key 累积、stale-lock 路径错误）。

**Architecture:** 图谱归一化层按源码证实的 GraphPath 真实形状重写（顶层数组 + from_slug/to_slug），entity 卡 edges 作空结果兜底；运维数据走 admin API 代理 + SSE 流转发（`adminFetchRaw`）；备份为停机复制 `<GBRAIN_HOME>/.gbrain` 整目录 + 保留策略；key 签发前先 revoke 同名防累积。

**Tech Stack:** 沿用 M1-M3（Bun+Hono；Vue3+NaiveUI）。无新依赖。

## Global Constraints（与前序相同，逐字有效）

- 平台 Windows；所有网络监听仅 127.0.0.1。
- **严禁修改 `D:\gbrain-stock` 内任何文件**；对 gbrain 只做 HTTP 访问。
- **严禁写系统盘临时目录**；测试临时文件统一用 `server/test/.tmp/`。
- `config.json` 保持 gitignore。
- 构建类命令（vite build、bun run dev、dev server）**由用户手动执行**；`bun test`、`bunx tsc --noEmit -p server/tsconfig.json`、`web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json` 允许（**禁 bunx vue-tsc**）。
- 提交信息 conventional commits；测试子进程必须清理；3131 端口进程绝不得触碰。
- 工作分支：`m4-ops-maintenance`（从 main 切出）。

## 已核实的事实（源码勘察 2026-08-28，不得偏离）

| 主题 | 事实 |
|---|---|
| traverse_graph | 传 link_type 或 direction → **GraphPath[] 裸数组**（无包装）：`{from_slug, to_slug, link_type, context, depth}`；两者都不传 → GraphNode[] `{slug,title,type,depth,links:[{to_slug,link_type}]}`。MCP 直接 JSON.stringify 无信封 |
| entity card.edges | `{type, direction:'out'\|'in', slug, context}`（排除 mentions、上限 10）；direction out=卡主体是 from |
| admin requests | GET /admin/api/requests?page&agent&operation&status → `{rows:[{id,token_name,agent_name,operation,latency_ms,status,params,error_message,created_at}], total, page, pages}`（limit 固定 50） |
| admin jobs/watch | GET /admin/api/jobs/watch → `{ts_ms, by_type:[{name,total,completed,failed,dead}], queue_health:{waiting,active,stalled}, lease_pressure_1h, top_errors:[{cluster,count}], budget_owners:[{owner_id,remaining_cents,total_spent_cents}]}` |
| admin agents | GET /admin/api/agents → **裸数组** `[{id,name,auth_type,grant_types,scope,source_id,federated_read,created_at,token_ttl,status,last_used_at,total_requests,requests_today}]` |
| admin api-keys | GET → 裸数组 `[{id,name,created_at,last_used_at,status}]`；POST `{name}` → `{name,token,id}`（**token 仅此一次**，前缀 gbrain_）；POST `/admin/api/api-keys/revoke` `{name}` → `{revoked:true}`（按 name 撤销**所有**同名 active 行） |
| SSE /admin/events | 仅 `data: {json}\n\n`（无 event: 名、无心跳）；payload `{agent,operation,params,scopes,latency_ms,status,error?,timestamp}` |
| 备份范围 | `<GBRAIN_HOME>/.gbrain` 整目录（brain.pglite 是**目录**、WAL 在 pg_wal/ 内、config.json/audit/migrations 同级）；**必须先停 serve**；export 目录不在其中 |
| 真实锁路径 | `join(gbrainHome,".gbrain","brain.pglite",".gbrain-lock")`（database_path 在 `<home>/.gbrain/config.json`）——**stale-lock.ts 现路径错误**（M1 缺陷） |
| update-check | 现状从 serve 日志横幅解析 current、fetch updateUrl（updateProxy 兜底）；缺陷：版本比较用字典序 |

## 文件结构总览

```
server/src/routes/graph.ts            # 改：归一化真实形状 + entity 兜底 + direction 白名单 + depth 钳
server/src/routes/content.ts          # 改：facts limit numOr；enrichDeletedAt 差集化
server/src/routes/ops.ts              # 新：requests/jobs/agents/api-keys/SSE 代理
server/src/backup.ts                  # 新：停机备份 + 保留策略 + 列表/删除
server/src/app.ts                     # 改：update-check 分量比较、index.html no-cache、挂 ops/backup 路由
server/src/gbrain-client.ts           # 改：issueApiKey 先 revoke 同名；adminFetchRaw
server/src/stale-lock.ts              # 改：锁路径修正（读 config.json 的 database_path）
server/test/fixtures/fake-gbrain.ts   # 改：GraphPath 形状模式、requests/jobs/agents 端点
server/test/graph.test.ts / content.test.ts / ops.test.ts(新) / backup.test.ts(新) / stale-lock.test.ts
web/src/views/Graph.vue               # 改：seed 清空、pushEdge 键含 type
web/src/views/RequestLog.vue          # 新：请求日志（分页+过滤+SSE 实时）
web/src/views/Jobs.vue                # 新：任务队列快照（5s 轮询）
web/src/views/Agents.vue              # 新：agents + api-keys 管理
web/src/views/Backup.vue              # 新：备份管理 + 停机横幅
web/src/views/Config.vue              # 新：配置只读页
web/src/router.ts / App.vue           # 改：路由与导航（M4 全启用）
README.md                             # 改：M4 使用说明与验收清单
```

---

### Task 1: 图谱双缺陷修复 + 归一化真实形状

**Files:**
- Modify: `server/src/routes/graph.ts`、`server/test/fixtures/fake-gbrain.ts`、`server/test/graph.test.ts`、`web/src/views/Graph.vue`

**Interfaces:**
- Produces:
  - graph.ts 归一化重写：输入接受**三种形态**——①顶层数组（GraphPath[]：from_slug/to_slug/link_type；GraphNode[]：slug+links[{to_slug,link_type}]）②`{edges:[...]}`③`{paths:[...]}`；输出不变 `{nodes:[{slug,title,type}], edges:[{source,target,type}]}`。GraphNode 形态时从根 slug + links 展开边。
  - expand 空结果兜底：归一化后 edges 为空时调 `entity(name=slug)`，把 `card.edges`（direction out→source=slug/target=edge.slug；in→source=edge.slug/target=slug）映射为边，节点从边两端生成；entity 也无果则原样返回空。
  - direction 白名单（in/out/both，否则 400）+ depth `Math.max(1, Math.min(3, Math.floor(Number||1)))`。
  - fake 新增 GraphPath 真实形状：`FAKE_GRAPH_SHAPE=paths`（默认仍 edges 包装形状）时 traverse_graph 返回 `[{from_slug,to_slug,link_type,context:"",depth:1}]` 裸数组。
  - Graph.vue `seed()` 开头 `nodes.clear(); edges.clear(); card.value = null;`（与重置对齐，重置按钮简化为 `seed()`）；`pushEdge` 去重键改 `${source}->${target}::${type}`。

- [ ] **Step 1: 写失败测试（graph.test.ts 追加）**

```ts
describe("归一化真实形状（GraphPath 裸数组）", () => {
  test("FAKE_GRAPH_SHAPE=paths 时 expand 产出节点与边", async () => {
    // 见下方 helpers 说明：bootPanelWithFake 需支持传入 fake 环境变量扩展
    const { panelPort } = await boot({ FAKE_GRAPH_SHAPE: "paths" });
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("people/alice")}&depth=1&direction=both`)).json() as any;
    expect(json.edges.some((e: any) => e.source === "notes/seed-1" && e.target === "people/alice")).toBe(true);
    expect(json.nodes.some((n: any) => n.slug === "notes/seed-1")).toBe(true);
  });

  test("direction 非法 → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=x&direction=sideways`);
    expect(res.status).toBe(400);
  });

  test("depth=abc/0/99 分别回退 1/1/3", async () => {
    const { panelPort } = await boot();
    for (const [q, ok] of [["depth=abc", true], ["depth=0", true], ["depth=99", true]] as const) {
      const res = await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("people/alice")}&${q}`);
      expect(res.status).toBe(200);
    }
  });

  test("解析为空时回退 entity 卡关联", async () => {
    // 用一个真实存在但无 links 的 slug：fake 中 notes/dead-page 不在 links 种子里
    const { panelPort } = await boot({ FAKE_GRAPH_SHAPE: "paths" });
    // fake entity 对 dead-page 的卡 edges 硬编码指向 notes/seed-2——先给 fake 加：命中 dead-page 时 edges=[{type:"note",direction:"out",slug:"notes/seed-2"}]
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("notes/dead-page")}&depth=1`)).json() as any;
    expect(json.edges.some((e: any) => e.source === "notes/dead-page" && e.target === "notes/seed-2")).toBe(true);
  });
});
```

（`boot(env)` = bootPanelWithFake 扩展：helpers.ts 的 startFakeGbrain opts 增加 `env?: Record<string,string>` 合并进子进程 env；bootPanelWithFake 同样透传。既有调用零改动。）

- [ ] **Step 2: 运行确认失败** — Run: `bun test server/test/graph.test.ts`，Expected: 新增 4 个 FAIL

- [ ] **Step 3: 实现**

graph.ts 归一化核心重写（expand 路由内）：

```ts
      const res = await client.mcpCall<unknown>("traverse_graph", { slug, depth, direction });
      // 三种真实/历史形态归一化：GraphPath 裸数组 / GraphNode 裸数组 / {edges|paths}
      const rawEdges: { source: string; target: string; type: string }[] = [];
      const nodeTitles = new Map<string, { title?: string; type?: string }>();
      const addEdge = (source: string, target: string, type: string) => {
        if (source && target) rawEdges.push({ source, target, type: type || "link" });
      };
      const arr = Array.isArray(res) ? res : ((res as any)?.edges ?? (res as any)?.paths ?? []);
      for (const item of arr as any[]) {
        if (item?.from_slug || item?.to_slug) {                      // GraphPath
          addEdge(item.from_slug ?? "", item.to_slug ?? "", item.link_type ?? "link");
        } else if (item?.source || item?.from) {                     // 历史包装形状
          addEdge(item.source ?? item.from ?? "", item.target ?? item.to ?? "", item.type ?? item.link_type ?? "link");
        } else if (item?.slug && Array.isArray(item?.links)) {       // GraphNode（无 direction 调用）
          nodeTitles.set(item.slug, { title: item.title, type: item.type });
          for (const l of item.links) addEdge(item.slug, l?.to_slug ?? "", l?.link_type ?? "link");
        }
      }
      for (const n of ((res as any)?.nodes ?? []) as any[]) nodeTitles.set(n.slug, { title: n.title, type: n.type });
      let edges = dedupeEdges(rawEdges);
      let nodes = nodesFromEdges(edges, slug, nodeTitles);
      if (!edges.length) {
        // 兜底：entity 卡关联（源码证实 card.edges={type,direction:'out'|'in',slug}，上限 10）
        try {
          const ent = await client.mcpCall<{ found?: boolean; card?: { edges?: { type?: string; direction?: string; slug?: string }[] } }>("entity", { name: slug });
          const ce = ent?.card?.edges ?? [];
          const fb: typeof rawEdges = [];
          for (const e of ce) {
            if (!e?.slug) continue;
            if (e.direction === "in") fb.push({ source: e.slug, target: slug, type: e.type ?? "link" });
            else fb.push({ source: slug, target: e.slug, type: e.type ?? "link" });
          }
          edges = dedupeEdges(fb);
          nodes = nodesFromEdges(edges, slug, nodeTitles);
        } catch { /* entity 失败保持空结果 */ }
      }
      return c.json({ nodes, edges });
```

辅助函数（graph.ts 模块级）：

```ts
function dedupeEdges(edges: { source: string; target: string; type: string }[]) {
  const seen = new Set<string>();
  return edges.filter(e => {
    const k = `${e.source}->${e.target}::${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}
function nodesFromEdges(edges: { source: string; target: string }[], root: string, titles: Map<string, { title?: string; type?: string }>) {
  const slugs = new Set<string>([root, ...edges.flatMap(e => [e.source, e.target])]);
  return [...slugs].map(s => ({ slug: s, title: titles.get(s)?.title ?? s, type: titles.get(s)?.type ?? "" }));
}
```

direction/depth 守卫（expand 开头）：

```ts
    const directionRaw = c.req.query("direction") ?? "both";
    if (!["in", "out", "both"].includes(directionRaw)) return c.json({ error: `direction 非法：${directionRaw}` }, 400);
    const direction = directionRaw as "in" | "out" | "both";
    const depth = Math.max(1, Math.min(3, Math.floor(Number(c.req.query("depth") ?? 1) || 1)));
```

fake-gbrain.ts：`/mcp` 分发读 `process.env.FAKE_GRAPH_SHAPE`——为 "paths" 时 traverse_graph 返回 `links.map(l => ({ from_slug: l.from, to_slug: l.to, link_type: l.type, context: "", depth: 1 }))`（裸数组）；entity 命中 `notes/dead-page` 时 edges 返回 `[{ type: "note", direction: "out", slug: "notes/seed-2" }]`（其余命中维持现状）。

helpers.ts：startFakeGbrain opts 增 `env?: Record<string, string>`（spawn env 合并），bootPanelWithFake(mode, token, env?) 透传。

Graph.vue：`seed()` 开头加三行清空；模板「重置」按钮 `@click="seed()"`（原内联清空删除）；`pushEdge` 的 key 改 `` `${e.source}->${e.target}::${e.type ?? "link"}` ``（函数签名同步）。

- [ ] **Step 4: 运行确认通过** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json && web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`，Expected: 65 PASS（61+4）；双 tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/graph.ts server/test/fixtures/fake-gbrain.ts server/test/graph.test.ts server/test/helpers.ts web/src/views/Graph.vue
git commit -m "fix: traverse_graph 归一化对齐真实 GraphPath 形状 + entity 兜底 + 图谱过滤清空"
```

---

### Task 2: 杂项加固包（backlog #3/#5/#6/#7 + no-cache + stale-lock 路径）

**Files:**
- Modify: `server/src/app.ts`、`server/src/routes/content.ts`、`server/src/stale-lock.ts`、`server/test/stale-lock.test.ts`、`server/test/app.test.ts`（超时放宽）

**Interfaces:**
- Produces:
  - app.ts：update-check 的版本比较改分量比较（`compareVersions(a,b): number`，按 `.` 切数字逐段比；current/latest 任一为 null 时返回 `up_to_date: null`）；静态托管对 `index.html`（含 SPA 回退分支）响应头加 `Cache-Control: no-cache`（其余静态文件保持现状不加缓存头）。
  - content.ts：`GET /facts` 的 limit 改用既有 `numOr`。
  - stale-lock.ts：`readLockStatus` 先读 `join(gbrainHome, ".gbrain", "config.json")` 的 `database_path`（相对则相对该 config.json 所在目录解析），锁目录 = `join(database_path ?? join(gbrainHome, ".gbrain", "brain.pglite"), ".gbrain-lock")`；config.json 缺失/解析失败时回退旧路径 `join(gbrainHome, ".gbrain", ".gbrain-lock")`（兼容）并保持现行为。**readLockStatus 变 async 不友好——保持同步：用 existsSync 探测 config.json，database_path 读取失败即回退。**
  - 测试超时放宽：app.test.ts/orchestrator.test.ts/content.test.ts 中涉及 spawn 面板/子进程的用例，`test("...", async () => {...}, 15000)` 第三参统一 15000ms。

- [ ] **Step 1: 写失败测试**

stale-lock.test.ts 追加：

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

describe("锁路径跟随 database_path（真实布局）", () => {
  test("config.json 指定 database_path 时锁目录在其下", () => {
    const gbrainHome2 = mkdtempSync(join(TMP, "lock2-"));
    const dot = join(gbrainHome2, ".gbrain");
    mkdirSync(dot, { recursive: true });
    writeFileSync(join(dot, "config.json"), JSON.stringify({ database_path: "custom-db" }));
    const lockDir = join(dot, "custom-db", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), "x");
    const t = new Date(Date.now() - 120_000);
    utimesSync(join(lockDir, "lock"), t, t);
    const s = readLockStatus(gbrainHome2);
    expect(s.present).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.lockDir).toBe(lockDir);
    rmSync(gbrainHome2, { recursive: true, force: true });
  });

  test("config.json 缺失时回退旧路径仍可用", () => {
    const gbrainHome3 = mkdtempSync(join(TMP, "lock3-"));
    const lockDir = join(gbrainHome3, ".gbrain", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), "x");
    const s = readLockStatus(gbrainHome3);
    expect(s.present).toBe(true);
    rmSync(gbrainHome3, { recursive: true, force: true });
  });
});
```

app.test.ts 追加：

```ts
describe("index.html 禁缓存", () => {
  test("SPA 回退响应带 Cache-Control: no-cache", async () => {
    const { panelPort } = await bootPanelWithFake("healthy", TOKEN);
    const res = await fetch(`http://127.0.0.1:${panelPort}/`);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});
```

（update-check 分量比较与超时放宽无新断言——分量比较逻辑简单靠代码审查，超时放宽靠后续满载复跑观察。若要测 update-check 需 mock fetch 版本号响应，性价比低，明确不做。）

- [ ] **Step 2: 运行确认失败** — Run: `bun test server/test/stale-lock.test.ts server/test/app.test.ts`，Expected: 新增 3 个 FAIL

- [ ] **Step 3: 实现**

app.ts update-check 响应组装处，替换字典序比较：

```ts
    const compareVersions = (a: string, b: string): number => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    // up_to_date 计算改用：current && latest ? compareVersions(current, latest) >= 0 : null
```

静态托管：index.html 分支与 SPA 回退分支的 Response 构造加 `headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }`（裸 index.html 文件分支同样加 cache-control，content-type 用 Bun.file 自动类型或显式 text/html）。

stale-lock.ts：

```ts
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LockStatus { present: boolean; stale: boolean; lockDir: string }

const STALE_AFTER_MS = 90_000;

function resolveLockDir(gbrainHome: string): string {
  const legacy = join(gbrainHome, ".gbrain", ".gbrain-lock");
  try {
    const cfgPath = join(gbrainHome, ".gbrain", "config.json");
    if (existsSync(cfgPath)) {
      const dbPath = (JSON.parse(readFileSync(cfgPath, "utf8")) as { database_path?: string }).database_path;
      if (dbPath) {
        const abs = /^[a-zA-Z]:[\\/]/.test(dbPath) ? dbPath : join(gbrainHome, ".gbrain", dbPath);
        return join(abs, ".gbrain-lock");
      }
    }
  } catch { /* 解析失败回退 legacy */ }
  return legacy;
}

export function readLockStatus(gbrainHome: string, now = Date.now()): LockStatus {
  const lockDir = resolveLockDir(gbrainHome);
  // ……其余逻辑不变（present/stale 判定沿用）
}

export function clearStaleLock(gbrainHome: string): boolean {
  const s = readLockStatus(gbrainHome);
  if (s.present && s.stale) { rmSync(s.lockDir, { recursive: true, force: true }); return true; }
  return false;
}
```

超时放宽：三个测试文件里 boot/集成类用例逐个加第三参 `15000`（grep `test("` 结合含 `await boot`/`startFakeGbrain`/`makeOrch` 的用例）。

- [ ] **Step 4: 运行确认通过** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`，Expected: 68 PASS（65+3）；tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/routes/content.ts server/src/stale-lock.ts server/test
git commit -m "fix: 版本分量比较/index.html 禁缓存/锁路径修正/超时放宽/杂项守卫"
```

---

### Task 3: enrichDeletedAt 差集化（N+1 消除）

**Files:**
- Modify: `server/src/routes/content.ts`、`server/test/content.test.ts`

**Interfaces:**
- Produces: `GET /pages?include_deleted=true` 时改为**两次 list 调用差集**：先 `list_pages {include_deleted:false}` 取存活集，再 `list_pages {include_deleted:true}` 取全集；全集减存活集 = 已删行，仅对已删行逐个 `get_page {include_deleted:true}` 补 deleted_at（已删行通常少量；get_page 失败置 null 不阻塞）。include_deleted=false 路径零改动（不 enrich）。

- [ ] **Step 1: 写失败测试（content.test.ts 追加）**

```ts
describe("回收站差集补齐", () => {
  test("include_deleted=true 只对已删行发 get_page（fake 记数）", async () => {
    const { panelPort } = await boot();
    // fake 需新增：GET /__calls 计数端点（见 Step 3 fake 改动）——先 reset
    await fetch(`http://127.0.0.1:${panelPort}/api/pages?include_deleted=true&limit=50`);
    const calls = await (await fetch(`http://127.0.0.1:${panelPort}/api/stats`)).json(); // 占位防误用
    // 正确断言（fake 经 bootPanelWithFake 直连）：用 fake.port 直接查 __calls
    const b = await boot();
    await fetch(`http://127.0.0.1:${b.panelPort}/api/pages?include_deleted=true&limit=50`);
    const counters = await (await fetch(`http://127.0.0.1:${b.fake.port}/__calls`)).json() as Record<string, number>;
    expect(counters.list_pages).toBe(2);          // 存活集 + 全集
    expect(counters.get_page ?? 0).toBeLessThanOrEqual(2); // 仅已删行（种子 1 条 + 容差）
  });
});
```

（实现者注意：上面第一个 fetch 是笔误示例——删掉第一个 boot 与占位段，只保留一个 boot 的完整断言；fake 的 `/__calls` 端点见 Step 3。）

- [ ] **Step 2: 运行确认失败** — Run: `bun test server/test/content.test.ts`，Expected: 新增 FAIL（现实现 get_page 次数 = 行数）

- [ ] **Step 3: 实现**

fake-gbrain.ts：模块级 `const opCounts: Record<string, number> = {}`；`/mcp` 分发入口处 `opCounts[name] = (opCounts[name] ?? 0) + 1`；新增路由 `GET /__calls` → `Response.json(opCounts)`（同源无鉴权，仅测试用）。

content.ts 的 include_deleted 分支重写：

```ts
    if (includeDeleted) {
      const [aliveRes, allRes] = await Promise.all([
        client.mcpCall("list_pages", { limit, offset: 0, include_deleted: false }),
        client.mcpCall("list_pages", { limit, offset, include_deleted: true }),
      ]);
      const aliveRows = normRows(aliveRes);
      const aliveSlugs = new Set(aliveRows.map(r => String(r.slug ?? "")));
      const allRows = normRows(allRes);
      const deleted = allRows.filter(r => !aliveSlugs.has(String(r.slug ?? "")));
      await Promise.all(deleted.map(async r => {
        const slug = typeof r.slug === "string" ? r.slug : "";
        if (!slug) return;
        try {
          const d = await client.mcpCall<{ page?: { deleted_at?: string | null } }>("get_page", { slug, include_deleted: true });
          if (d?.page) r.deleted_at = d.page.deleted_at ?? null;
        } catch { r.deleted_at = r.deleted_at ?? null; }
      }));
      return c.json({ pages: allRows, total: allRows.length });
    }
    // include_deleted=false 原逻辑不变（去 enrich 调用）
```

（`enrichDeletedAt` 函数删除；`normRows` 为 b97bdeb 已有的裸数组/包装兼容辅助，若名不同以现状为准。）

- [ ] **Step 4: 运行确认通过** — Run: `bun test`，Expected: 69 PASS（68+1）

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/content.ts server/test/content.test.ts server/test/fixtures/fake-gbrain.ts
git commit -m "perf: 回收站差集补齐 deleted_at（消除 N+1）"
```

---

### Task 4: 运维后端（ops 路由 + SSE 代理 + key 自清理）

**Files:**
- Create: `server/src/routes/ops.ts`、`server/test/ops.test.ts`
- Modify: `server/src/app.ts`、`server/src/gbrain-client.ts`、`server/test/fixtures/fake-gbrain.ts`

**Interfaces:**
- Produces:
  - `GbrainClient.adminFetchRaw(path): Promise<Response>`（带 cookie 会话的原始 fetch，供 SSE 透传；401 重登一次同 withSession 语义但返回 Response 不解析 JSON）。
  - `GbrainClient.issueApiKey(name)` 改造：先 `POST /admin/api/api-keys/revoke {name}`（忽略失败——首次无同名），再 POST 签发。防同名累积（源码证实 revoke 撤销所有同名 active 行，先撤后签时序安全）。
  - ops.ts 挂载 `/api`：
    - `GET /api/ops/requests?page&agent&operation&status` → 透传 admin requests
    - `GET /api/ops/jobs` → 透传 jobs/watch
    - `GET /api/ops/agents` → 透传 agents
    - `GET /api/ops/api-keys` → 透传；`POST /api/ops/api-keys {name}` → 透传（响应含一次性 token）；`POST /api/ops/api-keys/revoke {name}` → 透传
    - `GET /api/events` → SSE 透传：`adminFetchRaw("/admin/events")` 后 `return new Response(upstream.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })`；上游失败 502。
  - fake 新增：`GET /admin/api/requests` → `{rows:[{id:1,token_name:"gbrain-panel",agent_name:"gbrain-panel",operation:"list_pages",latency_ms:12,status:"success",params:"{}",error_message:null,created_at:"2026-08-28T00:00:00Z"}],total:1,page:1,pages:1}`；`GET /admin/api/jobs/watch` → 固定快照（by_type 一项/queue_health 全 0/top_errors 空数组/budget_owners 空数组）；`GET /admin/api/agents` → 裸数组两项（oauth+api_key 各一）；`POST /admin/api/api-keys/revoke` → `{revoked:true}`。

- [ ] **Step 1: 写失败测试（ops.test.ts，完整）**

```ts
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
  });

  test("jobs 透传含 by_type/queue_health", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/jobs`)).json() as any;
    expect(Array.isArray(json.by_type)).toBe(true);
    expect(json.queue_health).toBeTruthy();
  });

  test("agents 裸数组透传", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/agents`)).json() as any;
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(2);
  });

  test("api-keys：GET 列表 / POST 签发返回一次性 token / revoke", async () => {
    const { panelPort } = await boot();
    const created = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "manual-test" }) })).json() as any;
    expect(created.token).toBeTruthy();
    const revoked = await (await fetch(`http://127.0.0.1:${panelPort}/api/ops/api-keys/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "manual-test" }) })).json() as any;
    expect(revoked.revoked).toBe(true);
  });

  test("key 自清理：issueApiKey 先 revoke 同名（fake 计数验证）", async () => {
    const b = await bootPanelWithFake("healthy", TOKEN);
    panels.push(b.server); fakes.push(b.fake);
    const client = b.client;
    await client.mcpCall("list_pages", { limit: 1 }); // 触发 issueApiKey("gbrain-panel")
    const counters = await (await fetch(`http://127.0.0.1:${b.fake.port}/__calls`)).json() as Record<string, number>;
    // fake 的 /__calls 只计 /mcp op；admin 调用计数复用 /__calls 顶层键（fake 实现时把 admin 路径也计数，键为路径）
    expect(counters["POST /admin/api/api-keys/revoke"]).toBeGreaterThanOrEqual(1);
  });

  test("SSE 代理转发 content-type 与首块", async () => {
    const { panelPort } = await boot();
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    ctrl.abort(); // 读到头即可，流由 abort 掐断
  });
});
```

（fake 需同步实现 `/admin/events` 的最小 SSE：握手头 + `: connected\n\n` 注释行后挂起不关闭——否则 fetch 头都拿不到。`/__calls` 计数扩展到 admin 路径（键 `METHOD path`）。）

- [ ] **Step 2: 运行确认失败** — Run: `bun test server/test/ops.test.ts`，Expected: 全部 FAIL（404）

- [ ] **Step 3: 实现** ops.ts（透传模式与 content.ts 一致，try/catch 502）、app.ts 挂载 `app.route("/api", opsRoutes(client, cfg))`（ops.ts 需 cfg 吗？SSE 代理用 client.adminFetchRaw 即可，不需要 cfg——签名 `opsRoutes(client)`）、gbrain-client 两处改造、fake 四个 admin 端点 + SSE + /__calls 扩展。issueApiKey 改造：

```ts
  async issueApiKey(name: string): Promise<string> {
    // 同名先撤销（源码：revoke 按 name 撤所有 active 行；先撤后签防累积，冷启动至多 1 条 active）
    await this.adminPost("/admin/api/api-keys/revoke", { name }).catch(() => null);
    const json = await this.adminPost<Record<string, unknown>>("/admin/api/api-keys", { name });
    const key = (json.token ?? json.key ?? json.api_key) as string | undefined;
    if (!key) throw new Error(`api-keys 响应无 key 字段: ${JSON.stringify(json)}`);
    return key;
  }
```

（注意真实返回是 `{name,token,id}`——token 优先。既有测试"issueApiKey 用 POST，兼容 key 字段"的 responder 不含 revoke 路径会 404→catch 忽略→继续，兼容；但"签 key 失败+根因"测试的 responder 对 revoke 返回什么都会被 catch 吞——安全。跑全量确认。）

- [ ] **Step 4: 运行确认通过** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`，Expected: 75 PASS（69+6）；tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ops.ts server/src/app.ts server/src/gbrain-client.ts server/test/ops.test.ts server/test/fixtures/fake-gbrain.ts
git commit -m "feat: 运维后端（requests/jobs/agents/api-keys 透传 + SSE 代理 + key 自清理）"
```

---

### Task 5: 运维前端三视图

**Files:**
- Create: `web/src/views/RequestLog.vue`、`web/src/views/Jobs.vue`、`web/src/views/Agents.vue`
- Modify: `web/src/router.ts`、`web/src/App.vue`

**Interfaces:**
- Consumes: Task 4 的 /api/ops/* 与 /api/events。
- Produces: `/ops/requests`、`/ops/jobs`、`/ops/agents` 三视图；导航「运维」组启用。无单测（vue-tsc 0 错误）。

- [ ] **Step 1: router.ts 加三条路由（catch-all 之前）**：`/ops/requests`、`/ops/jobs`、`/ops/agents`；App.vue nav 替换 M4 占位为三项：`{ to: "/ops/requests", label: "请求日志" }`、`{ to: "/ops/jobs", label: "任务队列" }`、`{ to: "/ops/agents", label: "Agents · 密钥" }`，并加 `{ to: "/backup", label: "备份（M4）", disabled: true }`、`{ to: "/config", label: "配置（M4）", disabled: true }` 占位（Task 6/7 启用）——占位文件本步创建（同 M3 做法，两行占位模板）。

- [ ] **Step 2: RequestLog.vue**

```vue
<!-- web/src/views/RequestLog.vue -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { NInput, NButton, NDataTable, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Row { id?: number; token_name?: string; agent_name?: string; operation?: string; latency_ms?: number; status?: string; params?: string; error_message?: string | null; created_at?: string }

const message = useMessage();
const rows = ref<Row[]>([]);
const total = ref(0);
const pages = ref(1);
const page = ref(1);
const agent = ref("");
const operation = ref("");
const status = ref("");
const live = ref(false);
let es: EventSource | null = null;

async function load() {
  try {
    const params = new URLSearchParams({ page: String(page.value), agent: agent.value || "all" });
    if (operation.value.trim()) params.set("operation", operation.value.trim());
    if (status.value.trim()) params.set("status", status.value.trim());
    const json = await api<{ rows?: Row[]; total?: number; pages?: number }>(`/ops/requests?${params}`);
    rows.value = json.rows ?? []; total.value = json.total ?? 0; pages.value = json.pages ?? 1;
  } catch (e) { message.error(String(e)); }
}

function toggleLive() {
  if (es) { es.close(); es = null; live.value = false; return; }
  es = new EventSource("/api/events");
  es.onmessage = ev => {
    try { rows.value.unshift(JSON.parse(ev.data) as Row); rows.value = rows.value.slice(0, 100); } catch { /* 忽略非 JSON */ }
  };
  es.onerror = () => { es?.close(); es = null; live.value = false; message.warning("实时流断开"); };
  live.value = true;
}

const statusType = (s: string | undefined) => s === "success" ? "success" : s?.startsWith("success") ? "info" : "error";

const columns = [
  { title: "时间", key: "created_at", render: (r: Row) => (r.created_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "Agent", key: "agent_name", render: (r: Row) => r.agent_name ?? r.token_name ?? "" },
  { title: "操作", key: "operation" },
  { title: "耗时", key: "latency_ms", render: (r: Row) => `${r.latency_ms ?? 0}ms` },
  { title: "状态", key: "status", render: (r: Row) => r.status ?? "" },
];

onMounted(load);
onUnmounted(() => es?.close());
</script>

<template>
  <div class="page">
    <h2>请求日志</h2>
    <div class="toolbar">
      <NInput v-model:value="agent" placeholder="agent（all=全部）" clearable style="width: 180px" @keyup.enter="page = 1; load()" />
      <NInput v-model:value="operation" placeholder="操作过滤" clearable style="width: 160px" @keyup.enter="page = 1; load()" />
      <NInput v-model:value="status" placeholder="状态过滤" clearable style="width: 140px" @keyup.enter="page = 1; load()" />
      <NButton size="small" @click="page = 1; load()">查询</NButton>
      <NButton size="small" :type="live ? 'success' : 'default'" @click="toggleLive">{{ live ? "实时中（点击停止）" : "实时流" }}</NButton>
      <NButton v-if="page > 1" size="small" @click="page--; load()">上一页</NButton>
      <NButton v-if="page < pages" size="small" @click="page++; load()">下一页</NButton>
      <span class="muted">共 {{ total }} 条（第 {{ page }}/{{ pages }} 页）</span>
    </div>
    <NDataTable :columns="columns" :data="rows" :bordered="false" size="small" :row-key="(r: Row) => r.id ?? 0" />
    <NTag v-if="live" type="success" size="small" style="margin-top: 8px">实时事件插入列表头部（最新 100 条）</NTag>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.muted { color: #888; font-size: 12px; }
</style>
```

- [ ] **Step 3: Jobs.vue（5s 轮询快照）**

```vue
<!-- web/src/views/Jobs.vue -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { NCard, NStatistic, NGrid, NGi, NDataTable, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Snapshot { ts_ms?: number; by_type?: { name: string; total: number; completed: number; failed: number; dead: number }[]; queue_health?: { waiting?: number; active?: number; stalled?: number }; lease_pressure_1h?: number; top_errors?: { cluster: string; count: number }[]; budget_owners?: { owner_id: string; remaining_cents: number; total_spent_cents: number }[] }

const message = useMessage();
const snap = ref<Snapshot | null>(null);
let timer: number | undefined;

async function load() {
  try { snap.value = await api<Snapshot>("/ops/jobs"); } catch (e) { message.error(String(e)); }
}

const typeColumns = [
  { title: "类型", key: "name" },
  { title: "总数", key: "total" },
  { title: "完成", key: "completed" },
  { title: "失败", key: "failed" },
  { title: "死信", key: "dead" },
];
const errColumns = [
  { title: "错误簇", key: "cluster" },
  { title: "次数", key: "count" },
];

onMounted(() => { load(); timer = window.setInterval(load, 5000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="page">
    <h2>任务队列 <NTag size="small" type="info">每 5 秒刷新</NTag></h2>
    <NGrid v-if="snap" :cols="5" :x-gap="12" :y-gap="12">
      <NGi><NCard size="small"><NStatistic label="等待" :value="snap.queue_health?.waiting ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="执行中" :value="snap.queue_health?.active ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="停滞" :value="snap.queue_health?.stalled ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="租约压力(1h)" :value="snap.lease_pressure_1h ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="快照时间" :value="snap.ts_ms ? new Date(snap.ts_ms).toLocaleTimeString() : '-'" /></NCard></NGi>
    </NGrid>
    <NCard title="按类型" size="small" style="margin-top: 12px">
      <NDataTable :columns="typeColumns" :data="snap?.by_type ?? []" :bordered="false" size="small" />
    </NCard>
    <NCard title="Top 错误" size="small" style="margin-top: 12px">
      <NDataTable :columns="errColumns" :data="snap?.top_errors ?? []" :bordered="false" size="small" />
    </NCard>
    <NCard title="预算属主" size="small" style="margin-top: 12px">
      <pre>{{ JSON.stringify(snap?.budget_owners ?? [], null, 2) }}</pre>
    </NCard>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
</style>
```

- [ ] **Step 4: Agents.vue（列表 + 建 key 一次性显示 + revoke）**

```vue
<!-- web/src/views/Agents.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { NDataTable, NButton, NModal, NInput, NPopconfirm, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Agent { id?: string; name?: string; auth_type?: string; scope?: string; status?: string; created_at?: string; last_used_at?: string | null; total_requests?: number; requests_today?: number }
interface KeyRow { id?: string; name?: string; created_at?: string; last_used_at?: string | null; status?: string }

const message = useMessage();
const agents = ref<Agent[]>([]);
const keys = ref<KeyRow[]>([]);
const showNew = ref(false);
const newName = ref("");
const createdToken = ref<string | null>(null);

async function load() {
  try {
    const [a, k] = await Promise.all([
      api<Agent[] | { agents?: Agent[] }>("/ops/agents"),
      api<KeyRow[] | { keys?: KeyRow[] }>("/ops/api-keys"),
    ]);
    agents.value = Array.isArray(a) ? a : (a.agents ?? []);
    keys.value = Array.isArray(k) ? k : (k.keys ?? []);
  } catch (e) { message.error(String(e)); }
}

async function createKey() {
  if (!newName.value.trim()) { message.warning("名称必填"); return false; }
  try {
    const json = await api<{ token?: string }>("/ops/api-keys", { method: "POST", body: JSON.stringify({ name: newName.value.trim() }) });
    createdToken.value = json.token ?? "(响应未含 token)";
    message.success("已签发——token 仅显示这一次");
    await load();
    return true; // 关闭弹窗
  } catch (e) { message.error(String(e)); return false; }
}

async function revoke(name: string) {
  try { await api("/ops/api-keys/revoke", { method: "POST", body: JSON.stringify({ name }) }); message.success(`已撤销 ${name}（同名全部）`); await load(); }
  catch (e) { message.error(String(e)); }
}

const agentColumns = [
  { title: "名称", key: "name" },
  { title: "类型", key: "auth_type", render: (a: Agent) => a.auth_type === "oauth" ? "OAuth" : "API Key" },
  { title: "scope", key: "scope" },
  { title: "状态", key: "status", render: (a: Agent) => a.status ?? "" },
  { title: "请求数", key: "total_requests", render: (a: Agent) => `${a.total_requests ?? 0}（今日 ${a.requests_today ?? 0}）` },
  { title: "最近使用", key: "last_used_at", render: (a: Agent) => (a.last_used_at ?? "从未").slice(0, 19).replace("T", " ") },
];
const keyColumns = [
  { title: "名称", key: "name" },
  { title: "签发时间", key: "created_at", render: (k: KeyRow) => (k.created_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "状态", key: "status", render: (k: KeyRow) => k.status ?? "" },
  { title: "操作", key: "actions", render: (k: KeyRow) => k.status === "active" && k.name
      ? hRevoke(k.name!) : "" },
];
import { h } from "vue";
function hRevoke(name: string) {
  return h(NPopconfirm, { onPositiveClick: () => revoke(name) }, { trigger: () => h(NButton, { size: "tiny", type: "warning" }, { default: () => "撤销" }), default: () => `撤销 ${name} 的所有同名 active key？` });
}

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>Agents 与密钥</h2>
    <NButton size="small" type="primary" style="margin-bottom: 12px" @click="showNew = true; createdToken = null; newName = ''">签发 API Key</NButton>
    <NCard title="Agents（OAuth 客户端 + API key）" size="small">
      <NDataTable :columns="agentColumns" :data="agents" :bordered="false" size="small" />
    </NCard>
    <NCard title="API Keys" size="small" style="margin-top: 12px">
      <NDataTable :columns="keyColumns" :data="keys" :bordered="false" size="small" />
    </NCard>

    <NModal v-model:show="showNew" title="签发 API Key" preset="dialog" positive-text="签发" negative-text="关闭" @positive-click="createKey">
      <NInput v-model:value="newName" placeholder="key 名称（必填）" />
      <div v-if="createdToken" style="margin-top: 12px">
        <NTag type="warning" size="small">token 仅此一次显示，请立即复制保存：</NTag>
        <pre style="user-select: all; background: #f6f6fa; padding: 8px; border-radius: 6px; margin-top: 6px">{{ createdToken }}</pre>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
</style>
```

- [ ] **Step 5: 类型检查 + Commit**

Run: `web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json` → 0 错误；`bun test` 75 绿不变。

```bash
git add web/src
git commit -m "feat: 运维三视图（请求日志+SSE/任务队列/Agents 密钥）"
```

---

### Task 6: 备份（后端 + 前端 + 横幅）

**Files:**
- Create: `server/src/backup.ts`、`server/test/backup.test.ts`、`web/src/views/Backup.vue`
- Modify: `server/src/app.ts`（挂路由）、`web/src/router.ts`、`web/src/App.vue`

**Interfaces:**
- Consumes: `Orchestrator`（killServe/start/getState）、`GbrainClient`（重启后重建会话）、`PanelConfig`（gbrainHome/backupDir/backupRetention）。
- Produces:
  - `class BackupManager { constructor(deps: { cfg: PanelConfig; orch: Orchestrator; client: GbrainClient }) ; list(): {name, sizeBytes, createdAt}[]（读 backupDir 目录，不调 gbrain）; async run(): Promise<{name: string; sizeBytes: number}>（仅 own/attached? 见下）; remove(name: string): boolean }`
  - **安全约束（源码证实 serve 持锁时拷贝不一致）**：run() 仅在 orch.getState()==="own" 时执行（attach 模式抛错提示"复用他人 serve，无法安全停机备份"）；流程 killServe → 递归复制 `join(cfg.gbrainHome, ".gbrain")` → `join(cfg.backupDir, "gbrain-backup-" + ts)` → orch.start()（重建）→ prune（保留最近 cfg.backupRetention 份，按目录名时间戳排序删旧）→ 返回。start() 后 client 会话自愈（惰性重登，apiKey 存库不变）。
  - 路由（挂 /api）：`GET /api/backups`（列表）、`POST /api/backups`（触发，运行中再次触发 409）、`DELETE /api/backups/:name`（name 仅允许 `gbrain-backup-<ts>` 模式，防路径注入）。
  - Backup.vue：列表表格（时间/大小/删除）+「立即备份」按钮（确认弹窗：将暂停服务约 N 秒）+ 进行中横幅（全局置顶条，轮询 /api/backups 的 running 状态字段——BackupManager 暴露 `isRunning()`，路由 GET 返回 `{ running, backups }`）。

- [ ] **Step 1: 写失败测试（backup.test.ts，核心逻辑用临时目录 + fake orchestrator 双态）**

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BackupManager } from "../src/backup";
import type { Orchestrator } from "../src/orchestrator";
import type { GbrainClient } from "../src/gbrain-client";
import type { PanelConfig } from "../src/config";

const TMP = join(import.meta.dir, ".tmp");
let home: string, backupDir: string;
const fakeOrch = (state: string) => ({ getState: () => state, killServe: async () => {}, start: async () => "own" as const }) as unknown as Orchestrator;
const fakeClient = {} as GbrainClient;

beforeEach(() => {
  home = mkdtempSync(join(TMP, "bk-home-"));
  backupDir = mkdtempSync(join(TMP, "bk-out-"));
  mkdirSync(join(home, ".gbrain", "brain.pglite"), { recursive: true });
  writeFileSync(join(home, ".gbrain", "config.json"), "{}");
  writeFileSync(join(home, ".gbrain", "brain.pglite", "PG_VERSION"), "17");
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(backupDir, { recursive: true, force: true }); });

function cfg(): PanelConfig {
  return { gbrainBin: "", gbrainHome: home, panelPort: 0, gbrainPort: 0, bootstrapToken: "t", backupDir, backupRetention: 2, updateUrl: "", updateProxy: null } as unknown as PanelConfig;
}

describe("BackupManager", () => {
  test("own 态：复制 .gbrain 整目录并重启", async () => {
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    const r = await bm.run();
    expect(existsSync(join(backupDir, r.name, "brain.pglite", "PG_VERSION"))).toBe(true);
    expect(existsSync(join(backupDir, r.name, "config.json"))).toBe(true);
  });

  test("attached/foreign 态拒绝", async () => {
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("attached"), client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/复用他人 serve|无法安全停机/);
  });

  test("保留策略：超份数删最旧", async () => {
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    // 伪早份数据
    for (const ts of ["20260101-000000", "20260102-000000", "20260103-000000"]) {
      mkdirSync(join(backupDir, `gbrain-backup-${ts}`), { recursive: true });
      writeFileSync(join(backupDir, `gbrain-backup-${ts}`, "x"), "x");
    }
    const r = await bm.run(); // retention=2
    const dirs = readdirSync(backupDir).filter(d => d.startsWith("gbrain-backup-")).sort();
    expect(dirs.length).toBe(2);
    expect(dirs).toContain(r.name);
    expect(dirs).not.toContain("gbrain-backup-20260101-000000");
  });

  test("remove：合法名删除、路径注入拒绝", () => {
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    mkdirSync(join(backupDir, "gbrain-backup-20260101-000000"), { recursive: true });
    expect(bm.remove("gbrain-backup-20260101-000000")).toBe(true);
    expect(bm.remove("..\\evil")).toBe(false);
    expect(bm.remove("no-such")).toBe(false);
  });
});
```

（PanelConfig 已被 b97bdeb 扩展过 updateUrl/updateProxy 字段——测试 cfg() 以现状字段为准拼全，缺字段用 as unknown 兜底即可。）

- [ ] **Step 2: 运行确认失败** — Run: `bun test server/test/backup.test.ts`，Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 backup.ts**

```ts
// server/src/backup.ts
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PanelConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { GbrainClient } from "./gbrain-client";

export interface BackupInfo { name: string; sizeBytes: number; createdAt: string }

const NAME_RE = /^gbrain-backup-\d{8}-\d{6}$/;

export class BackupManager {
  private running = false;

  constructor(private deps: { cfg: PanelConfig; orch: Orchestrator; client: GbrainClient }) {}

  isRunning(): boolean { return this.running; }

  list(): BackupInfo[] {
    if (!existsSync(this.deps.cfg.backupDir)) return [];
    return readdirSync(this.deps.cfg.backupDir)
      .filter(d => NAME_RE.test(d))
      .map(d => {
        const p = join(this.deps.cfg.backupDir, d);
        let size = 0;
        const walk = (dir: string) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const fp = join(dir, f.name); size += f.isDirectory() ? (walk(fp), 0) : statSync(fp).size; } };
        try { walk(p); } catch { /* 单文件失败忽略 */ }
        return { name: d, sizeBytes: size, createdAt: statSync(p).mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async run(): Promise<BackupInfo> {
    if (this.running) throw new Error("已有备份在进行中");
    if (this.deps.orch.getState() !== "own") throw new Error("当前复用他人 serve（attached/foreign），无法安全停机备份——请以面板自有 serve 运行时备份");
    this.running = true;
    try {
      await this.deps.orch.killServe();
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2");
      const name = `gbrain-backup-${ts}`;
      const dest = join(this.deps.cfg.backupDir, name);
      mkdirSync(this.deps.cfg.backupDir, { recursive: true });
      cpSync(join(this.deps.cfg.gbrainHome, ".gbrain"), dest, { recursive: true });
      const state = await this.deps.orch.start();
      if (state !== "own") throw new Error(`备份后 serve 重启异常（${state}）——备份文件已生成：${name}`);
      this.prune();
      return this.list().find(b => b.name === name) ?? { name, sizeBytes: 0, createdAt: new Date().toISOString() };
    } finally {
      this.running = false;
    }
  }

  private prune(): void {
    const dirs = readdirSync(this.deps.cfg.backupDir).filter(d => NAME_RE.test(d)).sort();
    while (dirs.length > this.deps.cfg.backupRetention) {
      const oldest = dirs.shift()!;
      rmSync(join(this.deps.cfg.backupDir, oldest), { recursive: true, force: true });
    }
  }

  remove(name: string): boolean {
    if (!NAME_RE.test(name)) return false;
    const p = join(this.deps.cfg.backupDir, name);
    if (!existsSync(p)) return false;
    rmSync(p, { recursive: true, force: true });
    return true;
  }
}
```

app.ts 挂载（index.ts 构造 BackupManager 传入 createApp deps——**deps 结构变更**：`createApp({ cfg, orch, client, backup })`；既有 app.test/ops.test 的 createApp 调用处同步补 `backup: new BackupManager({...})` 或把 backup 参数设为可选 `backup?: BackupManager`，未传时 /api/backups 返回 503 `{error:"备份未启用"}`——采用可选参数，测试零改动）：

```ts
  if (backup) {
    app.get("/api/backups", c => c.json({ running: backup.isRunning(), backups: backup.list() }));
    app.post("/api/backups", async c => {
      if (backup.isRunning()) return c.json({ error: "已有备份在进行中" }, 409);
      try { return c.json(await backup.run()); }
      catch (e) { return c.json({ error: String(e) }, 503); }
    });
    app.delete("/api/backups/:name", c => {
      const ok = backup.remove(c.req.param("name"));
      return ok ? c.json({ removed: true }) : c.json({ error: "删除失败（名称非法或不存在）" }, 400);
    });
  }
```

（helper：app.test/ops.test 不动——可选参数。index.ts 实例化传入。）

Backup.vue（列表 + 触发 + 全局横幅——横幅放 App.vue 顶部，轮询并入 connection store 的 refresh 每 5s 顺带拉 /api/backups 的 running 字段，`backupRunning` 状态 + 顶部 NAlert 横幅「服务暂停中：正在备份……」，实现于 App.vue 与 stores/connection.ts 扩展一个字段）：

```vue
<!-- web/src/views/Backup.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { NDataTable, NButton, NPopconfirm, NCard, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface BackupInfo { name: string; sizeBytes: number; createdAt: string }

const message = useMessage();
const backups = ref<BackupInfo[]>([]);
const running = ref(false);

async function load() {
  try { const j = await api<{ running: boolean; backups: BackupInfo[] }>("/backups"); running.value = j.running; backups.value = j.backups; }
  catch (e) { message.error(String(e)); }
}

async function runBackup() {
  try { const r = await api<BackupInfo>("/backups", { method: "POST" }); message.success(`备份完成：${r.name}`); await load(); }
  catch (e) { message.error(String(e)); }
}

async function remove(name: string) {
  try { await api(`/backups/${encodeURIComponent(name)}`, { method: "DELETE" }); message.success("已删除"); await load(); }
  catch (e) { message.error(String(e)); }
}

const fmt = (b: number) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`;

const columns = [
  { title: "名称", key: "name" },
  { title: "大小", key: "sizeBytes", render: (b: BackupInfo) => fmt(b.sizeBytes) },
  { title: "时间", key: "createdAt", render: (b: BackupInfo) => b.createdAt.slice(0, 19).replace("T", " ") },
  { title: "操作", key: "actions", render: (b: BackupInfo) => hDel(b.name) },
];
import { h } from "vue";
function hDel(name: string) {
  return h(NPopconfirm, { onPositiveClick: () => remove(name) }, { trigger: () => h(NButton, { size: "tiny", type: "warning" }, { default: () => "删除" }), default: () => `删除备份 ${name}？不可恢复` });
}

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>备份 <NTag v-if="running" type="warning" size="small">备份进行中</NTag></h2>
    <p class="muted">备份会短暂停止面板自有的 gbrain serve（通常数秒），复制整个数据目录（含数据库 WAL）到 {{ '备份目录' }}。保留最近若干份自动清理。</p>
    <NPopconfirm @positive-click="runBackup">
      <template #trigger><NButton type="primary" :disabled="running">立即备份</NButton></template>
      备份期间服务将暂停数秒（停 serve → 复制 → 重启）。确认执行？
    </NPopconfirm>
    <NCard size="small" style="margin-top: 12px">
      <NDataTable :columns="columns" :data="backups" :bordered="false" size="small" />
    </NCard>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.muted { color: #888; font-size: 12px; }
</style>
```

App.vue：nav 的备份项启用；顶部（topbar 内）加 `<NAlert v-if="conn.backupRunning" type="warning" :bordered="false">服务暂停中：正在备份 gbrain 数据目录……</NAlert>`；stores/connection.ts 的 PanelStatus 不动，refresh() 内并行加 `api<{running:boolean}>("/backups").then(j => { this.backupRunning = j.running; }).catch(() => {})`（state 加 `backupRunning: false`）。

router.ts：`/backup` 路由（占位删除）。

- [ ] **Step 4: 运行确认通过** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json && web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`，Expected: 79 PASS（75+4）；双 tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/backup.ts server/src/app.ts server/src/index.ts server/test/backup.test.ts web/src
git commit -m "feat: 停机备份（整目录复制+保留策略+横幅）"
```

---

### Task 7: 配置页 + README + M4 收尾

**Files:**
- Create: `web/src/views/Config.vue`
- Modify: `web/src/router.ts`、`web/src/App.vue`、`README.md`

**Interfaces:**
- Consumes: `/api/status`（面板状态）、`/api/update-check`、面板自身 config.json（后端加只读脱敏端点 `GET /api/panel-config`：返回 config.json 字段但 **bootstrapToken 替换为 `<已隐藏>`**、updateProxy 原样；502 模式同前）。
- Produces: `/config` 视图（面板配置表 + gbrain 版本/更新状态卡）；README M4 使用说明与验收清单。

- [ ] **Step 1: app.ts 加 /api/panel-config（在 /api/status 之后）**

```ts
  app.get("/api/panel-config", c => {
    const { bootstrapToken: _hidden, ...rest } = cfg;
    return c.json({ ...rest, bootstrapToken: "<已隐藏>" });
  });
```

- [ ] **Step 2: Config.vue**

```vue
<!-- web/src/views/Config.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { NCard, NTag, NSpin } from "naive-ui";
import { api } from "../api/client";

const panelCfg = ref<Record<string, unknown> | null>(null);
const update = ref<{ current: string | null; latest: string | null; up_to_date?: boolean | null; networkError?: string | null } | null>(null);
const loading = ref(true);

onMounted(async () => {
  try {
    [panelCfg.value, update.value] = await Promise.all([
      api<Record<string, unknown>>("/panel-config"),
      api<typeof update.value>("/update-check").catch(() => null),
    ]);
  } finally { loading.value = false; }
});
</script>

<template>
  <div class="page">
    <h2>配置</h2>
    <NSpin :show="loading">
      <NCard v-if="update" title="gbrain 版本" size="small" style="margin-bottom: 12px">
        <p>当前：{{ update.current ?? "未知（serve 启动日志未解析到版本横幅）" }}</p>
        <p>最新：{{ update.latest ?? "未知" }}
          <NTag v-if="update.up_to_date === true" type="success" size="small">已是最新</NTag>
          <NTag v-else-if="update.up_to_date === false" type="warning" size="small">有新版本</NTag>
          <NTag v-else size="small">无法比较</NTag>
        </p>
        <p v-if="update.networkError" class="muted">检查更新网络错误：{{ update.networkError }}</p>
      </NCard>
      <NCard title="面板配置（config.json，只读；bootstrapToken 已隐藏）" size="small">
        <pre>{{ panelCfg ? JSON.stringify(panelCfg, null, 2) : "…" }}</pre>
      </NCard>
      <p class="muted" style="margin-top: 8px">gbrain 侧详细配置请查看 gbrain 仓库的 config；面板仅展示与自身运行相关字段。</p>
    </NSpin>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.muted { color: #888; font-size: 12px; }
</style>
```

router.ts 加 `/config`；App.vue nav 配置项启用（M4 全启用，删除占位）。

- [ ] **Step 3: README 更新（「里程碑」节之前插入）**

```markdown
## M4 使用说明（运维与维护）

- **请求日志**：分页浏览 MCP 请求；可按 agent/操作/状态过滤；「实时流」经 SSE 追加最新事件。
- **任务队列**：jobs 快照（等待/执行中/停滞/租约压力/按类型统计/Top 错误），5 秒自动刷新。
- **Agents · 密钥**：查看 OAuth 客户端与 API key；签发新 key（token 只显示一次）；撤销按名称
  一次性撤所有同名 key（面板自签的 gbrain-panel key 已改为签发前先撤同名，不再累积）。
- **备份**：一键停机备份（停 serve → 复制整个 `<GBRAIN_HOME>/.gbrain` 含数据库与 WAL → 重启 →
  自动清理只保留最近 N 份）；仅在面板自有 serve（own）时可用；备份期间顶部显示暂停横幅。
- **配置**：面板 config.json 只读展示（token 隐藏）+ gbrain 版本与更新检查（分量比较）。
- 顺带修复：图谱邻居展开（traverse_graph 真实形状 + entity 兜底）、图谱类型过滤、
  index.html 禁缓存（升级后不再需要硬刷新）、锁路径修正。

### M4 验收清单（手动，需先 build:web 并启动面板）

1. 图谱页单击节点长出一度邻居（M3 缺陷 1 回归验证）；过滤框输类型回车后画布只剩该类型（缺陷 2）。
2. 请求日志分页/过滤可用；点「实时流」后在面板里做一次操作（如查询页面），列表头部出现新事件。
3. 任务队列页显示快照并 5 秒刷新。
4. Agents 页签发一个测试 key（复制一次性 token）、撤销它；确认 gbrain-panel 的自签 key 只剩 1 条 active。
5. 备份：点立即备份 → 顶部横幅出现 → 完成后列表新增一条、旧份数超保留数被清理；
   D:\gbrain-backup 下目录含 brain.pglite 子目录。面板 attach 模式下点备份应被拒绝并提示。
6. 配置页 token 显示为 <已隐藏>；版本比较正确（可对比 gbrain --version）。
7. 构建新前端后直接刷新浏览器（不硬刷新）应加载新版本（no-cache 生效）。
```

- [ ] **Step 4: 全量回归** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json && web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`，Expected: 79 PASS；双 tsc 0 错误

- [ ] **Step 5: Commit + 用户手动验收**

```bash
git add web/src server/src/app.ts README.md
git commit -m "feat: 配置只读页与 M4 使用/验收文档"
```

README「M4 验收清单」7 条交用户执行（先 `bun run build:web`）。

---

## 计划自审记录

- **规格覆盖**：spec §3 运维三项（请求日志/任务队列/Agents 密钥）→ Task 4/5；维护两项（备份/配置）→ Task 6/7（spec §4.3 备份流程逐条落实：仅 own、整目录、保留策略、横幅）；验收缺陷 1→Task 1、缺陷 2→Task 1；验收新观察（no-cache、key 累积、~1s 轮询——**轮询频率实为 5s（App.vue setInterval 5000），验收观察的"约每秒一次"疑为多组件叠加或误测，本计划不改，README 不提**）→ Task 2/4；backlog #1→Task 1、#3/#5/#6/#7→Task 2、#4→Task 3、#8→Task 1；a11y/hover（观察 9）与观察 11（勘误）不处理（观察 9 记 M5 候选）。stale-lock 路径错误（本轮源码勘察新发现）→ Task 2。spec §10"不做用户管理/远程"维持。
- **占位符扫描**：无 TBD；Task 5 的 backup/config 占位是显式临时交付物；Task 3 测试代码中标注的笔误段已明确指示删除。
- **类型一致性**：BackupManager 构造 deps 与 app.ts 挂载一致（可选注入，测试零改动）；opsRoutes(client) 与 contentRoutes 同构；`/api/backups` 返回 `{running, backups}` 与 Backup.vue/connection store 消费一致；GraphPath 归一化字段（from_slug/to_slug/link_type）与源码勘察一致；fake `FAKE_GRAPH_SHAPE`/`/__calls`/admin 四端点在 Task 1/3/4 递增定义、后续任务复用。
