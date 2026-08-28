// M3 验收种子数据脚本（环境准备用，非业务代码）
// 通道与面板一致：bootstrap token 登录 3131 admin -> 自签 API key -> /mcp tools/call
// 产出：31 页面（seed/hub + note×12 + doc×8 + diary×5 + event×5）、约 24 条边、6 条事实（1 条已过期）
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("D:/gbrain-panel/config.json", "utf8"));
const PORT = cfg.gbrainPort ?? 3131;

const loginRes = await fetch(`http://127.0.0.1:${PORT}/admin/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: cfg.bootstrapToken }),
});
if (!loginRes.ok) throw new Error(`admin 登录失败: HTTP ${loginRes.status}`);
const cookie = /gbrain_admin=([^;]+)/.exec(loginRes.headers.get("set-cookie") ?? "")?.[1];
if (!cookie) throw new Error("登录响应无 gbrain_admin cookie");

const keyRes = await fetch(`http://127.0.0.1:${PORT}/admin/api/api-keys`, {
  method: "POST",
  headers: { cookie: `gbrain_admin=${cookie}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "panel-m3-seed" }),
});
if (!keyRes.ok) throw new Error(`API key 签发失败: HTTP ${keyRes.status} ${await keyRes.text()}`);
const keyJson = await keyRes.json();
const apiKey = keyJson.key ?? keyJson.api_key ?? keyJson.token;
if (!apiKey) throw new Error("api-keys 响应无 key 字段: " + JSON.stringify(keyJson).slice(0, 200));

let rpcId = 0;
async function call(op, args = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: op, arguments: args } }),
  });
  if (!res.ok) throw new Error(`${op} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const ctype = res.headers.get("content-type") ?? "";
  const payload = ctype.includes("text/event-stream")
    ? JSON.parse((res.text && (await res.text())).split(/\r?\n/).find(l => l.startsWith("data:"))?.slice(5).trim() ?? "{}")
    : await res.json();
  if (payload.error) throw new Error(`${op} rpc 错误: ${JSON.stringify(payload.error)}`);
  if (payload.result?.isError) throw new Error(`${op} 工具级错误: ${String(payload.result?.content?.[0]?.text).slice(0, 300)}`);
  const text = payload.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text ?? payload.result; }
}

const pages = [
  { slug: "seed/hub", type: "doc", content: "# 验收种子枢纽\n\nM3 验收图谱枢纽页：所有种子文档与笔记在此汇聚，用于验证一度邻居展开。" },
  ...Array.from({ length: 12 }, (_, i) => ({
    slug: `seed/note-${String(i + 1).padStart(2, "0")}`,
    type: "note",
    content: `# 验收种子笔记 ${i + 1}\n\n第 ${i + 1} 条验收种子笔记：语义检索与图谱展开的测试内容，主题编号 S-N-${i + 1}。`,
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    slug: `seed/doc-${String(i + 1).padStart(2, "0")}`,
    type: "doc",
    content: `# 验收种子文档 ${i + 1}\n\n第 ${i + 1} 篇验收种子文档：挂在枢纽下的说明文档，主题编号 S-D-${i + 1}。`,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    slug: `seed/diary-${String(i + 1).padStart(2, "0")}`,
    type: "diary",
    content: `# 验收种子日记 ${i + 1}\n\n第 ${i + 1} 篇验收种子日记：时间线分组验证数据，主题编号 S-R-${i + 1}。`,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    slug: `seed/event-${String(i + 1).padStart(2, "0")}`,
    type: "event",
    content: `# 验收种子事件 ${i + 1}\n\n第 ${i + 1} 条验收种子事件：图谱与时间线交叉验证数据，主题编号 S-E-${i + 1}。`,
  })),
];

let okPages = 0;
for (const p of pages) {
  await call("capture", { content: p.content, slug: p.slug, type: p.type });
  okPages++;
}
console.log(`pages captured: ${okPages}/${pages.length}`);

const links = [
  ...Array.from({ length: 8 }, (_, i) => ({ from: "seed/hub", to: `seed/doc-${String(i + 1).padStart(2, "0")}`, link_type: "references" })),
  ...Array.from({ length: 11 }, (_, i) => ({ from: `seed/note-${String(i + 1).padStart(2, "0")}`, to: `seed/note-${String(i + 2).padStart(2, "0")}`, link_type: "related" })),
  { from: "seed/note-01", to: "seed/hub", link_type: "related" },
  { from: "seed/doc-01", to: "seed/note-05", link_type: "references" },
  { from: "seed/diary-01", to: "seed/note-03", link_type: "related" },
  { from: "seed/event-01", to: "seed/hub", link_type: "related" },
  { from: "seed/diary-02", to: "seed/event-02", link_type: "related" },
];
let okLinks = 0;
for (const l of links) {
  try { await call("add_link", l); okLinks++; }
  catch (e) { console.warn(`add_link ${l.from}->${l.to}: ${String(e).slice(0, 120)}`); }
}
console.log(`links added: ${okLinks}/${links.length}`);

const facts = [
  { fact: "Alice 是 gbrain 面板验收测试的负责人", provenance: "panel-m3-seed", entity: "people/alice", kind: "fact" },
  { fact: "Alice 偏好用图谱视图检查页面关联", provenance: "panel-m3-seed", entity: "people/alice", kind: "preference" },
  { fact: "Bob 负责时间线视图的回归验证", provenance: "panel-m3-seed", entity: "people/bob", kind: "commitment" },
  { fact: "Apollo 项目使用 seed/hub 页面作为文档枢纽", provenance: "panel-m3-seed", entity: "projects/apollo", kind: "fact" },
  { fact: "M3 验收第二轮补充的无归属事实（未绑实体）", provenance: "panel-m3-seed", kind: "fact" },
  { fact: "这条事实已过期（ttl 设为过去时间，验证含已过期视图）", provenance: "panel-m3-seed", entity: "people/alice", kind: "fact", ttl: "2026-08-26T00:00:00Z" },
];
let okFacts = 0;
for (const f of facts) {
  try { await call("remember", f); okFacts++; }
  catch (e) { console.warn(`remember "${f.fact.slice(0, 20)}": ${String(e).slice(0, 120)}`); }
}
console.log(`facts remembered: ${okFacts}/${facts.length}`);

// 校验：traverse_graph 真实返回形状顺带记录（M4 归一化用）
const trav = await call("traverse_graph", { slug: "seed/hub", depth: 1, direction: "both" });
console.log("traverse_graph(seed/hub, depth1) 原始形状键:", Object.keys(trav ?? {}));
console.log(JSON.stringify(trav).slice(0, 800));

const list = await call("list_pages", { limit: 100, sort: "updated_desc" });
const rows = Array.isArray(list) ? list : list?.pages ?? [];
console.log(`list_pages rows: ${rows.length}`);
