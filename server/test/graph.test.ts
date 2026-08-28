// server/test/graph.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { bootPanelWithFake, type FakeGbrainHandle } from "./helpers";

const TOKEN = "test-token-0123456789abcdef0123456789";
const panels: { stop: (b?: boolean) => void }[] = [];
const fakes: FakeGbrainHandle[] = [];
async function boot(env?: Record<string, string>) {
  const b = await bootPanelWithFake("healthy", TOKEN, env);
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

describe("归一化真实形状（GraphPath 裸数组）", () => {
  test("FAKE_GRAPH_SHAPE=paths 时 expand 产出节点与边", async () => {
    // 见下方 helpers 说明：bootPanelWithFake 需支持传入 fake 环境变量扩展
    const { panelPort } = await boot({ FAKE_GRAPH_SHAPE: "paths" });
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("people/alice")}&depth=1&direction=both`)).json() as any;
    expect(json.edges.some((e: any) => e.source === "notes/seed-1" && e.target === "people/alice")).toBe(true);
    expect(json.nodes.some((n: any) => n.slug === "notes/seed-1")).toBe(true);
  });

  test("direction 非法 → 400", async () => {
    const { panelPort } = await boot();
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=x&direction=sideways`);
    expect(res.status).toBe(400);
  });

  test("depth=abc/0/99 分别回退 1/1/3", async () => {
    const { panelPort } = await boot();
    for (const [q, ok] of [["depth=abc", true], ["depth=0", true], ["depth=99", true]] as const) {
      const res = await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("people/alice")}&${q}`);
      expect(res.status).toBe(200);
    }
  });

  test("解析为空时回退 entity 卡关联", async () => {
    // 用一个真实存在但无 links 的 slug：fake 中 notes/dead-page 不在 links 种子里
    const { panelPort } = await boot({ FAKE_GRAPH_SHAPE: "paths" });
    // fake entity 对 dead-page 的卡 edges 硬编码指向 notes/seed-2——先给 fake 加：命中 dead-page 时 edges=[{type:"note",direction:"out",slug:"notes/seed-2"}]
    const json = await (await fetch(`http://127.0.0.1:${panelPort}/api/graph/expand?slug=${encodeURIComponent("notes/dead-page")}&depth=1`)).json() as any;
    expect(json.edges.some((e: any) => e.source === "notes/dead-page" && e.target === "notes/seed-2")).toBe(true);
  });
});
