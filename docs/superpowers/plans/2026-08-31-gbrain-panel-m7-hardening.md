# gbrain-panel M7（优化轮：key 治理 + 备份健壮性 + 异步复制 + 前端复位）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 M7 backlog 五个优先项——key 签发 single-flight（防同名 active key 同秒累积）、备份完整性标记 BACKUP_OK（残缺目录可辨识可清理）、备份复制异步分片化（消除 cpSync 阻塞事件循环 5-10s）、备份页 running tag 复位 + router 结构化埋点与自愈键清除。

**Architecture:** key 竞态用 in-flight Promise 共享（并发首调只签一次，revoke-before-issue 语义不变）；完整性标记体系用「目录内 BACKUP_OK 文件 + backupDir 根一次性别名收养文件」——升级前既有目录一次性收养（宁滥勿删），升级后无标记目录即复制中断残缺品，启动时清理；复制从 cpSync 整树同步改为逐文件 copyFileSync + 每条目 setImmediate 让路，filter/EBUSY 重试语义保持；前端 Backup.vue 的 running 态从「POST 生命周期独占」改为「失败即复位 + 超时兜底」。

**Tech Stack:** Bun + Hono（server）、Vue 3 + vue-router 4（web）、bun:test。

## Global Constraints

- 工作目录 `D:\gbrain-panel`，分支 `m7-hardening`（基于 main@88297b3）。
- **严禁修改 `D:\gbrain-stock` 内任何文件**（gbrain 源码仅作只读参考）。
- 测试临时文件只写 `server/test/.tmp/`，**严禁写系统盘临时目录**（%TEMP% 等）。
- **不运行** `bun run build:web`、`bun run dev:server`、vite、dev server——构建/重启由用户手动执行；验证只跑测试与类型检查。
- 类型检查命令固定：server 用 `cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`；web 用 `cd /d D:\gbrain-panel\web && node_modules\.bin\vue-tsc --noEmit`（**禁用 bunx**）。
- 测试命令：`cd /d D:\gbrain-panel && bun test server/`（当前基线 99/99 全绿）。
- 本机 3131 端口可能有用户自己的 gbrain serve，**绝不得触碰**；集成测试用 fake 替身端口。
- git push 只在终审后由主会话执行（走代理 `http://127.0.0.1:7897`），任务内只 commit 不 push。
- 提交信息用中文 conventional commits。
- web 侧无单测基建（本里程碑不引入）：Task 4 以 vue-tsc + 用户真机验收清单验证；server 侧全部 TDD 红绿。
- **删除安全红线**：本计划的所有删除（残缺备份清理）只作用于 `cfg.backupDir` 下、`NAME_RE` 匹配、**无 BACKUP_OK 标记**的目录，且升级收养先行（既有目录先补标记再启用清理）——任何情况下不得删除有标记的完整备份。

---

### Task 1: GbrainClient key 签发 single-flight（P1：防同名 active key 同秒累积）

背景（M6 验收范围外观察③，根因已核实）：`mcpRequest` 的签发块 `if (!this.apiKey) { this.apiKey = await this.issueApiKey(...) }` 无并发去重。面板启动时仪表盘并发请求 stats/health-indicators/full-stats 等多个接口，多个 `mcpRequest` 同时看到 `apiKey === null`，各自执行「先撤后签」——所有撤销都发生在任何签发落地之前，同秒产生 N 条同名 active key（验收现场实证 3 条）。修法：in-flight Promise 共享（single-flight）。升级后首次 mcpRequest 的 revoke-before-issue 会把机器上已有的 3 条累积 key 一并清掉。

**Files:**
- Modify: `server/src/gbrain-client.ts:17-21`（新增字段）、`server/src/gbrain-client.ts:90-97`（签发块）
- Test: `server/test/gbrain-client.test.ts`（新增 1 用例）

