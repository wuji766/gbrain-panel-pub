# gbrain 面板 M5（备份 P0 修复 + 打磨轮）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复备份真机 P0（cpSync 撞套接字文件 EACCES——按源码定论排除四类运行时工件）、失败残缺清理与活锁检查，消化 M4 终审与验收的全部建议修项（retention 下限、掩蔽测试、轮询降载、UI 打磨、stats 口径标注）。

**Architecture:** 备份复制加 filter（sock/lock 簇/postmaster.pid 恢复安全排除）+ catch 清理残缺目录 + 复制前用 readLockStatus 活锁探测；backupRunning 并入 /api/status（消除 /api/backups 高频轮询的磁盘 IO）；其余为小修与标注。

**Tech Stack:** 沿用。无新依赖。

## Global Constraints（与前序相同，逐字有效）

- 平台 Windows；所有网络监听仅 127.0.0.1。
- **严禁修改 `D:\gbrain-stock` 内任何文件**；对 gbrain 只做 HTTP 访问。
- **严禁写系统盘临时目录**；测试临时文件统一用 `server/test/.tmp/`。
- `config.json` 保持 gitignore。
- 构建类命令（vite build、bun run dev、dev server）**由用户手动执行**；`bun test`、`bunx tsc --noEmit -p server/tsconfig.json`、`web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json` 允许（**禁 bunx vue-tsc**）。
- 提交信息 conventional commits；测试子进程必须清理；3131 端口进程绝不得触碰。
- 工作分支：`m5-backup-fixes`（从 main 切出）。

## 已核实的事实（2026-08-28 源码勘察 + 真机验收，不得偏离）

| 主题 | 事实 |
|---|---|
| 备份排除清单 | `.gbrain-resolve.sock`（真机实测 EACCES；产物连 rmSync force 都删不掉）；`.gbrain-lock/` + `.gbrain-lock.reap-claim` + `<dataDir>.lock-reap.json`（恢复后判活锁/隔离修复）；`postmaster.pid`（恢复后判 unclean shutdown 拒 repair）。**保留** `.gbrain-ipc-secret`（持久密钥，重启不重建、恢复无害） |
| 活锁探测 | 硬杀后 `.gbrain-lock/` 必残留（releaseLock 不执行）——存在性≠有活持有者；须用 readLockStatus（present && !stale = 活锁；stale = 死残留）。M4-2 已修正其路径解析 |
| stats 口径 | active_api_keys = `access_tokens WHERE revoked_at IS NULL`（与 Agents 页 legacy active 同口径，无时间窗）；connected_agents 不过滤 deleted_at（含已 revoke OAuth 客户端）；active_tokens 只数未过期 OAuth access token。18→6 机制 = gbrain bootstrap-harness 同名累积 + 按名 revoke 批量清——**不是面板 bug，做标注不做改数** |
| EventSource | 原生自动重连——onerror 里 close() 反而禁用了它 |

## 文件结构总览

```
server/src/backup.ts               # 改：filter 排除、失败清理、活锁检查、statSync 竞态
server/src/config.ts               # 改：backupRetention 下限
server/src/routes/content.ts       # 改：差集存活集 limit 放大
server/src/app.ts                  # 改：/api/status 带 backupRunning
server/test/backup.test.ts         # 改：filter/活锁/失败清理测试
server/test/config.test.ts         # 改：retention 下限测试
server/test/app.test.ts            # 改：panel-config 掩蔽测试
server/test/orchestrator.test.ts / content.test.ts  # 改：超时放宽
web/src/stores/connection.ts       # 改：backupRunning 从 status 取、删 /api/backups 轮询、备份期 online 容忍
web/src/views/RequestLog.vue       # 改：SSE 原生重连、实时行提示
web/src/views/Agents.vue           # 改：签发成功后禁用按钮
web/src/views/Backup.vue           # 改：时间本地化
web/src/views/Dashboard.vue        # 改：stats 字段中文标签+口径注释
scripts/seed-m3-acceptance.mjs     # 新入库：验收种子脚本（用户刻意保留）
README.md                          # 改：M5 说明与验收清单
```

---

### Task 1: 备份 P0 修复（filter 排除 + 失败清理 + 活锁检查）

**Files:**
- Modify: `server/src/backup.ts`、`server/test/backup.test.ts`

