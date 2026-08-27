// server/test/graph.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { bootPanelWithFake, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const panels: { stop: (b?: boolean) => void }[] = [];
const fakes: FakeGbrainHandle[] = [];
async function boot() {
  const b = await bootPanelWithFake("healthy", TOKEN);
  panels.push(b.server); fakes.push(b.fake);
  return { panelPort: b.panelPort };
}
afterEach(async () => {
  for (const p of panels.splice(0)) p.stop(true);
  for (const f of fakes.splice(0)) await f.stop();
});

describe("图谱与实体路由", () => {
  test("expand 返回归一化 nodes/edges", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("people/alice")}&depth=1&direction=both`)).json() as any;
    expect(Array.isArray(json.nodes)).toBe(true);
    expect(json.nodes.some((n: { slug: string }) => n.slug === "notes/seed-1")).toBe(true);
    expect(json.edges.some((e: { source: string; target: string }) => e.source === "notes/seed-1" && e.target === "people/alice")).toBe(true);
  });

  test("expand 缺 slug → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand`);
    expect(res.status).toBe(400);
  });

  test("entity 透传 found:true 卡片", async () => {
    const { panelPort } = await boot();
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/entity/${encodeURIComponent("people/alice")}`)).json() as any;
    expect(json.found).toBe(true);
    expect(json.card.entity.slug).toBe("people/alice");
  });
});