**Interfaces:**
- Produces: 无对外接口变化；`GbrainClient` 行为契约——并发首次 mcpRequest 只触发一次 `POST /admin/api/api-keys`（及一次 revoke），后续共用同一把 key。

- [ ] **Step 1: 写失败测试（gbrain-client.test.ts 的 describe("GbrainClient") 内新增）**

```ts
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
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run: `cd /d D:\gbrain-panel && bun test server/test/gbrain-client.test.ts`
Expected: FAIL —— `active.length` 得 3（并发竞态真实发作），`expect(...).toBe(1)` 不成立。

- [ ] **Step 3: 实现（gbrain-client.ts）**

类字段区（`private apiKey: string | null = null;` 之后）新增：

```ts
  // key 签发 single-flight（M7）：并发首次调用共享同一 in-flight Promise，防止
  // 多个 mcpRequest 同时看到 apiKey===null 各自「先撤后签」造成同名 active 累积
  private keyInFlight: Promise<string> | null = null;
```

`mcpRequest` 的签发块（原 93-97 行）替换为：

```ts
    let issuanceError: unknown = null;
    if (!this.apiKey) {
      // single-flight：面板启动时多个数据接口并发首调，无去重会让「先撤后签」交错——
      // 撤销全部落在任何签发落地之前，同秒产生 N 条同名 active key（M6 验收实证 3 条）
      if (!this.keyInFlight) {
        this.keyInFlight = this.issueApiKey("gbrain-panel").finally(() => { this.keyInFlight = null; });
      }
      try { this.apiKey = await this.keyInFlight; }
      catch (e) { issuanceError = e; this.apiKey = null; }
    }
