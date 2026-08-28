# gbrain-panel M6（M5 验收缺陷修复）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 M5 真机验收暴露的 1 个 P0（备份活锁判据在 bun shim exec 层下永不成立，本机备份完全不可用）、1 个 P1（SSE 无心跳被 Bun idleTimeout 每 ~10s 杀一次）、1 个 P2（懒加载 chunk 失败被浏览器模块映射缓存导致导航永久静默失败），并落位 M6 backlog 的稳健小项（retention 口径、M-1/M-2/M-3、逃生口、Agents 时间列）。

**Architecture:** 活锁判据从「锁内 PID === killServe 返回的子进程 PID」等值比对（被 exec 层孙进程击穿）改为「持锁进程存活探测」（`process.kill(pid, 0)`，ESRCH=死），以进程存活为唯一事实源，天然穿透任意进程拓扑；SSE 代理从 body 直通改为 ReadableStream 泵 + 5s `: ping` 注释行（EventSource 规范忽略注释行，前端零改动）；导航自愈用 `router.onError` 捕获动态导入失败后定向整页刷新一次（新文档 = 新模块映射），sessionStorage 按路由去重防刷新循环。

**Tech Stack:** Bun + Hono（server）、Vue 3 + vue-router 4 + pinia（web）、bun:test。

## Global Constraints

- 工作目录 `D:\gbrain-panel`，分支 `m6-acceptance-fixes`（基于 main@2897b19）。
- **严禁修改 `D:\gbrain-stock` 内任何文件**（gbrain 源码仅作只读参考；本计划引述的 gbrain 源码行号均已核实）。
- 测试临时文件只写 `server/test/.tmp/`，**严禁写系统盘临时目录**（%TEMP% 等）。
- **不运行** `bun run build:web`、`bun run dev:server`、vite、dev server——构建/重启由用户手动执行；验证只跑测试与类型检查。
- 类型检查命令固定：server 用 `cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`；web 用 `cd /d D:\gbrain-panel\web && node_modules\.bin\vue-tsc --noEmit`（**禁用 bunx**，会拉远端包留系统盘缓存）。
- 测试命令：`cd /d D:\gbrain-panel && bun test server/`（当前基线 88/88 全绿）。
- 本机 3131 端口可能有用户自己的 gbrain serve，**绝不得触碰**；集成测试用 fake 替身端口，不占 3131。
- git push 只在终审后由主会话执行（走代理 `http://127.0.0.1:7897`），任务内只 commit 不 push。
- 提交信息用中文 conventional commits（对齐 `git log` 现有风格）。
- web 侧无单测基建（本里程碑不引入，YAGNI）：Task 3/5 以 vue-tsc + 用户真机验收清单验证；server 侧全部 TDD 红绿。

---

### Task 1: P0 备份活锁判据改「持锁进程存活探测」+ readLockStatus 竞态兜底（I-1）

背景（M5 验收报告条 1，已实证）：面板 spawn 的直接子进程是 `gbrain.exe`（bun shim），它再拉起孙进程 `bun …cli.ts serve`——真正持锁、写锁文件 pid 的是孙进程。`killServe()` 返回子进程 pid，锁文件记录孙进程 pid，`backup.ts` 的 `lockPid === killedPid` 永不成立 → own 态备份必现 503「检测到活跃锁」中止，`D:\gbrain-backup` 零产物。本机 `process.kill(pid, 0)` 语义已实测：存活返回 true，不存在抛 ESRCH（Bun 1.3.x Windows）。

**Files:**
- Modify: `server/src/stale-lock.ts`（新增 `isPidAlive`；`readLockStatus` 读锁竞态兜底）
- Modify: `server/src/backup.ts:78-94`（活锁判据重写；`:147` killServe 注释更新）
- Modify: `server/src/orchestrator.ts:147-148`（killServe 返回值注释更新，代码不动）
- Test: `server/test/backup.test.ts`、`server/test/stale-lock.test.ts`

**Interfaces:**
- Produces: `isPidAlive(pid: number): boolean`（导出自 `server/src/stale-lock.ts`；EPERM 视为存活——类 Unix 无权限语义，Windows 不出现）
- 消费方变化：`BackupManager.run()` 不再消费 `killServe()` 返回值（`Orchestrator.killServe(): Promise<number|null>` 签名不变，返回值保留供诊断/测试）

- [ ] **Step 1: 写失败测试（backup.test.ts 活锁用例重写 + 新增）**

`server/test/backup.test.ts` 中，把现有两个活锁用例（「外部活锁（新鲜心跳且锁 pid≠被杀 pid）→ 中止且不产生备份」与「自有 serve 尸锁（锁 pid=被杀 pid，mtime 仍新鲜）→ 放行备份」）整体替换为下面四个用例（放在原位置，`describe("备份排除运行时工件与安全检查")` 内）：

