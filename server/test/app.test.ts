// server/test/app.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { bootPanelWithFake } from "./helpers";

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
  });

  test("/api/stats 代理 fake 的 admin 接口", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(await res.json()).toEqual({ pages: 42, facts: 100, sources: 3 });
  });

  test("下游死掉时 /api/stats 返回 502 + error", async () => {
    const { panelPort, fake } = await boot();
    await fake.stop();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/stats`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBeTruthy();
  });

  test("/api/stale-lock 无锁时 present:false", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/stale-lock`)).json();
    expect(json.present).toBe(false);
  });
});

describe("静态托管路径穿越防护", () => {
  test("GET /..%5C..%5Cpackage.json（Windows %5C 向量）必须 404，不得读出 dist 外文件", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/..%5C..%5Cpackage.json`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.includes("gbrain-panel")).toBe(false); // 不得泄露仓库根 package.json 内容
  });
});