**Interfaces:**
- Consumes: `readLockStatus`（stale-lock.ts，M4-2 已修正路径）、`Orchestrator`、`PanelConfig`。
- Produces:
  - `run()` 复制前活锁检查：`readLockStatus(cfg.gbrainHome)` 若 `present && !stale` → 中止抛错（"检测到活跃锁——疑似外部 serve 已抢占，已中止复制（源数据未被修改）"），此检查在 killServe 之后、cpSync 之前。
  - `copyDataDir` 的 cpSync 加 `filter: (src) => !isRuntimeArtifact(src)`；`isRuntimeArtifact` 为模块级导出函数：路径基名匹配 `.gbrain-resolve.sock` / `postmaster.pid` / `.lock-reap.json` 结尾，或以 `.gbrain-lock` 开头（覆盖 `.gbrain-lock/` 与 `.gbrain-lock.reap-claim`）→ true（排除）。filter 同时作用于目录级（cpSync filter 对每层入口调用）。
  - `run()` 的复制失败 catch（既有 best-effort 重启之外）：`rmSync(dest, { recursive: true, force: true })` 清理残缺目录（sock 未复制、其余可正常删），再抛错。
  - `list()` 的 `statSync(p).mtime` 与 walk 包进既有 try（竞态时跳过该条目）。

- [ ] **Step 1: 写失败测试（backup.test.ts 追加）**

```ts
import { existsSync } from "node:fs";

describe("备份排除运行时工件与安全检查", () => {
  test("filter 排除 sock/lock 簇/postmaster.pid，保留其余", async () => {
    // 种子目录（beforeEach 已建 .gbrain/brain.pglite/PG_VERSION）补工件
    writeFileSync(join(home, ".gbrain", "brain.pglite", ".gbrain-resolve.sock"), "x");
    mkdirSync(join(home, ".gbrain", "brain.pglite", ".gbrain-lock"), { recursive: true });
    writeFileSync(join(home, ".gbrain", "brain.pglite", ".gbrain-lock", "lock"), "{}");
    writeFileSync(join(home, ".gbrain", "brain.pglite", "postmaster.pid"), "1234");
    writeFileSync(join(home, ".gbrain", "brain.pglite", ".gbrain-ipc-secret"), "abc");
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    const r = await bm.run();
    const dest = join(backupDir, r.name);
    expect(existsSync(join(dest, "brain.pglite", "PG_VERSION"))).toBe(true);
    expect(existsSync(join(dest, "brain.pglite", ".gbrain-ipc-secret"))).toBe(true);   // 保留
    expect(existsSync(join(dest, "brain.pglite", ".gbrain-resolve.sock"))).toBe(false); // 排除
    expect(existsSync(join(dest, "brain.pglite", ".gbrain-lock"))).toBe(false);         // 排除
    expect(existsSync(join(dest, "brain.pglite", "postmaster.pid"))).toBe(false);       // 排除
  });

  test("复制前活锁（新鲜心跳）→ 中止且不产生备份", async () => {
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), "{}"); // mtime=now → 新鲜
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/活跃锁|外部 serve/);
    const dirs = readdirSync(backupDir).filter(d => d.startsWith("gbrain-backup-"));
    expect(dirs.length).toBe(0);
  });

  test("stale 锁（死残留）不阻断备份", async () => {
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    const t = new Date(Date.now() - 120_000);
    writeFileSync(join(lockDir, "lock"), "{}");
    utimesSync(join(lockDir, "lock"), t, t);
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    const r = await bm.run();
    expect(r.name).toMatch(/^gbrain-backup-/);
  });

  test("复制失败清理残缺目录（源目录不存在 → ENOENT）", async () => {
    const bm = new BackupManager({ cfg: { ...cfg(), gbrainHome: join(TMP, "no-such-home") }, orch: fakeOrch("own"), client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/备份复制失败/);
    const dirs = readdirSync(backupDir).filter(d => d.startsWith("gbrain-backup-"));
    expect(dirs.length).toBe(0); // 残缺目录已被 catch 清理
  });
});
```

（备份目录名时间戳精确到秒——测试若在同一秒内跑"活锁中止"与既有用例，目录计数可能受既有备份影响；上述断言用"本轮新增=0"口径，beforeEach 的 backupDir 是全新 mkdtemp 目录，天然隔离。）

