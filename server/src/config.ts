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
}

export const DEFAULTS = {
  gbrainBin: "C:\\Users\\wuji\\.bun\\bin\\gbrain.exe",
  gbrainHome: "D:\\gbrain-stock\\brain-data",
  panelPort: 7070,
  gbrainPort: 3131,
  backupDir: "D:\\gbrain-backup",
  backupRetention: 5,
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
  if (!parsed.bootstrapToken) { cfg.bootstrapToken = generateToken(); saveConfig(path, cfg); }
  return cfg;
}
