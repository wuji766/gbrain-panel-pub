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