- [ ] **Step 2: 运行确认失败** — Run: `bun test server/test/backup.test.ts`，Expected: 新增 4 个中 filter/活锁/失败清理 3 类 FAIL（stale 用例可能碰巧过）

- [ ] **Step 3: 实现**

backup.ts 改动：

```ts
import { readLockStatus } from "./stale-lock";

// 源码定论的备份排除清单（恢复安全）：sock（EACCES 元凶）、lock 簇（恢复后判活锁）、
// postmaster.pid（恢复后判 unclean shutdown）。.gbrain-ipc-secret 保留（持久密钥）。
export function isRuntimeArtifact(src: string): boolean {
  const base = src.split(/[\\/]/).pop() ?? "";
  if (base === ".gbrain-resolve.sock" || base === "postmaster.pid") return true;
  if (base.endsWith(".lock-reap.json")) return true;
  if (base.startsWith(".gbrain-lock")) return true; // .gbrain-lock/ 与 .gbrain-lock.reap-claim
  return false;
}
```

run() 内 killServe 之后、settle 等待之后、cpSync 之前加：

```ts
      const lock = readLockStatus(this.deps.cfg.gbrainHome);
      if (lock.present && !lock.stale) {
        // killServe 后本不应有新鲜心跳——存在即外部 serve 抢占持锁，复制会得到不一致快照
        await this.deps.orch.start().catch(() => null); // best-effort 拉回（大概率 attached）
        throw new Error("检测到活跃锁——疑似外部 serve 已抢占，已中止复制（源数据未被修改）");
      }
```

cpSync 加 filter：

```ts
      cpSync(join(this.deps.cfg.gbrainHome, ".gbrain"), dest, { recursive: true, filter: (src) => !isRuntimeArtifact(src) });
```

复制失败的 catch（既有 best-effort 重启逻辑处）追加清理（在重启之前、抛错之前）：

```ts
        try { rmSync(dest, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原错误 */ }
```

（dest 变量需提升到 try 外可见——现实现里 dest 定义在 cpSync 前，catch 若同函数作用域即可直接引用；以现状代码结构为准。）

list() 的条目组装整体包 try/catch（statSync 竞态跳过该条）。

- [ ] **Step 4: 运行确认通过** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`，Expected: 85 PASS（81+4）；tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/backup.ts server/test/backup.test.ts
git commit -m "fix: 备份排除运行时工件（sock/lock簇/postmaster.pid）+ 失败清理 + 活锁检查"
```

---

### Task 2: 配置与稳健小修（retention 下限 / 掩蔽测试 / 差集放大 / 超时放宽）

**Files:**
- Modify: `server/src/config.ts`、`server/src/routes/content.ts`、`server/test/config.test.ts`、`server/test/app.test.ts`、`server/test/orchestrator.test.ts`、`server/test/content.test.ts`

**Interfaces:**
- Produces:
  - loadConfig：解析后 `cfg.backupRetention = Math.max(1, Math.floor(Number(cfg.backupRetention) || 5))`（0/负/非数回 5→至少 1）。
  - app.test.ts 追加 panel-config 掩蔽测试。
  - content.ts 差集的存活集调用 limit 改 `offset + limit`（覆盖当前窗口）。
  - orchestrator.test.ts / content.test.ts 含 boot/spawn 的用例补第三参 15000。

- [ ] **Step 1: 写失败测试**

config.test.ts 追加：

```ts
import { writeFileSync } from "node:fs";

describe("backupRetention 下限", () => {
  test("0/负数/非数回退至少 1", () => {
    const p = join(dir, "config.json");
    for (const bad of [0, -3, "abc", null]) {
      writeFileSync(p, JSON.stringify({ backupRetention: bad }));
      expect(loadConfig(p).backupRetention).toBeGreaterThanOrEqual(1);
    }
  });
});
```

app.test.ts 追加：

