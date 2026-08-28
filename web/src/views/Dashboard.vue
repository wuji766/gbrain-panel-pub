<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { NCard, NStatistic, NGrid, NGi, NAlert, NButton, NTag } from "naive-ui";
import { api } from "../api/client";

const stats = ref<Record<string, unknown> | null>(null);
const health = ref<Record<string, unknown> | null>(null);
const fullStats = ref<Record<string, unknown> | null>(null);
const error = ref<string | null>(null);

const update = ref<{ current: string | null; latest: string | null; networkError: string | null; upToDate: boolean | null } | null>(null);
const checking = ref(false);
async function checkUpdate() {
  checking.value = true;
  try { update.value = await api<typeof update.value>("/update-check"); }
  catch (e) { update.value = { current: null, latest: null, networkError: String(e), upToDate: null }; }
  finally { checking.value = false; }
}

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

// stats 字段 → 中文标签 + 口径注释；未命中映射表的字段原样显示字段名
const statLabels: Record<string, string> = {
  connected_agents: "已连接 Agents（含已撤销客户端）",
  active_tokens: "活跃 OAuth Token（未过期）",
  active_api_keys: "活跃 API Key（未撤销，含同名历史累积）",
  requests_today: "近 24h 请求数",
};

const fullNumeric = computed(() =>
  Object.entries(fullStats.value ?? {}).filter((e): e is [string, number] => typeof e[1] === "number"));
const fullOther = computed(() =>
  Object.entries(fullStats.value ?? {}).filter(([, v]) => typeof v !== "number"));
</script>

<template>
  <div class="page">
    <h2>仪表盘</h2>
    <NAlert type="info" :show-icon="true" style="margin-bottom: 12px">
      启动前提：面板会持有 gbrain 数据库锁（PGLite 单写者）。启动面板前请先关闭 ZCode 的 gbrain MCP 会话与 gbrain CLI；面板运行期间它们不可用，退出面板（Ctrl+C）后自动恢复。
    </NAlert>
    <p v-if="error" class="error">加载失败：{{ error }}</p>
    <NCard title="gbrain 版本" size="small" style="margin-bottom: 12px">
      <div class="update-row">
        <NButton size="small" :loading="checking" @click="checkUpdate">检查更新</NButton>
        <template v-if="update">
          <span>当前：{{ update.current ?? "未知" }}</span>
          <span>最新：{{ update.latest ?? "未知" }}</span>
          <NTag v-if="update.upToDate === true" type="success" size="small">已是最新</NTag>
          <NTag v-else-if="update.upToDate === false" type="warning" size="small">有新版本</NTag>
          <NTag v-else-if="update.networkError" type="error" size="small">检查失败（网络不通，可在 config.json 配 updateProxy）</NTag>
        </template>
      </div>
      <p v-if="update && update.upToDate === false" class="muted">
        面板不会自动升级。请退出面板后手动升级（源码安装：git pull + bun install；二进制安装：gbrain self-upgrade），再重新启动面板。
      </p>
    </NCard>
    <NGrid v-if="numericEntries.length" :cols="4" :x-gap="12" :y-gap="12">
      <NGi v-for="[k, v] in numericEntries" :key="k">
        <NCard size="small"><NStatistic :label="statLabels[k] ?? k" :value="v" /></NCard>
      </NGi>
    </NGrid>
    <p v-if="numericEntries.length" class="muted" style="margin-top: 8px">口径说明：active_api_keys 统计未撤销的 access_tokens 行（与 Agents 页同口径）；gbrain 自身的 bootstrap-harness 会按名累积，可用 Agents 页按名撤销清理。</p>
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
.update-row { display: flex; gap: 14px; align-items: center; }
</style>
