<!-- web/src/views/Jobs.vue -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { NCard, NStatistic, NGrid, NGi, NDataTable, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Snapshot { ts_ms?: number; by_type?: { name: string; total: number; completed: number; failed: number; dead: number }[]; queue_health?: { waiting?: number; active?: number; stalled?: number }; lease_pressure_1h?: number; top_errors?: { cluster: string; count: number }[]; budget_owners?: { owner_id: string; remaining_cents: number; total_spent_cents: number }[] }

const message = useMessage();
const snap = ref<Snapshot | null>(null);
let timer: number | undefined;

async function load() {
  try { snap.value = await api<Snapshot>("/ops/jobs"); } catch (e) { message.error(String(e)); }
}

const typeColumns = [
  { title: "类型", key: "name" },
  { title: "总数", key: "total" },
  { title: "完成", key: "completed" },
  { title: "失败", key: "failed" },
  { title: "死信", key: "dead" },
];
const errColumns = [
  { title: "错误簇", key: "cluster" },
  { title: "次数", key: "count" },
];

onMounted(() => { load(); timer = window.setInterval(load, 5000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="page">
    <h2>任务队列 <NTag size="small" type="info">每 5 秒刷新</NTag></h2>
    <NGrid v-if="snap" :cols="5" :x-gap="12" :y-gap="12">
      <NGi><NCard size="small"><NStatistic label="等待" :value="snap.queue_health?.waiting ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="执行中" :value="snap.queue_health?.active ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="停滞" :value="snap.queue_health?.stalled ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="租约压力(1h)" :value="snap.lease_pressure_1h ?? 0" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="快照时间" :value="snap.ts_ms ? new Date(snap.ts_ms).toLocaleTimeString() : '-'" /></NCard></NGi>
    </NGrid>
    <NCard title="按类型" size="small" style="margin-top: 12px">
      <NDataTable :columns="typeColumns" :data="snap?.by_type ?? []" :bordered="false" size="small" />
    </NCard>
    <NCard title="Top 错误" size="small" style="margin-top: 12px">
      <NDataTable :columns="errColumns" :data="snap?.top_errors ?? []" :bordered="false" size="small" />
    </NCard>
    <NCard title="预算属主" size="small" style="margin-top: 12px">
      <pre>{{ JSON.stringify(snap?.budget_owners ?? [], null, 2) }}</pre>
    </NCard>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
</style>