```ts
  test("外部活锁（锁 pid 存活）→ 中止且不产生备份，且 best-effort 拉回 serve（M-3）", async () => {
    let starts = 0;
    const orch = { getState: () => "own", killServe: async () => 1234, start: async () => { starts++; return "own"; } } as unknown as Orchestrator;
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    // pid=测试进程自身 → 持锁者确定存活（新判据：存活即中止，与 killServe 返回值无关）
    writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: process.pid, acquired_at: Date.now(), refreshed_at: Date.now() }));
    const bm = new BackupManager({ cfg: cfg(), orch, client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/活跃锁|仍在运行/);
    expect(starts).toBeGreaterThanOrEqual(1); // 中止路径必须 best-effort 拉回 serve（M-3 断言）
    const dirs = readdirSync(backupDir).filter(d => d.startsWith("gbrain-backup-"));
    expect(dirs.length).toBe(0);
  });

  test("尸锁放行：锁 pid 是已退出进程（覆盖 bun shim 孙进程持锁——pid≠子进程）→ 备份产出", async () => {
    // M5 验收 P0 的最小复现：持锁孙进程被 taskkill /T 杀死，其 pid 既非 null 也非
    // killServe 返回的子进程 pid。构造确定已死的 pid：spawn 瞬时任进程并等它退出。
    const dead = Bun.spawn(["cmd", "/c", "exit"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
    await dead.exited;
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: dead.pid, acquired_at: Date.now(), refreshed_at: Date.now() })); // mtime=now → 新鲜
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient }); // fakeOrch 的 killServe 返回 1234 ≠ dead.pid
    const r = await bm.run();
    expect(existsSync(join(backupDir, r.name, "brain.pglite", "PG_VERSION"))).toBe(true);
  });

  test("挂起持有者（mtime 已 stale 但 pid 存活）→ 中止（mtime 不再单独放行）", async () => {
    // 行为收紧：旧逻辑 stale 即放行；新逻辑以存活为准——心跳停了但进程还活着（可能仍在写库）必须中止
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: process.pid }));
    const t = new Date(Date.now() - 120_000);
    utimesSync(join(lockDir, "lock"), t, t);
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/活跃锁|仍在运行/);
  });

  test("锁 schema 漂移（新鲜锁读不出 pid）→ 保守中止（回归守卫）", async () => {
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), "{}"); // mtime=now 新鲜，但无 pid 字段
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/无法读取持锁 PID|保守中止/);
  });
```

`server/test/stale-lock.test.ts` 末尾新增（该文件已 import `readLockStatus` 等，按需补 import `isPidAlive`、`writeFileSync`）：

