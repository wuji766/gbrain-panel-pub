// server/src/backup.ts
// 停机备份：PGLite 单写者约束下，serve 持锁期间直接拷贝数据目录会得到不一致快照
// （源码证实），故仅在面板自有 serve（own 态）时执行：killServe → 等句柄释放 →
// 整目录复制 <gbrainHome>/.gbrain → 备份目录 → 重启 serve → 按保留策略清理旧份。
// 失败防护：复制抛错时 best-effort 重启 serve 再上抛（否则面板数据接口 502 到重启进程为止）；
// stopped 态（上次失败中断的遗留态）重试时先拉起 serve；attached/foreign 仍拒绝。
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PanelConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { GbrainClient } from "./gbrain-client";
import { isPidAlive, readLockPid, readLockStatus } from "./stale-lock";

export interface BackupInfo { name: string; sizeBytes: number; createdAt: string }

// 源码定论的备份排除清单（恢复安全）：sock（EACCES 元凶）、lock 簇（恢复后判活锁）、
// postmaster.pid（恢复后判 unclean shutdown）。.gbrain-ipc-secret 保留（持久密钥）。
export function isRuntimeArtifact(src: string): boolean {
  const base = src.split(/[\\/]/).pop() ?? "";
  if (base === ".gbrain-resolve.sock" || base === "postmaster.pid") return true;
  if (base.endsWith(".lock-reap.json")) return true;
  if (base.startsWith(".gbrain-lock")) return true; // .gbrain-lock/ 与 .gbrain-lock.reap-claim
  return false;
}

// 目录名固定 gbrain-backup-YYYYMMDD-HHMMSS（UTC），remove/列表均按此白名单校验，防路径注入
const NAME_RE = /^gbrain-backup-\d{8}-\d{6}$/;

// 完整性标记（M7）：复制完成后写 BACKUP_OK（单次小文件写入，存在即完整）；列表与 retention
// 只认标记。升级收养哨兵写在 backupDir 根：无哨兵 = 升级前的既有目录（无标记语义，无从区分
// 残缺）→ 一次性全部补标记收养（宁滥勿删，残缺的历史份靠 retention 轮替消化）；有哨兵 =
// 升级后 → 无标记目录只能是复制中断的残缺品，构造时清理。
const MARKER_FILE = "BACKUP_OK";
const SCHEMA_SENTINEL = ".gbrain-panel-marker-v1";

export class BackupManager {
  private running = false;

  // copyDir：整个复制动作的测试注入替身（签名对齐调用点：仅 src/dest——filter/重试语义内置于默认实现）
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

  isRunning(): boolean { return this.running; }

  list(): BackupInfo[] {
    if (!existsSync(this.deps.cfg.backupDir)) return [];
    return readdirSync(this.deps.cfg.backupDir)
      .filter(d => NAME_RE.test(d) && existsSync(join(this.deps.cfg.backupDir, d, MARKER_FILE)))
      .flatMap((d): BackupInfo[] => {
        const p = join(this.deps.cfg.backupDir, d);
        let size = 0;
        const walk = (dir: string) => {
          for (const f of readdirSync(dir, { withFileTypes: true })) {
            const fp = join(dir, f.name);
            if (f.isDirectory()) walk(fp); else size += statSync(fp).size;
          }
        };
        try {
          walk(p);
          return [{ name: d, sizeBytes: size, createdAt: statSync(p).mtime.toISOString() }];
        } catch {
          // 竞态：统计途中条目被删/变更（statSync/walk 均可能抛）——跳过该条，列表不因此报错
          return [];
        }
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
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2");
      const name = `gbrain-backup-${ts}`;
      const dest = join(this.deps.cfg.backupDir, name);
      try {
        mkdirSync(this.deps.cfg.backupDir, { recursive: true });
        await this.copyDataDir(join(this.deps.cfg.gbrainHome, ".gbrain"), dest);
        // 复制完成后写完整性标记：强杀/断电后无标记即残缺（列表/retention 只认标记）；
        // 写失败按备份失败处理（catch 清理残缺目录并 best-effort 重启 serve）
        writeFileSync(join(dest, MARKER_FILE), new Date().toISOString());
      } catch (e) {
        // 残缺备份目录不留档：半份快照恢复出来是脏数据，且 sock 等工件未被排除时残件难删
        try { rmSync(dest, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原错误 */ }
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

  private prune(): void {
    const dirs = readdirSync(this.deps.cfg.backupDir)
      .filter(d => NAME_RE.test(d) && existsSync(join(this.deps.cfg.backupDir, d, MARKER_FILE)))
      .sort(); // 时间戳字典序 = 时间序
    const failed: string[] = [];
    while (dirs.length > this.deps.cfg.backupRetention) {
      const oldest = dirs.shift()!;
      try { rmSync(join(this.deps.cfg.backupDir, oldest), { recursive: true, force: true }); }
      catch { failed.push(oldest); } // 单份清理失败不阻断备份成功路径（M-2：错误信息友好化）
    }
    if (failed.length) console.warn(`[backup] 旧备份清理失败（保留策略未完全执行）：${failed.join(", ")}`);
  }

  remove(name: string): boolean {
    if (!NAME_RE.test(name)) return false; // 非白名单名（含路径注入变体）一律拒绝
    const p = join(this.deps.cfg.backupDir, name);
    if (!existsSync(p)) return false;
    try { rmSync(p, { recursive: true, force: true }); return true; }
    catch (e) { console.warn(`[backup] 删除备份失败（${name}）：${String(e)}`); return false; }
  }
}
