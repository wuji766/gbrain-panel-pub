<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { NCard, NStatistic, NGrid, NGi } from "naive-ui";
import { api } from "../api/client";

const stats = ref<Record<string, unknown> | null>(null);
const health = ref<Record<string, unknown> | null>(null);
const fullStats = ref<Record<string, unknown> | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const [s, h, f] = await Promise.all([
      api<Record<string, unknown>>("/stats"),
      api<Record<string, unknown>>("/health-indicators"),
      api<Record<string, unknown>>("/full-stats").catch(() => null),
    ]);
    stats.value = s; health.value = h; fullStats.value = f;
  } catch (e) { error.value = String(e); }
});

// stats 真实形状由 discovery 确认；M1 通用渲染：数值做统计卡，其余 JSON 展示
const numericEntries = computed(() =>
  Object.entries(stats.value ?? {}).filter((e): e is [string, number] => typeof e[1] === "number"));
const otherEntries = computed(() =>
  Object.entries(stats.value ?? {}).filter(([, v]) => typeof v !== "number"));

const fullNumeric = computed(() =>
  Object.entries(fullStats.value ?? {}).filter((e): e is [string, number] => typeof e[1] === "number"));
const fullOther = computed(() =>
  Object.entries(fullStats.value ?? {}).filter(([, v]) => typeof v !== "number"));
</script>

<template>
  <div class="page">
    <h2>仪表盘</h2>
    <p v-if="error" class="error">加载失败：{{ error }}</p>
    <NGrid v-if="numericEntries.length" :cols="4" :x-gap="12" :y-gap="12">
      <NGi v-for="[k, v] in numericEntries" :key="k">
        <NCard size="small"><NStatistic :label="k" :value="v" /></NCard>
      </NGi>
    </NGrid>
    <NCard v-if="otherEntries.length" title="统计（其他字段）" size="small">
      <pre>{{ JSON.stringify(Object.fromEntries(otherEntries), null, 2) }}</pre>
    </NCard>
    <NCard title="内容统计（full-stats）" size="small" style="margin-top: 12px">
      <NGrid v-if="fullNumeric.length" :cols="4" :x-gap="12" :y-gap="12">
        <NGi v-for="[k, v] in fullNumeric" :key="k">
          <NStatistic :label="k" :value="v" />
        </NGi>
      </NGrid>
      <pre v-if="fullOther.length">{{ JSON.stringify(Object.fromEntries(fullOther), null, 2) }}</pre>
      <p v-if="!fullStats" class="muted">full-stats 不可用（502 时隐藏）</p>
    </NCard>
    <NCard title="健康指标" size="small">
      <pre>{{ health ? JSON.stringify(health, null, 2) : "…" }}</pre>
    </NCard>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.error { color: #d03050; }
.muted { color: #888; font-size: 12px; }
</style>
