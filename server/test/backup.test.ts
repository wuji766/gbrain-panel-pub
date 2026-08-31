import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BackupManager } from "../src/backup";
import type { Orchestrator } from "../src/orchestrator";
import type { GbrainClient } from "../src/gbrain-client";
import type { PanelConfig } from "../src/config";

const TMP = join(import.meta.dir, ".tmp");
let home: string, backupDir: string;
// killServe 返回 1234：M6 起活锁判据改持锁进程存活探测，返回值已无内部消费方（诊断/测试保留）
const fakeOrch = (state: string) => ({ getState: () => state, killServe: async () => 1234, start: async () => "own" as const }) as unknown as Orchestrator;
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
      writeFileSync(join(backupDir, `gbrain-backup-${ts}`, "BACKUP_OK"), new Date().toISOString());
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

  test("复制失败：best-effort 重启 serve 并抛错", async () => {
    let started = 0;
    const orch = { getState: () => "own", killServe: async () => {}, start: async () => { started++; return "own"; } } as unknown as Orchestrator;
    const bm = new BackupManager({ cfg: { ...cfg(), gbrainHome: join(TMP, "no-such-home") }, orch, client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/备份复制失败.*已尝试重启/);
    expect(started).toBeGreaterThanOrEqual(1);
  });

  test("stopped 态：前置先拉起 serve 再备份", async () => {
    let started = 0;
    const orch = { getState: () => (started === 0 ? "stopped" : "own"), killServe: async () => { started = 0; }, start: async () => { started++; return "own"; } } as unknown as Orchestrator;
    const bm = new BackupManager({ cfg: cfg(), orch, client: fakeClient });
    const r = await bm.run();
    expect(r.name).toMatch(/^gbrain-backup-/);
    expect(started).toBeGreaterThanOrEqual(1);
  });
});

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

describe("备份排除运行时工件与安全检查", () => {
  test("filter 排除 sock/lock 簇/postmaster.pid，保留其余", async () => {
    // 种子目录（beforeEach 已建 .gbrain/brain.pglite/PG_VERSION）补工件
    writeFileSync(join(home, ".gbrain", "brain.pglite", ".gbrain-resolve.sock"), "x");
    mkdirSync(join(home, ".gbrain", "brain.pglite", ".gbrain-lock"), { recursive: true });
    writeFileSync(join(home, ".gbrain", "brain.pglite", ".gbrain-lock", "lock"), "{}");
    // 本用例只验 filter 排除：锁簇 mtime 回拨为 stale，避免触发"复制前活锁检查"中止
    // （新鲜锁会命中活锁检查——那是下一个用例的语义，二者须互斥可辨）
    const stale = new Date(Date.now() - 120_000);
    utimesSync(join(home, ".gbrain", "brain.pglite", ".gbrain-lock", "lock"), stale, stale);
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

  test("复制失败清理残缺目录（注入 copyDir 半途抛错，dest 已产生）", async () => {
    // 修 Important-1：旧版"源目录不存在 → ENOENT"是空转覆盖（cpSync 在创建 dest 前就抛错，
    // dirs.length===0 先验成立，rmSync 清理从未真跑过）。注入 copyDir 制造"mkdir dest +
    // 写半份文件 + 抛错"，确定性真覆盖 catch 里的 rmSync(dest) 清理与"备份复制失败"语义。
    const bm = new BackupManager(
      { cfg: cfg(), orch: fakeOrch("own"), client: fakeClient },
      {
        copyDir: (_src, dest) => {
          mkdirSync(dest, { recursive: true });
          writeFileSync(join(dest, "half-file"), "x");
          throw new Error("注入失败");
        },
      },
    );
    await expect(bm.run()).rejects.toThrow(/备份复制失败/);
    const dirs = readdirSync(backupDir).filter(d => d.startsWith("gbrain-backup-"));
    expect(dirs.length).toBe(0); // 半份 dest 已被 catch 清理
  });
});
