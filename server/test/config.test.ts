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

describe("backupRetention 口径：0/负→1（钳制），非数/缺省→5（默认），小数→floor（M6）", () => {
  const loadWith = (raw: unknown): number => {
    const dir = mkdtempSync(join(import.meta.dir, ".tmp", "cfg-ret-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, JSON.stringify({ bootstrapToken: "t", ...(raw === undefined ? {} : { backupRetention: raw }) }));
      return loadConfig(p).backupRetention;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  test("0 → 1（钳制，不是回退默认）", () => expect(loadWith(0)).toBe(1));
  test("-3 → 1", () => expect(loadWith(-3)).toBe(1));
  test("2.9 → 2（floor）", () => expect(loadWith(2.9)).toBe(2));
  test("缺省 → 5（默认）", () => expect(loadWith(undefined)).toBe(5));
  test("非数 → 5（默认）", () => expect(loadWith("abc")).toBe(5));
});

function writeManual(p: string, obj: unknown) {
  const { writeFileSync } = require("node:fs");
  writeFileSync(p, JSON.stringify(obj));
}
