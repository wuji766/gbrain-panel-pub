// server/test/orchestrator.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { Orchestrator, type OrchState } from "../src/orchestrator";
import { probeHealth } from "../src/health";
import { startFakeGbrain, getFreePort, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const FIXTURE = join(import.meta.dir, "fixtures", "fake-gbrain.ts");
const spawned: FakeGbrainHandle[] = [];
const orchs: Orchestrator[] = [];

function makeOrch(port: number, opts: { healthTimeoutMs?: number } = {}) {
  const orch = new Orchestrator(
    { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 },
    {
      spawnSpec: { bin: process.execPath, baseArgs: [FIXTURE] },
      healthTimeoutMs: opts.healthTimeoutMs ?? 8000,
      pollIntervalMs: 100,
    },
  );
  orchs.push(orch);
  return orch;
}

afterEach(async () => {
  for (const o of orchs.splice(0)) await o.killServe();
  for (const f of spawned.splice(0)) await f.stop();
});

describe("Orchestrator.start", () => {
  test("无 serve 时 spawn 自己的子进程 → own", async () => {
    const port = await getFreePort();
    const orch = makeOrch(port);
    expect(await orch.start()).toBe("own");
    expect(await probeHealth(port, 2000)).toBe(true);
    expect(orch.getEffectivePort()).toBe(port);
    expect(orch.getRecentLogs().join("\n")).not.toBeNull();
  });

  test("已有 token 匹配的 serve → attached，killServe 不杀它", async () => {
    const port = await getFreePort();
    const fake = await startFakeGbrain({ mode: "healthy", token: TOKEN, port });
    spawned.push(fake);
    const orch = makeOrch(port);
    expect(await orch.start()).toBe("attached");
    await orch.killServe();
    expect(orch.getState()).toBe("stopped");
    expect(await probeHealth(port, 1000)).toBe(true); // fake 仍活着
    await fake.stop();
  });

  test("端口上有 token 不匹配的 serve → foreign", async () => {
    const port = await getFreePort();
    const fake = await startFakeGbrain({ mode: "foreign", token: "other", port });
    spawned.push(fake);
    const orch = makeOrch(port);
    expect(await orch.start()).toBe("foreign");
  });

  test("子进程秒退 → error，日志有退出码", async () => {
    const port = await getFreePort();
    const orch = new Orchestrator(
      { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 },
      { spawnSpec: { bin: process.execPath, baseArgs: [FIXTURE] }, healthTimeoutMs: 8000, pollIntervalMs: 100, spawnEnvExtra: { FAKE_MODE: "crash" } },
    );
    orchs.push(orch);
    expect(await orch.start()).toBe("error");
    expect(orch.getRecentLogs().join("\n")).toMatch(/code=1|exited/);
  });

  test("健康超时（hang 模式）→ error", async () => {
    const port = await getFreePort();
    const orch = new Orchestrator(
      { gbrainBin: "", gbrainHome: "", panelPort: 0, gbrainPort: port, bootstrapToken: TOKEN, backupDir: "", backupRetention: 5 },
      { spawnSpec: { bin: process.execPath, baseArgs: [FIXTURE] }, healthTimeoutMs: 1500, pollIntervalMs: 100, spawnEnvExtra: { FAKE_MODE: "hang" } },
    );
    orchs.push(orch);
    expect(await orch.start()).toBe("error");
  });
});

describe("killServe", () => {
  test("own 模式杀掉整棵进程树并置 stopped", async () => {
    const port = await getFreePort();
    const orch = makeOrch(port);
    await orch.start();
    await orch.killServe();
    expect(orch.getState()).toBe("stopped");
    await new Promise(r => setTimeout(r, 300));
    expect(await probeHealth(port, 500)).toBe(false);
  });
});

describe("spawnOnFallbackPort", () => {
  test("foreign 时在 gbrainPort+1 起自己的 serve", async () => {
    const foreignPort = await getFreePort();
    const fake = await startFakeGbrain({ mode: "foreign", token: "other", port: foreignPort });
    spawned.push(fake);
    const orch = makeOrch(foreignPort);
    await orch.start();
    expect(await orch.spawnOnFallbackPort()).toBe("own");
    expect(orch.getEffectivePort()).toBeGreaterThan(foreignPort);
    expect(orch.getEffectivePort()).toBeLessThanOrEqual(foreignPort + 5);
  });
});
