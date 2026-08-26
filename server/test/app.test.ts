// server/test/app.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { Orchestrator } from "../src/orchestrator";
import { GbrainClient } from "../src/gbrain-client";
import { startFakeGbrain, getFreePort, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const handles: FakeGbrainHandle[] = [];
const panels: ReturnType<typeof Bun.serve>[] = [];

async function bootPanelWithFake(fakeMode: "healthy" | "foreign" = "healthy") {
  const fake = await startFakeGbrain({ mode: fakeMode, token: TOKEN });
  handles.push(fake);
  const cfg = { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: fake.port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 };
  const orch = new Orchestrator(cfg, { spawnSpec: { bin: "unused", baseArgs: [] } });
  await orch.start();
  const client = new GbrainClient(orch.getEffectivePort(), TOKEN);
  const app = createApp({ cfg, orch, client });
  const panelPort = await getFreePort();
  const server = Bun.serve({ port: panelPort, hostname: "127.0.0.1", fetch: app.fetch });
  panels.push(server);
  return { panelPort, fake };
}

afterEach(async () => {
  for (const s of panels.splice(0)) s.stop(true);
  for (const h of handles.splice(0)) await h.stop();
});

describe("panel API（attached 模式）", () => {
  test("/api/status 反映 attached 与端口", async () => {
    const { panelPort, fake } = await bootPanelWithFake("healthy");
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state).toBe("attached");
    expect(json.effectivePort).toBe(fake.port);
  });

  test("/api/stats 代理 fake 的 admin 接口", async () => {
    const { panelPort } = await bootPanelWithFake("healthy");
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(await res.json()).toEqual({ pages: 42, facts: 100, sources: 3 });
  });

  test("下游死掉时 /api/stats 返回 502 + error", async () => {
    const { panelPort, fake } = await bootPanelWithFake("healthy");
    await fake.stop();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBeTruthy();
  });

  test("/api/stale-lock 无锁时 present:false", async () => {
    const { panelPort } = await bootPanelWithFake("healthy");
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/stale-lock`)).json();
    expect(json.present).toBe(false);
  });
});