```ts
describe("isPidAlive 与 readLockStatus 竞态兜底（M6）", () => {
  test("isPidAlive：自身 pid 存活、已退出子进程 pid 已死", async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const dead = Bun.spawn(["cmd", "/c", "exit"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
    await dead.exited;
    expect(isPidAlive(dead.pid)).toBe(false);
  });

  test("readLockStatus：锁路径读取失败（ENOTDIR 代理竞态 ENOENT）按无锁处理不抛（I-1）", () => {
    // 确定性构造读取失败：锁路径是文件而非目录（existsSync 为真、readdirSync 抛 ENOTDIR），
    // 与 existsSync 之后目录被并发删除的竞态同走兜底分支
    const dir = mkdtempSync(join(import.meta.dir, ".tmp", "sl-race-"));
    try {
      mkdirSync(join(dir, ".gbrain"), { recursive: true });
      writeFileSync(join(dir, ".gbrain", "config.json"), "{}"); // database_path 缺省 → 锁解析到 brain.pglite/.gbrain-lock
      mkdirSync(join(dir, ".gbrain", "brain.pglite"), { recursive: true });
      writeFileSync(join(dir, ".gbrain", "brain.pglite", ".gbrain-lock"), "not-a-dir");
      const s = readLockStatus(dir);
      expect(s.present).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run: `cd /d D:\gbrain-panel && bun test server/test/backup.test.ts server/test/stale-lock.test.ts`
Expected: FAIL —— `isPidAlive` 未定义/未导出；「尸锁放行」用例在旧等值判据下抛「检测到活跃锁」（正是 P0 复现）；「挂起持有者」用例旧逻辑放行（未抛错）。

- [ ] **Step 3: 实现（stale-lock.ts + backup.ts + orchestrator.ts 注释）**

`server/src/stale-lock.ts`——新增导出函数（放在 `readLockPid` 之后）：

```ts
/** PID 存活探测：signal 0 不实际发信号。进程不存在抛 ESRCH；类 Unix 下无权限抛 EPERM
 *  （= 存活）。Bun 1.3.x Windows 实测：自身 pid → true，不存在的 pid → ESRCH。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}
```

`readLockStatus` 的 readdir/stat 段包 try（I-1 兜底）：

```ts
export function readLockStatus(gbrainHome: string, now = Date.now()): LockStatus {
  const lockDir = resolveLockDir(gbrainHome);
  if (!existsSync(lockDir)) return { present: false, stale: false, lockDir };
  let newest = 0;
  try {
    for (const f of readdirSync(lockDir)) {
      const st = statSync(join(lockDir, f));
      newest = Math.max(newest, st.mtimeMs);
    }
  } catch {
    // existsSync 与 readdir/stat 之间锁目录（或其中文件）被并发删除——按无锁处理：
    // 无持锁者即无写者，调用方（备份活锁检查）放行方向安全，且不裸抛绕过恢复分支
    return { present: false, stale: false, lockDir };
  }
  return { present: true, stale: now - newest > STALE_AFTER_MS, lockDir };
}
```

`server/src/backup.ts`——import 行改为 `import { isPidAlive, readLockPid, readLockStatus } from "./stale-lock";`；`run()` 内 `const killedPid = await this.deps.orch.killServe();` 改为 `await this.deps.orch.killServe();`；活锁检查段（原 81-94 行）整体替换为：

```ts
      // 活锁判据：持锁进程存活探测（2026-08-29 M5 验收 P0 修正）。旧判据 lockPid === killedPid
      // 在 gbrain 经 bun shim 安装的机器上必不成立：面板 spawn 的直接子进程是 gbrain.exe（shim），
      // 它再拉起孙进程 bun cli.ts serve，真正持锁/写锁 pid 的是孙进程，等值永假 → own 态备份必中止。
      // 新判据以进程存活为唯一事实源（穿透任意进程拓扑）：锁 pid 已死（含被 taskkill /T 杀掉的
      // 孙进程尸锁）→ 无写者，放行；锁 pid 仍活 → 外部 serve 抢占，中止。mtime 仅在 pid 读不出
      // （schema 漂移）时兜底。PID 复用窗口内的假活会导致保守中止（方向安全，留痕）。
      const lock = readLockStatus(this.deps.cfg.gbrainHome);
      if (lock.present) {
        const lockPid = readLockPid(this.deps.cfg.gbrainHome);
        if (lockPid !== null) {
          if (isPidAlive(lockPid)) {
            await this.deps.orch.start().catch(() => null); // best-effort 拉回（大概率 attached）
            throw new Error(`检测到活跃锁——持锁进程 ${lockPid} 仍在运行（疑似外部 serve 已抢占），已中止复制（源数据未被修改）`);
          }
          // 锁 pid 已死：自家或他家的尸锁均无写者，放行复制；锁目录已被 filter 排除出备份产物
        } else if (!lock.stale) {
          // 锁 schema 漂移（pid 读不出）且 mtime 新鲜——保守中止，方向安全
          await this.deps.orch.start().catch(() => null);
          throw new Error("检测到新鲜锁但无法读取持锁 PID（锁 schema 漂移？），保守中止复制（源数据未被修改）");
        }
      }
```

`server/src/orchestrator.ts:147-148`——killServe 的 doc 注释中「供备份活锁判据比对锁内 PID（自有尸锁放行）使用；其余调用方忽略返回值即可」改为「返回值当前无内部消费方（备份活锁判据已改用持锁进程存活探测），保留供诊断与测试」。

- [ ] **Step 4: 跑测试确认通过（绿）**

Run: `cd /d D:\gbrain-panel && bun test server/test/backup.test.ts server/test/stale-lock.test.ts`
Expected: PASS（新增 4+2 用例全绿，既有用例不回归）

- [ ] **Step 5: 全量回归 + 双侧 tsc + 提交**

Run: `cd /d D:\gbrain-panel && bun test server/`（全绿）；`cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`（0 错误）

```bash
git add server/src/stale-lock.ts server/src/backup.ts server/src/orchestrator.ts server/test/backup.test.ts server/test/stale-lock.test.ts
git commit -m "fix: 备份活锁判据改持锁进程存活探测（P0：bun shim 孙进程持锁下等值判据永假），readLockStatus 读锁竞态兜底"
```

---

### Task 2: P1 SSE 心跳——面板代理注入 5s `: ping`，防 Bun idleTimeout 杀空闲连接

背景（M5 验收条 6 缺陷 A，已实证）：上游 gbrain 的 `/admin/events` 握手只写一次 `: connected`（源码 `serve-http.ts` `openAdminSseStream`，无周期心跳）且其 express 风格服务不杀空闲流；问题出在面板 Bun.serve 的浏览器腿——默认 `idleTimeout` 10s 杀空闲响应（面板日志 `[Bun.serve]: request timed out after 10 seconds`），EventSource 每 ~10-13s 断连重连。SSE 注释行（`: xxx`）被 EventSource 规范忽略，前端零改动。

**Files:**
- Modify: `server/src/routes/ops.ts:53-65`（/events 处理器重写）
- Test: `server/test/ops.test.ts`（新增空闲心跳用例）

**Interfaces:**
- Consumes: `client.adminFetchRaw("/admin/events"): Promise<Response>`（既有，签名不变）
- Produces: `/api/events` 响应行为变化——空闲期每 5s 一个 `: ping\n\n` 注释块；上游断流则收尾浏览器腿（EventSource 原生重连兜底）；对外 HTTP 头不变

- [ ] **Step 1: 写失败测试（ops.test.ts 新增）**

`server/test/ops.test.ts` 的 `describe("运维路由")` 内、现有「SSE 代理转发 content-type 与首块」用例之后新增：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run: `cd /d D:\gbrain-panel && bun test server/test/ops.test.ts`
Expected: FAIL —— 新用例 `expect(text).toContain(": ping")` 不成立（现有直通代理不注入心跳，text 只有 `: connected`）；既有用例全绿。

- [ ] **Step 3: 实现（ops.ts /events 重写）**

`server/src/routes/ops.ts` 中 `/events` 处理器（含其上方注释块，原 53-65 行）整体替换为：

```ts
  // SSE 透传：/admin/events 流式转发 + 面板侧 5s 心跳（M6）。上游 gbrain 的 SSE 握手只写
  // 一次 ": connected"（源码 serve-http.ts openAdminSseStream，无周期心跳）且不杀空闲流；
  // 而 Bun.serve 默认 idleTimeout=10s 会杀面板这端的空闲响应——浏览器腿每 ~10s 断一次，
  // EventSource 反复重连（M5 验收缺陷 A）。注入 ": ping\n\n"（SSE 注释行，EventSource 规范
  // 忽略，前端零改动）保活；上游断流则收尾浏览器腿，由 EventSource 原生重连兜底。
  app.get("/events", async c => {
    try {
      const upstream = await client.adminFetchRaw("/admin/events");
      if (!upstream.ok || !upstream.body) {
        return c.json({ error: `admin -> HTTP ${upstream.status}` }, 502);
      }
      const reader = upstream.body.getReader();
      const enc = new TextEncoder();
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      const stopPing = () => { if (pingTimer !== undefined) { clearInterval(pingTimer); pingTimer = undefined; } };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          pingTimer = setInterval(() => {
            try { controller.enqueue(enc.encode(": ping\n\n")); } catch { stopPing(); } // 客户端已断开
          }, 5000);
          (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } catch { /* 上游断流：收尾浏览器腿，交给 EventSource 原生重连 */ }
            stopPing();
            try { controller.close(); } catch { /* 已关 */ }
          })();
        },
        cancel(reason) {
          stopPing();
          reader.cancel(reason).catch(() => {});
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    } catch (e) { return c.json({ error: String(e) }, 502); }
  });
