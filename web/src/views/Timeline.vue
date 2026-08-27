<!-- web/src/views/Timeline.vue -->
<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NInput, NButton, NSpin, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Row { slug?: string; title?: string; type?: string; updated_at?: string }

const router = useRouter();
const message = useMessage();
const rows = ref<Row[]>([]);
const typeFilter = ref("");
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: "100", sort: "updated" });
    if (typeFilter.value.trim()) params.set("type", typeFilter.value.trim());
    const json = await api<{ pages?: Row[] }>(`/pages?${params}`);
    rows.value = json.pages ?? [];
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

// gbrain 无跨页 timeline op（规格 §9.6）：按更新日分组的“近期页面流”
const byDay = computed(() => {
  const groups = new Map<string, Row[]>();
  for (const r of rows.value) {
    const day = (r.updated_at ?? "").slice(0, 10) || "未知日期";
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(r);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
});

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>时间线（近期页面流）</h2>
    <p class="muted">gbrain 暂无跨页时间线接口，本视图按最后更新日期归组展示最近 100 个页面。</p>
    <div class="toolbar">
      <NInput v-model:value="typeFilter" placeholder="类型过滤" clearable style="width: 180px" @keyup.enter="load" />
      <NButton size="small" @click="load">查询</NButton>
    </div>
    <NSpin :show="loading">
      <div v-for="[day, items] in byDay" :key="day" class="day">
        <h3>{{ day }}</h3>
        <div v-for="r in items" :key="r.slug" class="item" @click="r.slug && router.push(`/pages/${encodeURIComponent(r.slug)}`)">
          <span class="time">{{ (r.updated_at ?? "").slice(11, 19) }}</span>
          <span class="title">{{ r.title ?? r.slug }}</span>
          <span class="muted">{{ r.type }} · {{ r.slug }}</span>
        </div>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.muted { color: #888; font-size: 12px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.day { margin-bottom: 16px; }
.item { padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
.item:hover { background: #f3f3f6; }
.time { font-family: Consolas, monospace; color: #888; font-size: 12px; }
.title { font-weight: 500; }
</style>
