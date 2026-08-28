// server/src/config.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface PanelConfig {
  gbrainBin: string;
  gbrainHome: string;
  panelPort: number;
  gbrainPort: number;
  bootstrapToken: string;
  backupDir: string;
  backupRetention: number;
  /** 检查更新时若 GitHub 直连失败的代理兜底（如 http://127.0.0.1:7897）；空 = 仅直连 */
  updateProxy: string;
  /** 检查更新的 VERSION 源（与 gbrain check-update 同源）；可注入以便测试 */
  updateUrl: string;
}

export const DEFAULTS = {
  gbrainBin: "C:\\Users\\wuji\\.bun\\bin\\gbrain.exe",
  gbrainHome: "D:\\gbrain-stock\\brain-data",
  panelPort: 7070,
  gbrainPort: 3131,
  backupDir: "D:\\gbrain-backup",
  backupRetention: 5,
  updateProxy: "",
  updateUrl: "https://raw.githubusercontent.com/garrytan/gbrain/master/VERSION",
};

export function generateToken(): string {
  return randomBytes(32).toString("base64url"); // 43 位，[A-Za-z0-9_-]
}

export function saveConfig(path: string, cfg: PanelConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

export function loadConfig(path: string): PanelConfig {
  if (!existsSync(path)) {
    const cfg = { ...DEFAULTS, bootstrapToken: generateToken() };
    saveConfig(path, cfg);
    return cfg;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PanelConfig>;
  const cfg = { ...DEFAULTS, ...parsed } as PanelConfig;
  // retention 口径（2026-08-29 M5 验收条 5 裁定）：数值合法（含 0/负）→ 钳到 ≥1；非数/缺省
  // （undefined/NaN/字符串等）→ 默认 5。旧实现 Number(x) || 5 把 0 也当缺省回 5，与文档
  // 「0 → 1」不符。放在 saveConfig 之前，缺 token 回写时落盘的也是归一后的合法值。
  const rawRetention = (parsed as { backupRetention?: unknown }).backupRetention;
  cfg.backupRetention = typeof rawRetention === "number" && Number.isFinite(rawRetention)
    ? Math.max(1, Math.floor(rawRetention))
    : DEFAULTS.backupRetention;
  if (!parsed.bootstrapToken) { cfg.bootstrapToken = generateToken(); saveConfig(path, cfg); }
  return cfg;
}
