<!-- web/src/views/Agents.vue -->
<script setup lang="ts">
import { ref, h, onMounted } from "vue";
import { NCard, NDataTable, NButton, NModal, NInput, NPopconfirm, NTag, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Agent { id?: string; name?: string; auth_type?: string; scope?: string; status?: string; created_at?: string; last_used_at?: string | null; total_requests?: number; requests_today?: number }
interface KeyRow { id?: string; name?: string; created_at?: string; last_used_at?: string | null; status?: string }

const message = useMessage();
const agents = ref<Agent[]>([]);
const keys = ref<KeyRow[]>([]);
const showNew = ref(false);
const newName = ref("");
const createdToken = ref<string | null>(null);

async function load() {
  try {
    const [a, k] = await Promise.all([
      api<Agent[] | { agents?: Agent[] }>("/ops/agents"),
      api<KeyRow[] | { keys?: KeyRow[] }>("/ops/api-keys"),
    ]);
    agents.value = Array.isArray(a) ? a : (a.agents ?? []);
    keys.value = Array.isArray(k) ? k : (k.keys ?? []);
  } catch (e) { message.error(String(e)); }
}

async function createKey() {
  if (!newName.value.trim()) { message.warning("名称必填"); return false; }
  try {
    const json = await api<{ token?: string }>("/ops/api-keys", { method: "POST", body: JSON.stringify({ name: newName.value.trim() }) });
    createdToken.value = json.token ?? "(响应未含 token)";
    message.success("已签发——token 仅显示这一次");
    await load();
    return false; // 不关闭弹窗：token 需当场复制，用户手动关闭
  } catch (e) { message.error(String(e)); return false; }
}

async function revoke(name: string) {
  try { await api("/ops/api-keys/revoke", { method: "POST", body: JSON.stringify({ name }) }); message.success(`已撤销 ${name}（同名全部）`); await load(); }
  catch (e) { message.error(String(e)); }
}

function hRevoke(name: string) {
  return h(NPopconfirm, { onPositiveClick: () => revoke(name) }, { trigger: () => h(NButton, { size: "tiny", type: "warning" }, { default: () => "撤销" }), default: () => `撤销 ${name} 的所有同名 active key？` });
}

const agentColumns = [
  { title: "名称", key: "name" },
  { title: "类型", key: "auth_type", render: (a: Agent) => a.auth_type === "oauth" ? "OAuth" : "API Key" },
  { title: "scope", key: "scope" },
  { title: "状态", key: "status", render: (a: Agent) => a.status ?? "" },
  { title: "请求数", key: "total_requests", render: (a: Agent) => `${a.total_requests ?? 0}（今日 ${a.requests_today ?? 0}）` },
  { title: "最近使用", key: "last_used_at", render: (a: Agent) => (a.last_used_at ?? "从未").slice(0, 19).replace("T", " ") },
];
const keyColumns = [
  { title: "名称", key: "name" },
  { title: "签发时间", key: "created_at", render: (k: KeyRow) => (k.created_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "状态", key: "status", render: (k: KeyRow) => k.status ?? "" },
  { title: "操作", key: "actions", render: (k: KeyRow) => (k.status === "active" && k.name ? hRevoke(k.name) : "") },
];

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>Agents 与密钥</h2>
    <NButton size="small" type="primary" style="margin-bottom: 12px" @click="showNew = true; createdToken = null; newName = ''">签发 API Key</NButton>
    <NCard title="Agents（OAuth 客户端 + API key）" size="small">
      <NDataTable :columns="agentColumns" :data="agents" :bordered="false" size="small" />
    </NCard>
    <NCard title="API Keys" size="small" style="margin-top: 12px">
      <NDataTable :columns="keyColumns" :data="keys" :bordered="false" size="small" />
    </NCard>

    <NModal v-model:show="showNew" title="签发 API Key" preset="dialog" positive-text="签发" negative-text="关闭" @positive-click="createKey">
      <NInput v-model:value="newName" placeholder="key 名称（必填）" />
      <div v-if="createdToken" style="margin-top: 12px">
        <NTag type="warning" size="small">token 仅此一次显示，请立即复制保存：</NTag>
        <pre style="user-select: all; background: #f6f6fa; padding: 8px; border-radius: 6px; margin-top: 6px">{{ createdToken }}</pre>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
</style>
