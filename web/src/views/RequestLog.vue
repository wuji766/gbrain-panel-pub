<!-- web/src/views/RequestLog.vue -->
<script setup lang="ts">
import { ref, h, onMounted, onUnmounted } from "vue";
import { NInput, NButton, NDataTable, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Row { id?: number; token_name?: string; agent_name?: string; operation?: string; latency_ms?: number; status?: string; params?: string; error_message?: string | null; created_at?: string }

const message = useMessage();
const rows = ref<Row[]>([]);
const total = ref(0);
const pages = ref(1);
const page = ref(1);
const agent = ref("");
const operation = ref("");
const status = ref("");
const live = ref(false);
let es: EventSource | null = null;

async function load() {
  try {
    const params = new URLSearchParams({ page: String(page.value), agent: agent.value || "all" });
    if (operation.value.trim()) params.set("operation", operation.value.trim());
    if (status.value.trim()) params.set("status", status.value.trim());
    const json = await api<{ rows?: Row[]; total?: number; pages?: number }>(`/ops/requests?${params}`);
    rows.value = json.rows ?? []; total.value = json.total ?? 0; pages.value = json.pages ?? 1;
  } catch (e) { message.error(String(e)); }
}

function toggleLive() {
  if (es) { es.close(); es = null; live.value = false; return; }
  es = new EventSource("/api/events");
  let liveSeq = 0;
  let warned = false; // 同一轮断连只提示一次，避免原生重连期间 toast 刷屏
  es.onopen = () => { warned = false; };
  es.onmessage = ev => {
    try {
      const d = JSON.parse(ev.data) as { agent?: string; operation?: string; latency_ms?: number; status?: string; timestamp?: string };
      const okAgent = !agent.value.trim() || agent.value.trim() === "all" || (d.agent ?? "").includes(agent.value.trim());
      const okOp = !operation.value.trim() || (d.operation ?? "").includes(operation.value.trim());
      const okStatus = !status.value.trim() || (d.status ?? "").includes(status.value.trim());
      if (!(okAgent && okOp && okStatus)) return;
      rows.value.unshift({
        id: -(Date.now() + ++liveSeq),           // 负数合成 id 避免与库 id 冲突
        agent_name: d.agent,
        operation: d.operation,
        latency_ms: d.latency_ms,
        status: d.status,
        created_at: d.timestamp,
      });
      rows.value = rows.value.slice(0, 100);
    } catch { /* 忽略非 JSON */ }
  };
  es.onerror = () => {
    if (es && es.readyState === EventSource.CLOSED) {
      // HTTP 层错误（如备份期代理 502）会置 CLOSED 终态且不再自动重连——回退为诚实断开
      es.close(); es = null; live.value = false;
      message.error("实时流已断开（服务暂不可用）——恢复后请重新开启");
      return;
    }
    if (!warned) { warned = true; message.warning("连接中断，自动重连中…"); }
  };
  live.value = true;
}

const statusType = (s: string | undefined) => s === "success" ? "success" : s?.startsWith("success") ? "info" : "error";

const columns = [
  { title: "时间", key: "created_at", render: (r: Row) => (r.created_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "Agent", key: "agent_name", render: (r: Row) => r.agent_name ?? r.token_name ?? "" },
  { title: "操作", key: "operation" },
  { title: "耗时", key: "latency_ms", render: (r: Row) => `${r.latency_ms ?? 0}ms` },
  { title: "状态", key: "status", render: (r: Row) => h(NTag, { size: "small", type: statusType(r.status) }, { default: () => r.status ?? "" }) },
];

onMounted(load);
onUnmounted(() => es?.close());
</script>

<template>
  <div class="page">
    <h2>请求日志</h2>
    <div class="toolbar">
      <NInput v-model:value="agent" placeholder="agent（all=全部）" clearable style="width: 180px" @keyup.enter="page = 1; load()" />
      <NInput v-model:value="operation" placeholder="操作过滤" clearable style="width: 160px" @keyup.enter="page = 1; load()" />
      <NInput v-model:value="status" placeholder="状态过滤" clearable style="width: 140px" @keyup.enter="page = 1; load()" />
      <NButton size="small" @click="page = 1; load()">查询</NButton>
      <NButton size="small" :type="live ? 'success' : 'default'" @click="toggleLive">{{ live ? "实时中（点击停止）" : "实时流" }}</NButton>
      <NButton v-if="page > 1" size="small" @click="page--; load()">上一页</NButton>
      <NButton v-if="page < pages" size="small" @click="page++; load()">下一页</NButton>
      <span class="muted">共 {{ total }} 条（第 {{ page }}/{{ pages }} 页）</span>
    </div>
    <p v-if="live" class="muted" style="margin: 0 0 8px">实时模式：查询/翻页会替换列表（实时行随之清除）；连接中断自动重连</p>
    <NDataTable :columns="columns" :data="rows" :bordered="false" size="small" :row-key="(r: Row) => r.id ?? 0" />
    <NTag v-if="live" type="success" size="small" style="margin-top: 8px">实时事件插入列表头部（最新 100 条）</NTag>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.muted { color: #888; font-size: 12px; }
</style>