```

- [ ] **Step 4: 跑测试确认通过（绿）**

Run: `cd /d D:\gbrain-panel && bun test server/test/gbrain-client.test.ts`
Expected: PASS（新用例 active.length===1、签发调用 1 次；既有 9 个用例不回归）

- [ ] **Step 5: 全量回归 + tsc + 提交**

Run: `cd /d D:\gbrain-panel && bun test server/`（全绿）；`cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`（0 错误）

```bash
git add server/src/gbrain-client.ts server/test/gbrain-client.test.ts
git commit -m "fix: key 签发 single-flight——并发首调共享 in-flight Promise，防同名 active key 同秒累积"
```

---

### Task 2: 备份完整性标记 BACKUP_OK + 残缺清理 + 升级收养 + remove() 容错（P2）

背景（M6 验收范围外观察② + 条7 留档 + M6 终审遗留 Minor）：产物目录名即"完成"语义，强杀/断电后的残缺目录与完整目录无法区分（现场 1 份 12.8MB 残缺计入 retention=5 名额）。方案（验收人建议）：复制完成后写 `BACKUP_OK` 标记文件；列表与 retention 只认标记；启动时清理无标记残缺目录。**迁移安全**：升级前既有的无标记目录（含 4 份真实备份与 1 份历史残缺）必须先一次性收养（补标记，宁滥勿删），用 backupDir 根的收养哨兵文件区分升级前后——绝不能直接把无标记目录当残缺删掉（那会删掉用户仅有的真实备份）。

**Files:**
- Modify: `server/src/backup.ts`（常量、构造器、list、run、prune、remove）
- Test: `server/test/backup.test.ts`（新增 3 用例 + 修 retention 用例种子）

**Interfaces:**
- Produces: `BackupInfo` 形状不变；行为契约——`list()` 只返回含 `BACKUP_OK` 的目录；`run()` 成功路径产物必含 `BACKUP_OK`（写标记失败按备份失败处理）；构造时执行一次性收养/清理（失败仅告警不抛）。
- 常量：`MARKER_FILE = "BACKUP_OK"`（备份目录内）、`SCHEMA_SENTINEL = ".gbrain-panel-marker-v1"`（backupDir 根，收养完成哨兵）。

- [ ] **Step 1: 写失败测试（backup.test.ts 新增 describe；先读现有 retention 用例）**

文件顶部 import 区补 `writeFileSync`（`node:fs` 已 import 其它符号，同行追加）。`describe("BackupManager")` 之后新增：

```ts
describe("备份完整性标记 BACKUP_OK（M7）", () => {
  test("成功备份产物含 BACKUP_OK；无标记目录不出现在列表", async () => {
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    const r = await bm.run();
    expect(existsSync(join(backupDir, r.name, "BACKUP_OK"))).toBe(true);
    // 构造后新增的无标记目录 = 升级后残缺品，列表不认（清理在下次构造时发生）
    mkdirSync(join(backupDir, "gbrain-backup-20260101-000000"), { recursive: true });
    writeFileSync(join(backupDir, "gbrain-backup-20260101-000000", "x"), "x");
    const names = bm.list().map(b => b.name);
    expect(names).toContain(r.name);
    expect(names).not.toContain("gbrain-backup-20260101-000000");
  });

  test("升级收养：无哨兵时既有目录全部补标记（宁滥勿删）并写哨兵", () => {
    // beforeEach 建的是全新空 backupDir，先手工造"升级前"现场：2 个无标记既有目录、无哨兵
    for (const ts of ["20260101-000000", "20260102-000000"]) {
      mkdirSync(join(backupDir, `gbrain-backup-${ts}`), { recursive: true });
      writeFileSync(join(backupDir, `gbrain-backup-${ts}`, "data"), "d");
    }
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    expect(existsSync(join(backupDir, "gbrain-backup-20260101-000000", "BACKUP_OK"))).toBe(true);
    expect(existsSync(join(backupDir, "gbrain-backup-20260102-000000", "BACKUP_OK"))).toBe(true);
    expect(existsSync(join(backupDir, ".gbrain-panel-marker-v1"))).toBe(true);
    expect(bm.list().length).toBe(2); // 收养后全部可见
  });

  test("残缺清理：有哨兵时构造即清理无标记目录，有标记的保留", () => {
    writeFileSync(join(backupDir, ".gbrain-panel-marker-v1"), new Date().toISOString()); // 先写哨兵 = 已收养状态
    mkdirSync(join(backupDir, "gbrain-backup-20260101-000000"), { recursive: true }); // 无标记 = 残缺
    writeFileSync(join(backupDir, "gbrain-backup-20260101-000000", "half"), "h");
    mkdirSync(join(backupDir, "gbrain-backup-20260102-000000"), { recursive: true }); // 有标记 = 完整
    writeFileSync(join(backupDir, "gbrain-backup-20260102-000000", "BACKUP_OK"), new Date().toISOString());
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    expect(existsSync(join(backupDir, "gbrain-backup-20260101-000000"))).toBe(false); // 残缺被清
    expect(existsSync(join(backupDir, "gbrain-backup-20260102-000000"))).toBe(true);  // 完整保留
    expect(bm.list().map(b => b.name)).toEqual(["gbrain-backup-20260102-000000"]);
  });
});
```

同时修改既有用例「保留策略：超份数删最旧」的种子——3 个伪早份数据各补标记（否则 prune 不认、断言失败）：

```ts
    for (const ts of ["20260101-000000", "20260102-000000", "20260103-000000"]) {
      mkdirSync(join(backupDir, `gbrain-backup-${ts}`), { recursive: true });
      writeFileSync(join(backupDir, `gbrain-backup-${ts}`, "BACKUP_OK"), new Date().toISOString());
    }
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run: `cd /d D:\gbrain-panel && bun test server/test/backup.test.ts`
Expected: FAIL —— 新 3 用例全挂（无 BACKUP_OK 写入/无收养/无清理）；retention 用例也挂（prune 尚未按标记过滤，或种子修改后行为不变——以实际输出为准记录）。

- [ ] **Step 3: 实现（backup.ts）**

import 行补 `writeFileSync`。`NAME_RE` 常量之后新增：

