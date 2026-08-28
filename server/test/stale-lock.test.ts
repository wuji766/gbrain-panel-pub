// server/test/stale-lock.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { readLockStatus, clearStaleLock } from "../src/stale-lock";

const TMP = join(import.meta.dir, ".tmp");
mkdirSync(TMP, { recursive: true });
let home: string;
beforeEach(() => { home = mkdtempSync(join(TMP, "lock-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function makeLock(ageSec: number) {
  const lockDir = join(home, ".gbrain", ".gbrain-lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), "{}");
  const t = new Date(Date.now() - ageSec * 1000);
  utimesSync(join(lockDir, "owner.json"), t, t);
  return lockDir;
}

describe("readLockStatus", () => {
  test("无锁目录 → present:false", () => {
    const s = readLockStatus(home);
    expect(s.present).toBe(false);
    expect(s.stale).toBe(false);
  });
  test("新鲜心跳（10s 前）→ present 且非 stale", () => {
    makeLock(10);
    const s = readLockStatus(home);
    expect(s.present).toBe(true);
    expect(s.stale).toBe(false);
  });
  test("心跳超龄（120s 前）→ stale", () => {
    makeLock(120);
    expect(readLockStatus(home).stale).toBe(true);
  });
});

describe("clearStaleLock", () => {
  test("stale 时删除并返回 true", () => {
    const lockDir = makeLock(120);
    expect(clearStaleLock(home)).toBe(true);
    const { existsSync } = require("node:fs");
    expect(existsSync(lockDir)).toBe(false);
  });
  test("新鲜锁拒绝删除返回 false", () => {
    makeLock(5);
    expect(clearStaleLock(home)).toBe(false);
    const { existsSync } = require("node:fs");
    expect(existsSync(join(home, ".gbrain", ".gbrain-lock"))).toBe(true);
  });
});

// 真实布局（2026-08 实测）：锁在 database_path 指向的 brain.pglite 目录内，
// database_path 记录于 <home>/.gbrain/config.json；旧路径 <home>/.gbrain/.gbrain-lock 仅作兼容回退。
describe("锁路径跟随 database_path（真实布局）", () => {
  test("config.json 指定 database_path 时锁目录在其下", () => {
    const gbrainHome2 = mkdtempSync(join(TMP, "lock2-"));
    const dot = join(gbrainHome2, ".gbrain");
    mkdirSync(dot, { recursive: true });
    writeFileSync(join(dot, "config.json"), JSON.stringify({ database_path: "custom-db" }));
    const lockDir = join(dot, "custom-db", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), "x");
    const t = new Date(Date.now() - 120_000);
    utimesSync(join(lockDir, "lock"), t, t);
    const s = readLockStatus(gbrainHome2);
    expect(s.present).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.lockDir).toBe(lockDir);
    rmSync(gbrainHome2, { recursive: true, force: true });
  });

  test("config.json 缺失时回退旧路径仍可用", () => {
    const gbrainHome3 = mkdtempSync(join(TMP, "lock3-"));
    const lockDir = join(gbrainHome3, ".gbrain", ".gbrain-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "lock"), "x");
    const s = readLockStatus(gbrainHome3);
    expect(s.present).toBe(true);
    rmSync(gbrainHome3, { recursive: true, force: true });
  });
});
