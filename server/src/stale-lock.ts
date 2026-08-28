// server/src/stale-lock.ts
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LockStatus { present: boolean; stale: boolean; lockDir: string }

// gbrain 心跳 30s 一次（src/core/pglite-lock.ts）；容忍 3 个周期
const STALE_AFTER_MS = 90_000;

// 真实布局（2026-08 实测）：锁目录在 database_path 指向的 brain.pglite 内，
// database_path 记录于 <home>/.gbrain/config.json（相对路径相对 config.json 所在目录解析）。
// config.json 缺失/读取解析失败时回退旧路径 <home>/.gbrain/.gbrain-lock（兼容）。
// 保持同步：existsSync 探测，读取失败即回退。
function resolveLockDir(gbrainHome: string): string {
  const dotDir = join(gbrainHome, ".gbrain");
  const legacy = join(dotDir, ".gbrain-lock");
  try {
    const cfgPath = join(dotDir, "config.json");
    if (existsSync(cfgPath)) {
      const dbPath = (JSON.parse(readFileSync(cfgPath, "utf8")) as { database_path?: string }).database_path;
      const abs = typeof dbPath === "string" && dbPath
        ? (/^[a-zA-Z]:[\\/]/.test(dbPath) ? dbPath : join(dotDir, dbPath))
        : join(dotDir, "brain.pglite"); // config.json 在但未写 database_path：gbrain 默认库位
      return join(abs, ".gbrain-lock");
    }
  } catch { /* 读取/解析失败回退 legacy */ }
  return legacy;
}

/** 读取锁内 PID（<lockDir>/lock 的 JSON `pid` 字段）。任何失败（无锁目录/无 lock 文件/解析失败/
 *  字段非整数）返回 null——调用方（备份活锁判据）对 null 采取保守路线（视为外部锁，中止）。 */
export function readLockPid(gbrainHome: string): number | null {
  const lockDir = resolveLockDir(gbrainHome);
  try {
    const pid = (JSON.parse(readFileSync(join(lockDir, "lock"), "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
  } catch { return null; }
}

export function readLockStatus(gbrainHome: string, now = Date.now()): LockStatus {
  const lockDir = resolveLockDir(gbrainHome);
  if (!existsSync(lockDir)) return { present: false, stale: false, lockDir };
  let newest = 0;
  for (const f of readdirSync(lockDir)) {
    const st = statSync(join(lockDir, f));
    newest = Math.max(newest, st.mtimeMs);
  }
  return { present: true, stale: now - newest > STALE_AFTER_MS, lockDir };
}

export function clearStaleLock(gbrainHome: string): boolean {
  const s = readLockStatus(gbrainHome);
  if (s.present && s.stale) {
    rmSync(s.lockDir, { recursive: true, force: true });
    return true;
  }
  return false;
}