```ts
// 完整性标记（M7）：复制完成后写 BACKUP_OK（单次小文件写入，存在即完整）；列表与 retention
// 只认标记。升级收养哨兵写在 backupDir 根：无哨兵 = 升级前的既有目录（无标记语义，无从区分
// 残缺）→ 一次性全部补标记收养（宁滥勿删，残缺的历史份靠 retention 轮替消化）；有哨兵 =
// 升级后 → 无标记目录只能是复制中断的残缺品，构造时清理。
const MARKER_FILE = "BACKUP_OK";
const SCHEMA_SENTINEL = ".gbrain-panel-marker-v1";
```

构造器替换为：

```ts
  constructor(
    private deps: { cfg: PanelConfig; orch: Orchestrator; client: GbrainClient },
    private opts: { copyDir?: (src: string, dest: string) => void } = {},
  ) {
    // 启动迁移：收养/清理只碰 backupDir 下 NAME_RE 匹配且（清理时）无标记的目录；
    // 任何失败仅告警——备份目录异常不得阻断面板启动
    try { this.ensureMarkerSchema(); } catch (e) { console.warn(`[backup] 标记体系迁移异常（忽略）：${String(e)}`); }
  }

  private ensureMarkerSchema(): void {
    const dir = this.deps.cfg.backupDir;
    if (!existsSync(dir)) return;
    const sentinel = join(dir, SCHEMA_SENTINEL);
    const dirs = readdirSync(dir).filter(d => NAME_RE.test(d));
    if (!existsSync(sentinel)) {
      let adopted = 0;
      for (const d of dirs) {
        const marker = join(dir, d, MARKER_FILE);
        if (!existsSync(marker)) { writeFileSync(marker, new Date().toISOString()); adopted++; }
      }
      writeFileSync(sentinel, new Date().toISOString());
      if (adopted > 0) console.log(`[backup] 完整性标记收养：${adopted} 个既有备份目录补写 ${MARKER_FILE}`);
    } else {
      for (const d of dirs) {
        if (!existsSync(join(dir, d, MARKER_FILE))) {
          try { rmSync(join(dir, d), { recursive: true, force: true }); console.warn(`[backup] 清理无 ${MARKER_FILE} 标记的残缺目录：${d}`); }
          catch { /* 句柄占用等：下轮启动再试 */ }
        }
      }
    }
  }
```

`list()` 的过滤行改为：

```ts
    return readdirSync(this.deps.cfg.backupDir)
      .filter(d => NAME_RE.test(d) && existsSync(join(this.deps.cfg.backupDir, d, MARKER_FILE)))
```

`run()` 的复制 try 块内、`await this.copyDataDir(...)` 之后新增（同一 try 内，写标记失败走既有 catch 清理+重启）：

```ts
        // 复制完成后写完整性标记：强杀/断电后无标记即残缺（列表/retention 只认标记）；
        // 写失败按备份失败处理（catch 清理残缺目录并 best-effort 重启 serve）
        writeFileSync(join(dest, MARKER_FILE), new Date().toISOString());
```

`prune()` 的 dirs 行改为：

```ts
    const dirs = readdirSync(this.deps.cfg.backupDir)
      .filter(d => NAME_RE.test(d) && existsSync(join(this.deps.cfg.backupDir, d, MARKER_FILE)))
      .sort(); // 时间戳字典序 = 时间序
```

`remove()` 的 rmSync 段改为（M6 终审遗留 Minor：删除失败不裸抛）：

```ts
    try { rmSync(p, { recursive: true, force: true }); return true; }
    catch (e) { console.warn(`[backup] 删除备份失败（${name}）：${String(e)}`); return false; }
```

- [ ] **Step 4: 跑测试确认通过（绿）**

