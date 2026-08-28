// server/src/backup.ts
// 停机备份：PGLite 单写者约束下，serve 持锁期间直接拷贝数据目录会得到不一致快照
// （源码证实），故仅在面板自有 serve（own 态）时执行：killServe → 等句柄释放 →
// 整目录复制 <gbrainHome>/.gbrain → 备份目录 → 重启 serve → 按保留策略清理旧份。
// 失败防护：复制抛错时 best-effort 重启 serve 再上抛（否则面板数据接口 502 到重启进程为止）；
// stopped 态（上次失败中断的遗留态）重试时先拉起 serve；attached/foreign 仍拒绝。
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
    const cur = this.deps.orch.getState();
    if (cur === "attached" || cur === "foreign") throw new Error("当前复用他人 serve（attached/foreign），无法安全停机备份——请以面板自有 serve 运行时备份");
    if (cur === "stopped") {
      // 上次备份失败中断的遗留态：先拉起自有 serve 再走正常停机备份流程
      let after: string;
      try { after = await this.deps.orch.start(); } catch { after = "失败"; }
      if (after !== "own") throw new Error(`备份前 serve 重启失败（${after}）——请尝试面板的 spawn-fallback 或重启面板`);
    } else if (cur !== "own") {
      throw new Error(`当前状态不适合备份（${cur}）`);
    }
    this.running = true;
    try {
      await this.deps.orch.killServe();
      // Windows 句柄释放竞态：killServe 后文件句柄可能尚未释放，立即复制易撞 EBUSY/EPERM
      await new Promise(r => setTimeout(r, 300));
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2");
      const name = `gbrain-backup-${ts}`;
      const dest = join(this.deps.cfg.backupDir, name);
      try {
        mkdirSync(this.deps.cfg.backupDir, { recursive: true });
        await this.copyDataDir(join(this.deps.cfg.gbrainHome, ".gbrain"), dest);
      } catch (e) {
        // best-effort 恢复 serve：cpSync 已抛错（磁盘满/EBUSY/ENOENT 等）时 serve 仍被杀着，
        // 不重启则面板所有数据接口 502 直到面板进程重启为止
        let restart: string;
        try { restart = await this.deps.orch.start(); } catch { restart = "失败"; }
        const why = e instanceof Error ? e.message : String(e);
        throw new Error(`备份复制失败（${why}）；已尝试重启 serve（${restart}）`);
      }
      // killServe 后 state=stopped，start() 重入守卫允许再次启动；client 惰性重登自愈（apiKey 存库不变）
      const state = await this.deps.orch.start();
      if (state !== "own") throw new Error(`备份后 serve 重启异常（${state}）——备份文件已生成：${name}；可尝试面板的 spawn-fallback 或重启面板`);
      this.prune();
      return this.list().find(b => b.name === name) ?? { name, sizeBytes: 0, createdAt: new Date().toISOString() };
    } finally {
      this.running = false;
    }
  }

  /** 复制数据目录：撞 EBUSY/EPERM（句柄竞态）时等 300ms 重试一次（仅一次），仍失败上抛进入 catch 恢复逻辑 */
  private async copyDataDir(src: string, dest: string): Promise<void> {
    try {
      cpSync(src, dest, { recursive: true });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EBUSY" && code !== "EPERM") throw e;
      await new Promise(r => setTimeout(r, 300));
      cpSync(src, dest, { recursive: true });
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
