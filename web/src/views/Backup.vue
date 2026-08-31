<!-- web/src/views/Backup.vue：列表 + 立即备份（停机复制）+ 删除；进行中状态另由 App.vue 全局横幅轮询展示 -->
<script setup lang="ts">
import { ref, h, onMounted } from "vue";
import { NDataTable, NButton, NPopconfirm, NCard, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface BackupInfo { name: string; sizeBytes: number; createdAt: string }

const message = useMessage();
const backups = ref<BackupInfo[]>([]);
const running = ref(false);

async function load() {
  try { const j = await api<{ running: boolean; backups: BackupInfo[] }>("/backups"); running.value = j.running; backups.value = j.backups; }
  catch (e) {
    message.error(String(e));
    // 面板不可达时无从确认备份进行中——复位防「备份进行中」tag 永久滞留（M6 验收范围外观察④）；
    // 备份真实进行中时（M7 起复制不阻塞事件循环）本请求可正常应答，不会走到这里
    running.value = false;
  }
}

async function runBackup() {
  running.value = true; // 请求期间先禁用按钮，结束后以 load() 的服务端状态为准
  try { const r = await api<BackupInfo>("/backups", { method: "POST", signal: AbortSignal.timeout(120_000) }); message.success(`备份完成：${r.name}`); }
  catch (e) { message.error(String(e)); }
  finally { await load(); }
}

async function remove(name: string) {
  try { await api(`/backups/${encodeURIComponent(name)}`, { method: "DELETE" }); message.success("已删除"); await load(); }
  catch (e) { message.error(String(e)); }
}

const fmt = (b: number) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`;

const columns = [
  { title: "名称", key: "name" },
  { title: "大小", key: "sizeBytes", render: (b: BackupInfo) => fmt(b.sizeBytes) },
  { title: "时间", key: "createdAt", render: (b: BackupInfo) => new Date(b.createdAt).toLocaleString() },
  { title: "操作", key: "actions", render: (b: BackupInfo) => hDel(b.name) },
];

function hDel(name: string) {
  return h(NPopconfirm, { onPositiveClick: () => remove(name) }, {
    trigger: () => h(NButton, { size: "tiny", type: "warning" }, { default: () => "删除" }),
    default: () => `删除备份 ${name}？不可恢复`,
  });
}

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>备份 <NTag v-if="running" type="warning" size="small">备份进行中</NTag></h2>
    <p class="muted">备份会短暂停止面板自有的 gbrain serve（通常数秒），复制整个数据目录（含数据库 WAL）到备份目录。保留最近若干份自动清理。</p>
    <NPopconfirm @positive-click="runBackup">
      <template #trigger><NButton type="primary" :disabled="running">立即备份</NButton></template>
      备份期间服务将暂停数秒（停 serve → 复制 → 重启）。确认执行？
    </NPopconfirm>
    <NCard size="small" style="margin-top: 12px">
      <NDataTable :columns="columns" :data="backups" :bordered="false" size="small" />
    </NCard>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.muted { color: #888; font-size: 12px; }
</style>