Run: `cd /d D:\gbrain-panel && bun test server/test/backup.test.ts`
Expected: PASS（新 3 用例 + 既有全部用例绿；「filter 排除」「活锁」等用例不受影响——它们断言 PG_VERSION/产物结构，多一个 BACKUP_OK 文件无碍）

- [ ] **Step 5: 全量回归 + tsc + 提交**

Run: `cd /d D:\gbrain-panel && bun test server/`（全绿）；`cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`（0 错误）

```bash
git add server/src/backup.ts server/test/backup.test.ts
git commit -m "feat: 备份完整性标记 BACKUP_OK——列表/retention 只认标记，启动清理残缺目录，升级既有目录一次性收养"
```

---

### Task 3: 备份复制异步分片化——消除 cpSync 阻塞事件循环（P3）

背景（M6 验收条 7 过程留档实证）：`cpSync` 整树复制期间面板事件循环被阻塞 5-10s，`/api/status` 完全无法应答（请求排队），横幅/逃生口的外部可观察性差。改为逐文件 `copyFileSync` + 每个条目后 `setImmediate` 让路——备份期间 status 可应答。filter 语义（`isRuntimeArtifact` 条目级排除，目录级跳过含其内容）与 EBUSY/EPERM 重试语义保持（整树重试改为单文件级重试，更精准）。

**Files:**
- Modify: `server/src/backup.ts`（import 行 `cpSync` → `copyFileSync`；`copyDataDir` 重写 + 新增两个私有方法）
- Test: `server/test/backup.test.ts`（新增 1 用例；import 补 `readFileSync`）

**Interfaces:**
- Consumes: Task 2 的 `MARKER_FILE`（run() 调用点不变，仅复制内部实现更换）
- Produces: `copyDataDir(src, dest): Promise<void>` 签名不变；`opts.copyDir` 注入点签名 `(src, dest) => void` 不变（注入替身替换整个复制动作的既有测试继续有效）。

- [ ] **Step 1: 写测试（backup.test.ts「备份完整性标记」describe 之后新增；先确认红/绿的判定方式）**

```ts
describe("分片复制（M7 异步化）", () => {
  test("嵌套多文件递归复制，内容逐字节一致", async () => {
    mkdirSync(join(home, ".gbrain", "sub", "deep"), { recursive: true });
    writeFileSync(join(home, ".gbrain", "sub", "a.txt"), "A");
    writeFileSync(join(home, ".gbrain", "sub", "deep", "b.bin"), Buffer.from([1, 2, 3]));
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    const r = await bm.run();
    const dest = join(backupDir, r.name);
    expect(readFileSync(join(dest, "sub", "a.txt"), "utf8")).toBe("A");
    expect(Array.from(readFileSync(join(dest, "sub", "deep", "b.bin")))).toEqual([1, 2, 3]);
  });
});
```

（此用例在旧 cpSync 实现下本就通过——它钉住的是重写后的行为等价性，防止异步化引入递归/内容损坏回归；事件循环让路无确定性单测构径【setImmediate 全局桩替换在 bun:test 下不可靠】，由代码评审 + 验收清单条 5 把关。）

- [ ] **Step 2: 跑测试确认当前通过（基线锚点）**

Run: `cd /d D:\gbrain-panel && bun test server/test/backup.test.ts`
Expected: PASS（新用例在 cpSync 下即绿——记录为行为等价性基线）。

- [ ] **Step 3: 实现（backup.ts）**

import 行：`cpSync` 改为 `copyFileSync`。`copyDataDir` 及其上方注释整体替换为：

