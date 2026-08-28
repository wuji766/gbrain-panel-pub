// server/test/app.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { bootPanelWithFake } from "./helpers";
import { createApp } from "../src/app";
import type { PanelConfig } from "../src/config";
import type { Orchestrator } from "../src/orchestrator";
import type { GbrainClient } from "../src/gbrain-client";
import type { BackupManager } from "../src/backup";

const TOKEN = "test-token-0123456789abcdef0123456789";
const panels: { stop: (b?: boolean) => void }[] = [];
const fakes: { stop(): Promise<void> }[] = [];

async function boot(mode: "healthy" | "foreign" = "healthy") {
  const b = await bootPanelWithFake(mode, TOKEN);
  panels.push(b.server); fakes.push(b.fake);
  return { panelPort: b.panelPort, fake: b.fake };
}

afterEach(async () => {
  for (const p of panels.splice(0)) p.stop(true);
  for (const f of fakes.splice(0)) await f.stop();
});

describe("panel API（attached 模式）", () => {
  test("/api/status 反映 attached 与端口", async () => {
    const { panelPort, fake } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state).toBe("attached");
    expect(json.effectivePort).toBe(fake.port);
  }, 15000);

  test("/api/stats 代理 fake 的 admin 接口", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(await res.json()).toEqual({ pages: 42, facts: 100, sources: 3 });
  }, 15000);

  test("下游死掉时 /api/stats 返回 502 + error", async () => {
    const { panelPort, fake } = await boot();
    await fake.stop();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBeTruthy();
  }, 15000);

  test("/api/stale-lock 无锁时 present:false", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/stale-lock`)).json();
    expect(json.present).toBe(false);
  }, 15000);
});

describe("静态托管路径穿越防护", () => {
  test("GET /..%5C..%5Cpackage.json（Windows %5C 向量）必须 404，不得读出 dist 外文件", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/..%5C..%5Cpackage.json`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.includes("gbrain-panel")).toBe(false); // 不得泄露仓库根 package.json 内容
  }, 15000);
});

describe("静态 catch-all 带体请求不崩溃（Bun panic 回归）", () => {
  test("POST 带 body 打未知路径后面板仍存活", async () => {
    const b = await bootPanelWithFake("healthy", TOKEN);
    panels.push(b.server); fakes.push(b.fake);
    const { panelPort } = b;
    const res = await fetch(`http://127.0.0.1:${panelPort}/definitely/not/a/route`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: 1 }),
    });
    expect([200, 404]).toContain(res.status);
    const alive = await fetch(`http://127.0.0.1:${panelPort}/api/status`);
    expect(alive.status).toBe(200);
  }, 15000);
});

describe("index.html 禁缓存", () => {
  test("SPA 回退响应带 Cache-Control: no-cache", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/`);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  }, 15000);
});

describe("panel-config 掩蔽", () => {
  test("bootstrapToken 不出现、其余字段原样", async () => {
    const { panelPort, fake } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/panel-config`)).json() as Record<string, unknown>;
    expect(json.bootstrapToken).toBe("<已隐藏>");
    expect(JSON.stringify(json)).not.toContain(String(TOKEN));
    expect(json.gbrainPort).toBe(fake.port);
  }, 15000);
});

describe("/api/status backupRunning 直测（M-1）", () => {
  const mkApp = (backup?: { isRunning(): boolean }) => {
    const cfg = { panelPort: 0, gbrainPort: 0, backupDir: "unused" } as unknown as Parameters<typeof createApp>[0]["cfg"];
    const orch = { getState: () => "own", getEffectivePort: () => 3131, getRecentLogs: () => [] } as unknown as Orchestrator;
    const client = {} as GbrainClient;
    return createApp({ cfg, orch, client, backup: backup as unknown as BackupManager | undefined });
  };
  test("注入 isRunning()=true 的 backup → backupRunning:true", async () => {
    const res = await mkApp({ isRunning: () => true }).request("/api/status");
    expect((await res.json() as Record<string, unknown>).backupRunning).toBe(true);
  });
  test("未注入 backup → backupRunning:false", async () => {
    const res = await mkApp().request("/api/status");
    expect((await res.json() as Record<string, unknown>).backupRunning).toBe(false);
  });
});