```

- [ ] **Step 4: 跑测试确认通过（绿）**

Run: `cd /d D:\gbrain-panel && bun test server/test/ops.test.ts`
Expected: PASS（新用例收到 `: ping`；既有「content-type 与首块」用例不回归——fake 的 `: connected` 仍被透传）

- [ ] **Step 5: 全量回归 + tsc + 提交**

Run: `cd /d D:\gbrain-panel && bun test server/`（全绿）；`cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`（0 错误）

```bash
git add server/src/routes/ops.ts server/test/ops.test.ts
git commit -m "fix: SSE 代理注入 5s : ping 心跳，防 Bun idleTimeout 杀空闲连接致反复断连"
```

---

### Task 3: P2 懒加载导航自愈——router.onError 捕获 chunk 加载失败后定向整页刷新

背景（M5 验收清单外发现 1，已定位）：`web/src/router.ts` 所有路由组件懒加载（`() => import(...)`）；chunk 拉取失败（面板重启窗口连接拒绝 / 前端重建后旧 hash 文件 404）会被**浏览器模块映射按 URL 缓存失败**——之后每次点该路由，`import()` 立即失败、Vue Router 静默中止导航（URL 不变、无提示），整页刷新才恢复（新文档 = 新模块映射）。验收实测「备份操作 → 页面库 → 配置（不可达），Playwright 定位点击与坐标级真实点击均无效」即此机理。修复：`router.onError` 识别动态导入失败 → 定向整页刷新一次，sessionStorage 按路由去重防刷新循环。

**Files:**
- Modify: `web/src/router.ts`（追加 onError 钩子；路由表不动）

**Interfaces:**
- Consumes: vue-router 4 的 `router.onError((error, to) => void)`（导航被中止时回调，`to` 为目标路由）
- Produces: 无对外接口；行为契约——导入失败的目标路由在整页刷新后可达

- [ ] **Step 1: 实现（router.ts 全量替换为下述内容）**

```ts
import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "dashboard", component: () => import("./views/Dashboard.vue") },
    { path: "/pages", name: "pages", component: () => import("./views/Pages.vue") },
    { path: "/pages/:slug", name: "pageDetail", component: () => import("./views/PageDetail.vue") },
    { path: "/facts", name: "facts", component: () => import("./views/Facts.vue") },
    { path: "/capture", name: "capture", component: () => import("./views/Capture.vue") },
    { path: "/graph", name: "graph", component: () => import("./views/Graph.vue") },
    { path: "/timeline", name: "timeline", component: () => import("./views/Timeline.vue") },
    { path: "/ops/requests", name: "opsRequests", component: () => import("./views/RequestLog.vue") },
    { path: "/ops/jobs", name: "opsJobs", component: () => import("./views/Jobs.vue") },
    { path: "/ops/agents", name: "opsAgents", component: () => import("./views/Agents.vue") },
    { path: "/backup", name: "backup", component: () => import("./views/Backup.vue") },
    { path: "/config", name: "config", component: () => import("./views/Config.vue") },
    { path: "/:rest(.*)", name: "coming", component: () => import("./views/ComingSoon.vue") },
  ],
});

