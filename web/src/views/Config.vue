<!-- web/src/views/Config.vue：面板 config.json 只读脱敏展示 + gbrain 版本/更新检查 -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { NCard, NTag, NSpin } from "naive-ui";
import { api } from "../api/client";

// 与 server/src/app.ts /api/update-check 响应对齐（upToDate 为分量比较结果，null = 无法比较）
interface UpdateInfo { current: string | null; latest: string | null; upToDate: boolean | null; networkError: string | null; checkedAt: string }

const panelCfg = ref<Record<string, unknown> | null>(null);
const update = ref<UpdateInfo | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

onMounted(async () => {
  try {
    // panel-config 读本地配置不会 502；update-check 失败不阻塞整页（整卡降级隐藏）
    const [pc, uc] = await Promise.all([
      api<Record<string, unknown>>("/panel-config"),
      api<UpdateInfo>("/update-check").catch(() => null),
    ]);
    panelCfg.value = pc;
    update.value = uc;
  } catch (e) {
    loadError.value = String(e);
  } finally { loading.value = false; }
});
</script>

<template>
  <div class="page">
    <h2>配置</h2>
    <NSpin :show="loading">
      <p v-if="loadError" class="muted">加载配置失败：{{ loadError }}</p>
      <NCard v-if="update" title="gbrain 版本" size="small" style="margin-bottom: 12px">
        <p>当前：{{ update.current ?? "未知（serve 启动日志未解析到版本横幅）" }}</p>
        <p>最新：{{ update.latest ?? "未知" }}
          <NTag v-if="update.upToDate === true" type="success" size="small">已是最新</NTag>
          <NTag v-else-if="update.upToDate === false" type="warning" size="small">有新版本</NTag>
          <NTag v-else size="small">无法比较</NTag>
        </p>
        <p v-if="update.networkError" class="muted">检查更新网络错误：{{ update.networkError }}</p>
        <p v-if="update.checkedAt" class="muted">检查于 {{ update.checkedAt.slice(0, 19).replace("T", " ") }}</p>
      </NCard>
      <NCard title="面板配置（config.json，只读；bootstrapToken 已隐藏）" size="small">
        <pre>{{ panelCfg ? JSON.stringify(panelCfg, null, 2) : "…" }}</pre>
      </NCard>
      <p class="muted" style="margin-top: 8px">gbrain 侧详细配置请查看 gbrain 仓库的 config；面板仅展示与自身运行相关字段。</p>
    </NSpin>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.muted { color: #888; font-size: 12px; }
</style>
