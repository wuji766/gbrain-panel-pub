// server/src/stale-lock.ts
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LockStatus { present: boolean; stale: boolean; lockDir: string }

// gbrain 心跳 30s 一次（src/core/pglite-lock.ts）；容忍 3 个周期
const STALE_AFTER_MS = 90_000;

export function readLockStatus(gbrainHome: string, now = Date.now()): LockStatus {
  const lockDir = join(gbrainHome, ".gbrain", ".gbrain-lock");
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