```ts
  /** 复制数据目录（M7 异步分片版）：cpSync 整树复制会阻塞事件循环 5-10s（M6 验收实证：
   *  期间 /api/status 完全无应答、请求排队），改为逐文件 copyFileSync + 每个条目后 setImmediate
   *  让路——备份期间 status/前端轮询正常应答。filter 语义不变（isRuntimeArtifact 条目级排除，
   *  目录级跳过含其全部内容）；EBUSY/EPERM 句柄竞态从整树重试改为单文件级重试一次（更精准）。
   *  opts.copyDir 为整个复制动作的测试替身注入点（替换后无 filter/重试/让路语义——注入用例自担）。 */
  private async copyDataDir(src: string, dest: string): Promise<void> {
    if (this.opts.copyDir) { this.opts.copyDir(src, dest); return; }
    await this.copyTree(src, dest);
  }

  private async copyTree(srcDir: string, destDir: string): Promise<void> {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const s = join(srcDir, entry.name);
      if (isRuntimeArtifact(s)) continue; // 与旧 cpSync filter 同语义：条目级排除
      const d = join(destDir, entry.name);
      if (entry.isDirectory()) await this.copyTree(s, d);
      else await this.copyOneFile(s, d);
      await new Promise<void>(r => setImmediate(r)); // 事件循环让路：单文件粒度（大文件仍可能短暂阻塞，可接受）
    }
  }

  private async copyOneFile(s: string, d: string): Promise<void> {
    try { copyFileSync(s, d); }
    catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EBUSY" && code !== "EPERM") throw e;
      await new Promise(r => setTimeout(r, 300));
      copyFileSync(s, d); // 仍失败上抛 → run() 的 catch 走残缺清理 + best-effort 重启
    }
  }
```

- [ ] **Step 4: 跑测试确认通过（绿，含 Task 2 全部标记用例不回归）**

Run: `cd /d D:\gbrain-panel && bun test server/test/backup.test.ts`
Expected: PASS（含「filter 排除 sock/lock 簇/postmaster.pid」「cpSync 失败清理」「标记」全部用例——filter 测试证明 walk 的条目级排除与旧 filter 等价）。

- [ ] **Step 5: 全量回归 + tsc + 提交**

Run: `cd /d D:\gbrain-panel && bun test server/`（全绿）；`cd /d D:\gbrain-panel\server && node_modules\.bin\tsc --noEmit`（0 错误）

```bash
git add server/src/backup.ts server/test/backup.test.ts
git commit -m "perf: 备份复制异步分片化——逐文件 copyFileSync + setImmediate 让路，消除事件循环 5-10s 阻塞"
```

---

### Task 4: 前端小修——备份 running 复位 + router 结构化埋点 + 自愈键清除（P4/P5 + 候选池）

背景：①（M6 验收范围外观察④）面板死亡时 POST /backups 永不返回/挂起，备份页「备份进行中」tag 永久滞留（刷新才恢复）；②（观察①）健康后端下导航静默中止一次、无诊断信息——router.onError 的 else 分支仅 console.error 原始错误，缺结构化上下文；③（M6 终审候选池，验收条 5 已复现）导航自愈 sessionStorage 键成功后不清除，同路由第二次真失败不再自愈。

**Files:**
- Modify: `web/src/views/Backup.vue`（runBackup 超时 + load 失败复位）
- Modify: `web/src/router.ts`（onError 结构化 + afterEach 清键）

**Interfaces:**
- Consumes: Task 3 后备份期间 `/backups` GET 可应答（事件循环不再阻塞）——load() 在备份中也能拿到真实 running 态。
- Produces: 无接口变化；行为契约见步骤代码。

- [ ] **Step 1: 实现（Backup.vue）**

`runBackup` 与 `load` 两个函数替换为：

```ts
async function load() {
  try { const j = await api<{ running: boolean; backups: BackupInfo[] }>("/backups"); running.value = j.running; backups.value = j.backups; }
  catch (e) {
    message.error(String(e));
    // 面板不可达时无从确认备份进行中——复位防「备份进行中」tag 永久滞留（M6 验收范围外观察④）；
    // 备份真实进行中时（M7 起复制不阻塞事件循环）本请求可正常应答，不会走到这里
    running.value = false;
  }
}

async function runBackup() {
  running.value = true; // 请求期间先禁用按钮，结束后以 load() 的服务端状态为准
  try { const r = await api<BackupInfo>("/backups", { method: "POST", signal: AbortSignal.timeout(120_000) }); message.success(`备份完成：${r.name}`); }
  catch (e) { message.error(String(e)); }
  finally { await load(); }
}
```