// 懒加载导航自愈（2026-08-29 M5 验收清单外发现 P2）：路由组件全部懒加载，chunk 拉取失败
// （面板重启窗口连接拒绝 / 重建后旧 hash 404）会被浏览器模块映射按 URL 缓存——之后每次
// 导航都静默中止（URL 不变、无提示），整页刷新才恢复。自愈：失败时定向整页刷新一次
// （新文档 = 新模块映射）；sessionStorage 按路由去重，同一路由只自动刷新一次防循环。
router.onError((error, to) => {
  const msg = error instanceof Error ? error.message : String(error);
  const importFailed = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
  const key = `gbrain-panel:nav-reload:${to.fullPath}`;
  if (importFailed && !sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, "1");
    window.location.hash = to.fullPath;
    window.location.reload();
  } else {
    console.error("[router] 导航失败:", error);
  }
});

export default router;
```

- [ ] **Step 2: 类型检查**

Run: `cd /d D:\gbrain-panel\web && node_modules\.bin\vue-tsc --noEmit`
Expected: 0 错误（web 无单测基建，行为验证走 README M6 验收清单条 5）

- [ ] **Step 3: 提交**

```bash
git add web/src/router.ts
git commit -m "fix: 懒加载 chunk 失败被模块映射缓存致导航永久失效——router.onError 定向整页刷新自愈"
```

---

### Task 4: retention 口径落定 + M-1 status 断言 + M-2 prune 容错 + Agents 时间列本地化

口径裁定（M5 验收条 5 后半 + m6-feedback 条 4）：**数值合法（含 0/负）→ 钳到 ≥1；非数/缺省 → 默认 5**。旧实现 `Math.floor(Number(x) || 5)` 把 0 当 falsy 回退 5，与文档「0 → 回 1」不符。

**Files:**
- Modify: `server/src/config.ts:48-50`（retention 归一口径）
- Modify: `server/src/backup.ts`（prune() rmSync 容错，M-2）
- Modify: `web/src/views/Agents.vue:56,60`（时间列 toLocaleString）
- Test: `server/test/config.test.ts`（retention 口径用例）、`server/test/app.test.ts`（M-1 status 断言）

**Interfaces:**
- Produces: `PanelConfig.backupRetention` 归一不变式——恒为 `Math.max(1, Math.floor(数值))` 或 `DEFAULTS.backupRetention`（5）

- [ ] **Step 1: 写失败测试（config.test.ts 新增；先看文件内既有 retention 用例，若有断言 0→5 的旧口径用例一并改掉）**

`server/test/config.test.ts` 新增（import 按文件现状补齐 `loadConfig`、`mkdtempSync/writeFileSync/rmSync`、`join`）：

```ts
describe("backupRetention 口径：0/负→1（钳制），非数/缺省→5（默认），小数→floor（M6）", () => {
  const loadWith = (raw: unknown): number => {
    const dir = mkdtempSync(join(import.meta.dir, ".tmp", "cfg-ret-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, JSON.stringify({ bootstrapToken: "t", ...(raw === undefined ? {} : { backupRetention: raw }) }));
      return loadConfig(p).backupRetention;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  test("0 → 1（钳制，不是回退默认）", () => expect(loadWith(0)).toBe(1));
  test("-3 → 1", () => expect(loadWith(-3)).toBe(1));
  test("2.9 → 2（floor）", () => expect(loadWith(2.9)).toBe(2));
  test("缺省 → 5（默认）", () => expect(loadWith(undefined)).toBe(5));
  test("非数 → 5（默认）", () => expect(loadWith("abc")).toBe(5));
});
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run: `cd /d D:\gbrain-panel && bun test server/test/config.test.ts`
Expected: FAIL —— `0 → 1` 与 `-3 → 1` 两个用例得 5（旧实现 `Number(0) || 5` 把 0 当缺省）；其余用例本就通过。

- [ ] **Step 3: 实现（config.ts 归一逻辑）**

`server/src/config.ts` 中第 48-50 行的注释与赋值替换为：

```ts
  // retention 口径（2026-08-29 M5 验收条 5 裁定）：数值合法（含 0/负）→ 钳到 ≥1；非数/缺省
  // （undefined/NaN/字符串等）→ 默认 5。旧实现 Number(x) || 5 把 0 也当缺省回 5，与文档
  // 「0 → 1」不符。放在 saveConfig 之前，缺 token 回写时落盘的也是归一后的合法值。
  const rawRetention = (parsed as { backupRetention?: unknown }).backupRetention;
  cfg.backupRetention = typeof rawRetention === "number" && Number.isFinite(rawRetention)
    ? Math.max(1, Math.floor(rawRetention))
    : DEFAULTS.backupRetention;
```

- [ ] **Step 4: 跑测试确认通过（绿）**

Run: `cd /d D:\gbrain-panel && bun test server/test/config.test.ts`
Expected: PASS

- [ ] **Step 5: 写 M-1 失败测试（app.test.ts 新增 describe）**

`server/test/app.test.ts` 末尾新增（import 区补 `createApp` 与 `../src/config` 的 `PanelConfig`、`../src/orchestrator` 的 `Orchestrator`、`../src/gbrain-client` 的 `GbrainClient`、`../src/backup` 的 `BackupManager` 的 type-only import）：

```ts
describe("/api/status backupRunning 直测（M-1）", () => {
  const mkApp = (backup?: { isRunning(): boolean }) => {
    const cfg = { panelPort: 0, gbrainPort: 0, backupDir: "unused" } as unknown as Parameters<typeof createApp>[0]["cfg"];
    const orch = { getState: () => "own", getEffectivePort: () => 3131, getRecentLogs: () => [] } as unknown as Orchestrator;
    const client = {} as GbrainClient;
    return createApp({ cfg, orch, client, backup: backup as unknown as BackupManager | undefined });
  };
  test("注入 isRunning()=true 的 backup → backupRunning:true", async () => {
    const res = await mkApp({ isRunning: () => true }).request("/api/status");
    expect((await res.json() as Record<string, unknown>).backupRunning).toBe(true);
  });
  test("未注入 backup → backupRunning:false", async () => {
    const res = await mkApp().request("/api/status");
    expect((await res.json() as Record<string, unknown>).backupRunning).toBe(false);
  });
});
```

注：`createApp` 的 status 路由只消费 `orch.getState/getEffectivePort/getRecentLogs` 与 `cfg.panelPort`、`backup?.isRunning()`，其余路由惰性不触发，stub 即可。

- [ ] **Step 6: 跑测试确认通过（本组为纯断言补齐，无实现改动；若因 stub 缺方法而失败，按错误补 stub 而非改产品代码）**

Run: `cd /d D:\gbrain-panel && bun test server/test/app.test.ts`
Expected: PASS（两条新用例 + 既有全绿）

- [ ] **Step 7: prune 容错（M-2）——backup.ts 的 prune() 替换为**

```ts
  private prune(): void {
    const dirs = readdirSync(this.deps.cfg.backupDir).filter(d => NAME_RE.test(d)).sort(); // 时间戳字典序 = 时间序
    const failed: string[] = [];
    while (dirs.length > this.deps.cfg.backupRetention) {
      const oldest = dirs.shift()!;
      try { rmSync(join(this.deps.cfg.backupDir, oldest), { recursive: true, force: true }); }
      catch { failed.push(oldest); } // 单份清理失败不阻断备份成功路径（M-2：错误信息友好化）
    }
    if (failed.length) console.warn(`[backup] 旧备份清理失败（保留策略未完全执行）：${failed.join(", ")}`);
  }
```

（无新增单测——rmSync 失败注入需要 OS 级句柄占用构造，成本高于收益；行为是“多warn不抛”，走代码评审把关。）

- [ ] **Step 8: Agents 时间列本地化——web/src/views/Agents.vue 两处 render 替换**

`agentColumns` 中「最近使用」列（原 56 行）：

```ts
  { title: "最近使用", key: "last_used_at", render: (a: Agent) => a.last_used_at ? new Date(a.last_used_at).toLocaleString() : "从未" },
```

`keyColumns` 中「签发时间」列（原 60 行）：

```ts
  { title: "签发时间", key: "created_at", render: (k: KeyRow) => k.created_at ? new Date(k.created_at).toLocaleString() : "" },
```

（与 Backup.vue「时间」列的 `new Date(x).toLocaleString()` 口径一致，替换原 `slice(0,19).replace("T"," ")` 手工截断。）

- [ ] **Step 9: 全量回归 + 双侧 tsc + 提交**

Run: `cd /d D:\gbrain-panel && bun test server/`（全绿）；`cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`；`cd /d D:\gbrain-panel\web && node_modules\.bin\vue-tsc --noEmit`（均 0 错误）

```bash
git add server/src/config.ts server/src/backup.ts server/test/config.test.ts server/test/app.test.ts web/src/views/Agents.vue
git commit -m "fix: retention 口径落定（0/负钳 1、非数回默认 5）+ status backupRunning 直测 + prune 容错 + Agents 时间列本地化"
```

---

### Task 5: offline 容忍逃生口——backupRunning 容忍设 60s 上限，防「备份中面板死掉 → online 永真」

背景（M6 backlog 条 3 + M5 验收清单外发现 2）：`connection.ts` 在 `backupRunning=true` 时对 status 拉取失败无限容忍（不算 offline）。若备份进行中面板进程死掉，前端永远显示在线。逃生口：连续失败计数达到上限（12 次 × 5s 轮询 ≈ 60s）后放弃容忍、诚实置 offline。展示规则同步裁定：后端短暂重启（1.5-5s 窗口）的「面板服务不可达」闪现属诚实行为，保留；备份窗口内（≤60s）不闪现；超 60s 视为面板下线。

**Files:**
- Modify: `web/src/stores/connection.ts`（全量替换）

**Interfaces:**
- Produces: store state 新增 `failStreak: number`（仅内部消费，无组件读取）

- [ ] **Step 1: 实现（connection.ts 全量替换为）**

```ts
import { defineStore } from "pinia";
import { api } from "../api/client";

export interface PanelStatus { state: string; effectivePort: number; panelPort: number; backupRunning?: boolean; logs: string[] }

// 备份窗口容忍上限：status 轮询 5s/次，连续 12 次（约 60s）失败即放弃容忍。备份（停 serve
// 复制）通常数秒~十几秒；60s 仍拉不到 status，更可能是「备份中面板死掉」而非备份本身——
// 诚实置 offline，防 online 永真（M6 逃生口）。
const BACKUP_TOLERANCE_MAX_FAILURES = 12;

export const useConnection = defineStore("connection", {
  state: () => ({
    online: false,
    status: null as PanelStatus | null,
    backupRunning: false,
    failStreak: 0,
  }),
  actions: {
    async refresh() {
      try {
        this.status = await api<PanelStatus>("/status");
        this.backupRunning = this.status.backupRunning ?? false;
        this.online = true;
        this.failStreak = 0;
      } catch {
        this.failStreak++;
        // 备份进行中会停 serve/阻塞响应，status 拉取失败不算离线（容忍取自最近一次成功响应的
        // backupRunning）；逃生口：容忍有上限——连续超限仍失败则视为面板真下线
        if (!this.backupRunning || this.failStreak >= BACKUP_TOLERANCE_MAX_FAILURES) this.online = false;
      }
    },
  },
});
```

- [ ] **Step 2: 类型检查**

Run: `cd /d D:\gbrain-panel\web && node_modules\.bin\vue-tsc --noEmit`
Expected: 0 错误（行为验证走 README M6 验收清单条 7）

- [ ] **Step 3: 提交**

```bash
git add web/src/stores/connection.ts
git commit -m "fix: backupRunning 容忍设 60s 上限（连续 12 次失败置 offline），防备份中面板死掉后前端永显在线"
```

---

### Task 6: 文档——README「M6 验收清单」+ backlog 处置标注

**Files:**
- Modify: `README.md`（追加「M6 验收清单」一节；保留既有 M5 及以前章节）
- Modify: `docs/superpowers/plans/2026-08-28-m6-backlog.md`（文末追加处置结果）

**Interfaces:**
- Consumes: Task 1-5 的实际落地行为

- [ ] **Step 1: README 追加「M6 验收清单」一节（置于 M5 验收清单之后）**

```markdown
## M6 验收清单（2026-08-29）

> 前置：`bun run build:web` 重建前端 + 重启面板（备份/SSE/状态逻辑均需重启后端生效）。

1. **备份红线（M5 条 1 重测）**：own 态点「立即备份」→ 成功提示 + 列表出现新份；到
   `D:\gbrain-backup\<名称>\brain.pglite\` 核对 PG_VERSION、base/ 等真实数据库文件与体积
   （40+ MB，列表有条目不算数）；产物内无 sock/lock/postmaster.pid；结束后顶栏恢复 own、页面库可查。
2. **外部 serve 抢占仍拒绝（回归）**：外部 `gbrain serve --http` 占 3131 时（foreign 态）点备份 → 503 拒绝文案，无备份产生。
3. **SSE 空闲稳定**：请求日志页开实时流后挂起 ≥60s——不出现「连接中断，自动重连中…」循环闪现（心跳生效）。
4. **SSE 恢复补插（M5 缺陷 B 补测）**：重启面板后端，实时流自动重连；随后触发一次 MCP 操作（如页面库刷新），新事件应自动插入列表头部，无需手动停止/重开。
5. **导航自愈**：打开面板 → 重启面板后端 → 趁后端未恢复点一个本会话未访问过的路由（如「配置」）→ 应自动整页刷新并落在该路由（而非永久点不动）。
6. **retention 口径**：config.json 改 `backupRetention: 0` → 重启 → 配置页显示 1；删掉该字段 → 重启 → 显示 5。
7. **offline 逃生口**：own 态点「立即备份」，备份横幅出现后立刻强杀面板进程 → 约 60s 内出现「面板服务不可达」覆盖层（不再无限容忍）。
8. **Agents 时间列**：最近使用/签发时间以本地化格式（toLocaleString）显示，与备份页一致。
```

- [ ] **Step 2: backlog 文末追加处置结果**

`docs/superpowers/plans/2026-08-28-m6-backlog.md` 文末追加：

```markdown

## 处置结果（2026-08-29 M6 执行，计划见 2026-08-29-gbrain-panel-m6-acceptance-fixes.md）

- 条 1（readLockStatus 竞态兜底 I-1）→ 已修（M6 Task 1）
- 条 2（killServe taskkill 退出码验尸）→ **被取代**：活锁判据改为持锁进程存活探测（isPidAlive），存活即事实源，taskkill 退出码不再必要（M6 Task 1，留痕更新）
- 条 3（backupRunning 容忍逃生口）→ 已修：连续 12 次失败（约 60s）置 offline（M6 Task 5）
- 条 4（M-1 status backupRunning 直测）→ 已补（M6 Task 4）
- 条 5（M-2 prune 容错 / M-3 活锁中止断言 start() 被调用）→ 已修/已补（M6 Task 4 / Task 1）
- 条 6（Agents toLocaleString / retention 测试细化）→ 已修/已补（M6 Task 4）
- M5 验收新增 4 条（P0 活锁 exec 层穿透 / P1 SSE 心跳 / P2 导航失效 / retention 口径）→ 已修（M6 Task 1 / 2 / 3 / 4），见 2026-08-29-m5-acceptance-report.md 与 2026-08-29-m6-feedback.md
```

- [ ] **Step 3: 提交**

```bash
git add README.md docs/superpowers/plans/2026-08-28-m6-backlog.md
git commit -m "docs: M6 验收清单与 backlog 处置标注"
```

---

## Self-Review 记录

- **覆盖核对**：m6-feedback 4 条（P0→Task 1、P1→Task 2、P2→Task 3、口径→Task 4）✓；m6-backlog 6 条（1→Task 1、2→被 Task 1 取代、3→Task 5、4→Task 4、5→Task 4/1、6→Task 4）✓；M5 验收清单外发现 2（offline 闪现）→ Task 5 展示规则 + README 条 7 ✓；缺陷 B（SSE 恢复补插）→ README 条 4 验收用例 ✓。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`isPidAlive(pid: number): boolean` 定义（Task 1 Step 3）与消费（backup.ts）一致；`failStreak`、`BACKUP_TOLERANCE_MAX_FAILURES` 仅 Task 5 内部；Task 4 的 `mkApp` stub 与 `createApp` 实际消费字段对齐（已核 app.ts:19-20）。
- **已知残留风险（留痕）**：PID 复用窗口内假活 → 保守中止（方向安全）；「尸锁放行」用例理论上存在 dead.pid 被新进程复用的毫秒级窗口（概率可忽略）；prune rmSync 失败路径无单测（OS 级句柄占用构造成本高，评审把关）。
