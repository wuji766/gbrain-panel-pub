// server/src/backup.ts
// 停机备份：PGLite 单写者约束下，serve 持锁期间直接拷贝数据目录会得到不一致快照
// （源码证实），故仅在面板自有 serve（own 态）时执行：killServe → 整目录复制
// <gbrainHome>/.gbrain → 备份目录 → 重启 serve → 按保留策略清理旧份。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PanelConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { GbrainClient } from "./gbrain-client";

export interface BackupInfo { name: string; sizeBytes: number; createdAt: string }

// 目录名固定 gbrain-backup-YYYYMMDD-HHMMSS（UTC），remove/列表均按此白名单校验，防路径注入
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
        const walk = (dir: string) => {
          for (const f of readdirSync(dir, { withFileTypes: true })) {
            const fp = join(dir, f.name);
            if (f.isDirectory()) walk(fp); else size += statSync(fp).size;
          }
        };
        try { walk(p); } catch { /* 单文件失败忽略，列表不因此报错 */ }
        return { name: d, sizeBytes: size, createdAt: statSync(p).mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name)); // 名称含时间戳，倒序 = 最新在前
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
      // killServe 后 state=stopped，start() 重入守卫允许再次启动；client 惰性重登自愈（apiKey 存库不变）
      const state = await this.deps.orch.start();
      if (state !== "own") throw new Error(`备份后 serve 重启异常（${state}）——备份文件已生成：${name}`);
      this.prune();
      return this.list().find(b => b.name === name) ?? { name, sizeBytes: 0, createdAt: new Date().toISOString() };
    } finally {
      this.running = false;
    }
  }

  private prune(): void {
    const dirs = readdirSync(this.deps.cfg.backupDir).filter(d => NAME_RE.test(d)).sort(); // 时间戳字典序 = 时间序
    while (dirs.length > this.deps.cfg.backupRetention) {
      const oldest = dirs.shift()!;
      rmSync(join(this.deps.cfg.backupDir, oldest), { recursive: true, force: true });
    }
  }

  remove(name: string): boolean {
    if (!NAME_RE.test(name)) return false; // 非白名单名（含路径注入变体）一律拒绝
    const p = join(this.deps.cfg.backupDir, name);
    if (!existsSync(p)) return false;
    rmSync(p, { recursive: true, force: true });
    return true;
  }
}