（`AbortSignal.timeout` 兜底：面板死亡致连接悬挂时，120s 后 POST 强制落败 → finally load() → catch 复位 running。）

- [ ] **Step 2: 实现（router.ts）**

`router.onError` 钩子替换为（路由表与其余内容不动）：

```ts
// 懒加载导航自愈（2026-08-29 M5 验收清单外发现 P2）：路由组件全部懒加载，chunk 拉取失败
// （面板重启窗口连接拒绝 / 重建后旧 hash 404）会被浏览器模块映射按 URL 缓存——之后每次
// 导航都静默中止（URL 不变、无提示），整页刷新才恢复。自愈：失败时定向整页刷新一次
// （新文档 = 新模块映射）；sessionStorage 按路由去重，同一路由只自动刷新一次防循环。
// 非 chunk 失败的导航错误：结构化落 console（M6 验收范围外观察①——健康后端下偶发一次
// 静默中止，先埋点拿到发生条件再定修法）。
router.onError((error, to) => {
  const msg = error instanceof Error ? error.message : String(error);
  const importFailed = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
  const key = `gbrain-panel:nav-reload:${to.fullPath}`;
  if (importFailed && !sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, "1");
    window.location.hash = to.fullPath;
    window.location.reload();
  } else {
    console.error("[router] 导航失败:", {
      to: to.fullPath,
      name: error instanceof Error ? error.name : typeof error,
      message: msg,
      time: new Date().toISOString(),
    });
  }
});

// 成功到达某路由后清除其自愈守卫键：同一路由未来再次发生 chunk 失败时仍能再自愈一次
// （否则同标签页会话内第二次真失败只能手动刷新——M6 验收条5复现的候选池项）
router.afterEach((to) => {
  sessionStorage.removeItem(`gbrain-panel:nav-reload:${to.fullPath}`);
});
```

- [ ] **Step 3: 类型检查**

Run: `cd /d D:\gbrain-panel\web && node_modules\.bin\vue-tsc --noEmit`
Expected: 0 错误（行为验证走 README M7 验收清单条 6/7/8）

- [ ] **Step 4: 提交**

```bash
git add web/src/views/Backup.vue web/src/router.ts
git commit -m "fix: 备份 running 态失败复位+POST 超时兜底；router 导航错误结构化埋点；自愈键成功导航后清除"
```

---

### Task 5: 文档——README「M7 验收清单」+ backlog 处置标注

**Files:**
- Modify: `README.md`（M6 验收清单节之后、「里程碑」节之前插入 M7 节）
- Modify: `docs/superpowers/plans/2026-08-31-m7-backlog.md`（文末追加处置结果）

- [ ] **Step 1: README 插入「M7 验收清单（2026-08-31）」一节（逐字）**

```markdown
## M7 验收清单（2026-08-31）

> 前置：`bun run build:web` 重建前端 + 重启面板。首次启动会在面板终端看到
> `[backup] 完整性标记收养：N 个既有备份目录补写 BACKUP_OK`（N 为当前备份数，含 M6 遗留的
> 残缺份 040311——若想淘汰它，请在升级前于备份页手动删除，否则按完整份占用 retention 名额直至轮替）。

1. **key 治理**：面板启动并打开任一数据页（触发签 key）后，Agents 页 `gbrain-panel` 的 active
   key 应为 **1**（升级前机器上累积的 3 条会被「签发前先撤同名」一并清掉）。
2. **备份完整性**：own 态「立即备份」成功 → 备份页列表出现新份；到
   `D:\gbrain-backup\<名称>\` 核对存在 `BACKUP_OK` 文件 + `brain.pglite\` 真实数据库文件
   （40+ MB，红线常规）。
3. **升级收养**：首次启动后既有备份全部仍在列表中（被收养）；`D:\gbrain-backup` 根出现
   `.gbrain-panel-marker-v1` 哨兵文件。
4. **残缺清理**：再次点「立即备份」，复制进行中（横幅在场）强杀面板 → 残缺目录留存；
   重启面板 → 该残缺目录被自动清理（列表与磁盘均无）。
5. **备份期可观察**：备份进行中访问 `http://127.0.0.1:7070/api/status` 应秒回
   （`backupRunning:true`）——不再有 5-10s 无应答冻结；备份页横幅按真实状态出现/消失。
