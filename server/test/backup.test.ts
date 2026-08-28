import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { BackupManager } from "../src/backup";
import type { Orchestrator } from "../src/orchestrator";
import type { GbrainClient } from "../src/gbrain-client";
import type { PanelConfig } from "../src/config";

const TMP = join(import.meta.dir, ".tmp");
let home: string, backupDir: string;
// killServe 返回被杀自有 serve 的 pid=1234（活锁判据比对用；无锁/stale 锁的用例不消费该值）
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

  test("cpSync 失败：best-effort 重启 serve 并抛错", async () => {
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

  test("外部活锁（新鲜心跳且锁 pid≠被杀 pid）→ 中止且不产生备份", async () => {
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    // mtime=now → 新鲜；锁内 pid=9999 ≠ killServe 返回的 1234 → 持锁者是外部 serve
    writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: 9999, acquired_at: Date.now(), refreshed_at: Date.now(), command: "serve", subcommand: "http" }));
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    await expect(bm.run()).rejects.toThrow(/活跃锁|外部 serve/);
    const dirs = readdirSync(backupDir).filter(d => d.startsWith("gbrain-backup-"));
    expect(dirs.length).toBe(0);
  });

  test("自有 serve 尸锁（锁 pid=被杀 pid，mtime 仍新鲜）→ 放行备份", async () => {
    // 场景：own 态 serve 被 taskkill /F 强杀——不走 gbrain 优雅退出路径，锁文件残留、
    // mtime 冻结在死前最后一次心跳（心跳 30s 一次），90s staleness 窗口内 mtime 判据必
    // 误报"活锁"。新判据：锁内 pid === killServe 返回的被杀 pid → 亲手所杀，放行复制。
    const lockDir = join(home, ".gbrain", "brain.pglite", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: 1234, acquired_at: Date.now(), refreshed_at: Date.now(), command: "serve", subcommand: "http" })); // mtime=now → 新鲜
    const bm = new BackupManager({ cfg: cfg(), orch: fakeOrch("own"), client: fakeClient });
    const r = await bm.run();
    expect(existsSync(join(backupDir, r.name, "brain.pglite", "PG_VERSION"))).toBe(true);
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
