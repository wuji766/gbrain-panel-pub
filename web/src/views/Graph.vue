<!-- web/src/views/Graph.vue -->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { NInput, NButton, NCard, NTag, NSpin, useMessage } from "naive-ui";
import { Graph } from "@antv/g6";
// 适配留痕（G6 5.1.1 实测 typings）：on<T extends IEvent> 的泛型约束不接受简报内联的
// { target: { id: string } }，改用官方导出的 IElementEvent；labelText 回调参数用官方
// NodeData（其 data 是 Record<string, unknown>，内部 String() 收窄）。
import type { NodeData, IElementEvent } from "@antv/g6";
import { api } from "../api/client";

interface GNode { id: string; label: string; nodeType: string }
interface GEdge { source: string; target: string; type: string }
interface EntityCard { found?: boolean; card?: { entity?: { slug?: string; title?: string; type?: string }; aka?: string[]; summary?: string; edges?: { type?: string; direction?: string; slug?: string }[]; backlink_count?: number; active_fact_count?: number }; suggestions?: { slug?: string; title?: string }[] }

const router = useRouter();
const message = useMessage();
const container = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const filterType = ref("");
const card = ref<EntityCard | null>(null);
let graph: Graph | null = null;
const nodes = new Map<string, GNode>();
const edges = new Map<string, GEdge>();

function pushNode(id: string, label: string, nodeType: string) {
  if (!nodes.has(id)) nodes.set(id, { id, label, nodeType });
}
function pushEdge(e: GEdge) {
  const key = `${e.source}->${e.target}`;
  if (!edges.has(key)) edges.set(key, e);
}

async function seed() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: "30", sort: "updated" });
    if (filterType.value.trim()) params.set("type", filterType.value.trim());
    // 防御式消费（与 Pages.vue 一致）：面板 /api/pages 已归一化为 {pages,total}，
    // 但兼容裸数组/results（M2 BUG-1 教训：形状不符时静默清空）。
    const json = await api<{ pages?: { slug?: string; title?: string; type?: string }[]; results?: { slug?: string; title?: string; type?: string }[] } | { slug?: string; title?: string; type?: string }[]>(`/pages?${params}`);
    const arr = Array.isArray(json) ? json : (json.pages ?? json.results ?? []);
    for (const p of arr) {
      if (p.slug) pushNode(p.slug, p.title ?? p.slug, p.type ?? "");
    }
    await redraw();
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function expand(slug: string) {
  loading.value = true;
  try {
    const json = await api<{ nodes?: { slug?: string; title?: string; type?: string }[]; edges?: { source: string; target: string; type?: string }[] }>(
      `/graph/expand?slug=${encodeURIComponent(slug)}&depth=1&direction=both`);
    for (const n of json.nodes ?? []) if (n.slug) pushNode(n.slug, n.title ?? n.slug, n.type ?? "");
    for (const e of json.edges ?? []) { pushNode(e.source, e.source, ""); pushNode(e.target, e.target, ""); pushEdge({ source: e.source, target: e.target, type: e.type ?? "link" }); }
    await redraw();
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function showCard(slug: string) {
  try {
    card.value = await api<EntityCard>(`/entity/${encodeURIComponent(slug)}`);
    await expand(slug); // 点节点即懒展开一度邻居
  } catch (e) { message.error(String(e)); }
}

async function redraw() {
  const data = {
    nodes: [...nodes.values()].map(n => ({ id: n.id, data: { label: n.label, nodeType: n.nodeType } })),
    edges: [...edges.values()].map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  };
  if (!graph && container.value) {
    graph = new Graph({
      container: container.value,
      autoFit: "view",
      data,
      node: { style: { size: 36, labelText: (d: NodeData) => String(d.data?.label ?? d.id) } },
      edge: { style: { endArrow: true } },
      layout: { type: "force", linkDistance: 130 },
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
    });
    // 适配留痕：5.1.1 中元素事件 payload 的 target 即 G6 Element（官方 tooltip 插件
    // 同款取 event.target.id），事件泛型用 IElementEvent。
    graph.on<IElementEvent>("node:click", (evt) => { void showCard(evt.target.id); });
    graph.on<IElementEvent>("node:dblclick", (evt) => { router.push(`/pages/${encodeURIComponent(evt.target.id)}`); });
    await graph.render();
  } else if (graph) {
    // 适配留痕：5.1.1 的 setData 返回 void（非 Promise），await void 合法；
    // 更新数据后仍需显式 render() 触发重算布局与绘制。
    graph.setData(data);
    await graph.render();
  }
}

onMounted(seed);
onBeforeUnmount(() => { graph?.destroy(); graph = null; });
</script>

<template>
  <div class="page">
    <h2>知识图谱</h2>
    <div class="toolbar">
      <NInput v-model:value="filterType" placeholder="种子类型过滤（如 note）" clearable style="width: 200px" @keyup.enter="seed" />
      <NButton size="small" @click="nodes.clear(); edges.clear(); card = null; seed()">重置</NButton>
      <span class="muted">单击节点：展开一度邻居 + 实体卡；双击：进详情。节点 {{ nodes.size }} / 边 {{ edges.size }}</span>
    </div>
    <div class="body">
      <div class="canvas-wrap">
        <NSpin :show="loading"><div ref="container" class="canvas"></div></NSpin>
      </div>
      <NCard v-if="card" class="side" :title="card.card?.entity?.slug ?? '实体'" size="small">
        <template v-if="card.found && card.card">
          <p><NTag size="small">{{ card.card.entity?.type ?? "?" }}</NTag> {{ card.card.entity?.title }}</p>
          <p class="muted">{{ card.card.summary ?? "（无摘要）" }}</p>
          <p class="muted">反链 {{ card.card.backlink_count ?? 0 }} · 活跃事实 {{ card.card.active_fact_count ?? 0 }}</p>
          <div v-if="card.card.edges?.length">
            <p class="muted">关联：</p>
            <p v-for="(e, i) in card.card.edges.slice(0, 10)" :key="i" class="muted">
              [{{ e.direction }}/{{e.type}}] {{ e.slug }}
            </p>
          </div>
        </template>
        <template v-else>
          <p class="muted">未找到实体。建议：</p>
          <p v-for="(s, i) in card.suggestions?.slice(0, 5)" :key="i" class="muted">{{ s.slug }} — {{ s.title }}</p>
        </template>
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.muted { color: #888; font-size: 12px; }
.body { display: flex; gap: 12px; }
.canvas-wrap { flex: 1; min-width: 0; }
.canvas { height: 560px; border: 1px solid #e0e0e6; border-radius: 6px; }
.side { width: 280px; flex-shrink: 0; }
</style>