6. **备份 tag 复位**：备份中强杀面板 → 备份页「备份进行中」tag 在面板确认不可达后清除
   （POST 超时兜底最长 120s；直接刷新页面也应立即复位）。
7. **导航观察**：正常使用多次导航，console 无 `[router] 导航失败` 噪音；若再现静默中止，
   该日志应含 `to/name/message/time` 结构化字段（截图留证即完成观察目标）。
8. **自愈键复用（可选）**：触发一次导航自愈（M6 条 5 两段式）后，`sessionStorage` 中该路由的
   `gbrain-panel:nav-reload:*` 键在成功导航后被清除（devtools 可见）——同路由第二次失败仍能自愈。
```

- [ ] **Step 2: backlog 文末追加处置结果（逐字）**

```markdown

## 处置结果（2026-08-31 M7 执行，计划见 2026-08-31-gbrain-panel-m7-hardening.md）

- 条 1（key 累积）→ 已修：签发 single-flight，并发首调共享 in-flight Promise（M7 Task 1）
- 条 2（备份目录健壮性）→ 已修：BACKUP_OK 标记 + 启动清理残缺 + 升级一次性收养 + remove() 容错（M7 Task 2）
- 条 3（cpSync 阻塞）→ 已修：逐文件复制 + setImmediate 让路，status 备份期可应答（M7 Task 3）
- 条 4（导航静默中止）→ 埋点就位：router.onError 结构化日志（M7 Task 4），发生条件待真机观察
- 条 5（备份 tag 滞留）→ 已修：load 失败复位 + POST 120s 超时兜底（M7 Task 4）
- 候选池（自愈键不清除）→ 已修：router.afterEach 成功导航后清键（M7 Task 4）
```

- [ ] **Step 3: 提交**

```bash
git add README.md docs/superpowers/plans/2026-08-31-m7-backlog.md
git commit -m "docs: M7 验收清单与 backlog 处置标注"
```

---

## Self-Review 记录

- **覆盖核对**：m7-backlog 建议修 5 条 → Task 1/2/3/4（埋点）/4（tag）；候选池「自愈键清除」→ Task 4；「remove() rmSync 容错」→ Task 2。验收报告第五节建议（BACKUP_OK 原子标记、分片让路、埋点）全部落位。✓
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`MARKER_FILE`/`SCHEMA_SENTINEL` 定义于 Task 2、消费于 Task 2（list/run/prune）；Task 3 消费 `isRuntimeArtifact`（既有导出）；`copyDataDir`/`opts.copyDir` 签名跨任务不变；Task 4 消费 Task 3 的可应答性（注释性依赖，无代码耦合）。
- **已知残留（留痕）**：①事件循环让路无确定性单测（setImmediate 全局桩在 bun:test 下不可靠），评审 + 验收条 5 把关；②marker 写入非严格原子（崩溃在 writeFileSync 中途仍可能留下半截标记文件——内容无意义，存在即完整，风险可忽略）；③收养会把升级前的历史残缺份（040311）按完整收养，README 前置说明已给出升级前手动删除的建议；④EBUSY 单文件重试无直接单测（OS 句柄占构造成本高，沿袭 M4/M5 评审把关惯例）。