```ts
describe("panel-config 掩蔽", () => {
  test("bootstrapToken 不出现、其余字段原样", async () => {
    const b = await bootPanelWithFake("healthy", TOKEN);
    panels.push(b.server); fakes.push(b.fake);
    const json = await (await fetch(`http://127.0.0.1:${b.panelPort}/api/panel-config`)).json() as Record<string, unknown>;
    expect(json.bootstrapToken).toBe("<已隐藏>");
    expect(JSON.stringify(json)).not.toContain(String(TOKEN));
    expect(json.gbrainPort).toBe(b.fake.port);
  });
});
```

（以 app.test.ts 现有局部变量命名风格为准对齐；`String(TOKEN)` 全串不得出现在响应任何角落。）

- [ ] **Step 2: 运行确认失败** — Run: `bun test server/test/config.test.ts server/test/app.test.ts`，Expected: retention 4 断言中 0/null 可能碰巧过、其余 FAIL；掩蔽测试应 FAIL（现状 gbrainPort 字段存在但断言 String(TOKEN) 不出现——现状已脱敏则此条过，只验回归网存在即可，若全过说明基线已绿，记录后继续）

- [ ] **Step 3: 实现**（三处一行级改动 + 超时放宽，见 Interfaces；差集放大改 content.ts 中存活集调用的 limit 实参）

- [ ] **Step 4: 运行确认通过** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json`，Expected: 87 PASS（85+2）；tsc 0 错误

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/routes/content.ts server/test
git commit -m "fix: retention 下限/panel-config 掩蔽回归/差集存活集放大/测试超时放宽"
```

---

### Task 3: 备份轮询降载 + online 容忍 + SSE 原生重连

**Files:**
- Modify: `server/src/app.ts`、`web/src/stores/connection.ts`、`web/src/views/RequestLog.vue`

**Interfaces:**
- Produces:
  - `/api/status` 响应追加 `backupRunning: boolean`（`deps.backup?.isRunning() ?? false`）——零磁盘 IO。
  - connection.ts：删掉 refresh 里的 `/api/backups` 轮询；`backupRunning` 改从 status 响应取；`refresh()` 的 catch 里若 `this.backupRunning` 为 true 则保持 `online = true` 不闪断（备份阻塞期容忍，Backup.vue 列表仍按需拉取）。
  - RequestLog.vue：`es.onerror` 不再 `es.close()`（EventSource 原生自动重连）——改提示文案"连接中断，自动重连中…"并保留 live 状态；`toggleLive` 手动关闭逻辑不变。

- [ ] **Step 1: 实现**（纯行为改动，无新单测——app.test.ts 既有 status 测试会覆盖新字段不破坏；改完手验点写进 README 清单）

- [ ] **Step 2: 验证** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json && web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`，Expected: 87 PASS；双 tsc 0 错误

- [ ] **Step 3: Commit**

```bash
git add server/src/app.ts web/src/stores/connection.ts web/src/views/RequestLog.vue
git commit -m "perf: backupRunning 并入 status 轮询消除备份列表高频 stat + 备份期容忍 + SSE 原生重连"
```

---

### Task 4: UI 打磨（Agents 禁用 / 实时行提示 / 备份时间本地化 / stats 口径标注）

**Files:**
- Modify: `web/src/views/Agents.vue`、`web/src/views/RequestLog.vue`、`web/src/views/Backup.vue`、`web/src/views/Dashboard.vue`

**Interfaces:**
- Produces:
  - Agents.vue：签发成功后 `issued.value = true`，positive 按钮文案改"已签发"且弹窗 `:show-icon` 保持——用 `:positive-button-props="{ disabled: issued }"`（NModal dialog 模式）禁用防连点；重新打开弹窗时复位。
  - RequestLog.vue：live 开启时表格上方加一行 muted 提示"查询/翻页会替换列表（实时行随之清除）；连接中断自动重连"。
  - Backup.vue：createdAt 渲染改 `new Date(b.createdAt).toLocaleString()`。
  - Dashboard.vue：stats 数值卡的 label 映射表（后端字段名 → 中文+口径注释）：`connected_agents → "已连接 Agents（含已撤销客户端）"`、`active_tokens → "活跃 OAuth Token（未过期）"`、`active_api_keys → "活跃 API Key（未撤销，含同名历史累积）"`、`requests_today → "近 24h 请求数"`；未在表中的字段原样显示。卡片下方加一行 muted："口径说明：active_api_keys 统计未撤销的 access_tokens 行（与 Agents 页同口径）；gbrain 自身的 bootstrap-harness 会按名累积，可用 Agents 页按名撤销清理。"

- [ ] **Step 1: 实现**（纯前端展示改动）

