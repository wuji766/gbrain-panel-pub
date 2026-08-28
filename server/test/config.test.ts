// server/test/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, generateToken } from "../src/config";

const TMP = join(import.meta.dir, ".tmp");
mkdirSync(TMP, { recursive: true });
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(TMP, "cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  test("首启生成配置文件，token 为 43 位 base64url", () => {
    const p = join(dir, "config.json");
    const cfg = loadConfig(p);
    expect(existsSync(p)).toBe(true);
    expect(cfg.bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfg.panelPort).toBe(7070);
    expect(cfg.gbrainPort).toBe(3131);
  });
  test("二次加载返回相同 token（持久）", () => {
    const p = join(dir, "config.json");
    const a = loadConfig(p); const b = loadConfig(p);
    expect(b.bootstrapToken).toBe(a.bootstrapToken);
  });
  test("已有配置的字段被尊重，缺省字段补默认且回写 token", () => {
    const p = join(dir, "config.json");
    writeManual(p, { panelPort: 8080 });
    const cfg = loadConfig(p);
    expect(cfg.panelPort).toBe(8080);
    expect(cfg.gbrainPort).toBe(3131);
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.bootstrapToken).toBe(cfg.bootstrapToken);
  });
});

describe("backupRetention 下限", () => {
  test("0/负数/非数回退至少 1", () => {
    const p = join(dir, "config.json");
    for (const bad of [0, -3, "abc", null]) {
      writeFileSync(p, JSON.stringify({ backupRetention: bad }));
      expect(loadConfig(p).backupRetention).toBeGreaterThanOrEqual(1);
    }
  });
});

function writeManual(p: string, obj: unknown) {
  const { writeFileSync } = require("node:fs");
  writeFileSync(p, JSON.stringify(obj));
}