- [ ] **Step 2: 验证** — Run: `web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json && bun test`，Expected: 0 错误；87 PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/views
git commit -m "feat: 运维 UI 打磨（签发防连点/实时行提示/备份时间本地化/stats 口径标注）"
```

---

### Task 5: seed 脚本入库 + README M5 + 收尾

**Files:**
- Create: `scripts/seed-m3-acceptance.mjs`（从未跟踪文件 `git add` 入库，内容不动）
- Modify: `README.md`

**Interfaces:**
- Produces: 种子脚本入库（M5+ 验收复用）；README M5 说明与验收清单。

- [ ] **Step 1: README 更新（「里程碑」节之前插入）**

```markdown
## M5 使用说明（备份修复与打磨）

- **备份修复（P0）**：复制排除运行时工件（resolve sock / lock 簇 / postmaster.pid——恢复安全），
  失败自动清理残缺目录，复制前活锁检查（外部 serve 抢占时中止且源数据不动）。
- 备份状态并入 /api/status 轮询（消除备份列表高频磁盘扫描）；备份阻塞期间不再误报"面板不可达"。
- 请求日志 SSE 断开后自动重连；Agents 签发成功后按钮禁用防连点；仪表盘统计卡附口径说明
  （active_api_keys 含 gbrain bootstrap-harness 同名历史累积，可在 Agents 页按名撤销清理）。

### M5 验收清单（手动，需先 build:web 并启动面板）

1. **备份红线**：own 态点立即备份 → 完成后到 `D:\gbrain-backup\<名称>\brain.pglite\` 核对
   真实数据库文件（PG_VERSION、base/ 等）与体积（约 40+ MB）——列表有条目不算数。
   备份产物中不得出现 .gbrain-resolve.sock / .gbrain-lock / postmaster.pid。
2. 备份期间观察：横幅出现，页面不闪"面板服务不可达"；完成后 serve 恢复（页面库可查）。
3. **attach 模式备份拒绝（M4 遗留补测）**：先手动起一个占 3131 的 serve → 启动面板（attach 态）
   → 备份页点立即备份 → 预期 503 + "复用他人 serve"提示 → 测完关外部 serve 重启面板回 own。
4. 配置页 backupRetention 显示 ≥1（手改 config.json 为 0 重启面板验证回 1）。
5. 请求日志开实时流 → 手动 Ctrl+C 重启面板 → 观察自动重连恢复（不断流提示消失）。
6. 仪表盘统计卡显示中文口径标签与说明行。
7. Agents 页撤销遗留的 panel-m3-seed ×2、gbrain-panel-discover ×3（顺手复验撤销链路；
   撤后 active_api_keys 相应下降）。
```

- [ ] **Step 2: 全量回归** — Run: `bun test && bunx tsc --noEmit -p server/tsconfig.json && web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`，Expected: 87 PASS；双 tsc 0 错误

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-m3-acceptance.mjs README.md
git commit -m "docs: M5 使用说明与验收清单（seed 脚本入库）"
```

- [ ] **Step 4: 用户手动验收** — README「M5 验收清单」7 条交用户（第 1 条为备份红线，第 3 条为 M4 遗留 attach 补测）。

---

## 计划自审记录

- **覆盖核对**：验收必修 1→Task 1（filter 含 sock + 源码追加的 lock 簇/postmaster.pid）、必修 2→Task 1（catch 清理 + statSync 竞态）、必修 3→Task 5 验收清单第 3 条（手测步骤）；原 #1→Task 2、#2→Task 2、#3→Task 3、#4→Task 2、#5→Task 1（活锁检查）、#6→Task 2、#7→Task 4、#8→Task 3（SSE）/Task 4（UTC）/Task 1（statSync）、#9→Task 4（口径标注，源码定论不改数）；seed 脚本入库→Task 5。候选池全部维持不排期。
- **占位符扫描**：无 TBD；Task 2 掩蔽测试的"若全过说明基线已绿"是显式的两种预期分支，非待定。
- **类型一致性**：isRuntimeArtifact 导出供 filter 与测试复用；readLockStatus 复用 stale-lock 现签名；status 响应新增 backupRunning 字段与 connection store 消费一致；Dashboard labelMap 键 = /api/stats 四个已核实字段名。
