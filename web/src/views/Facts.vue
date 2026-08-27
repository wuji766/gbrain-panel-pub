<!-- web/src/views/Facts.vue -->
<script setup lang="ts">
import { ref, onMounted, h } from "vue";
import { NInput, NButton, NDataTable, NCheckbox, NModal, NSelect, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Fact { fact_id?: string; id?: string; entity_slug?: string; entity?: string; fact?: string; kind?: string; visibility?: string; expired?: boolean; expired_at?: string | null; valid_until?: string | null }

const message = useMessage();
const facts = ref<Fact[]>([]);
const entity = ref("");
const includeExpired = ref(false);
const loading = ref(false);
const showForget = ref(false);
const forgetTarget = ref<Fact | null>(null);
const forgetReason = ref("");

const showNew = ref(false);
const newFact = ref("");
const newEntity = ref("");
const newKind = ref<string | null>(null);
// 枚举与 remember op 定义一致（docs/discovery.json）
// 可见性不提供选择：gbrain 对远程调用方（面板即远程）只返回 world 记忆，
// 选 private 会造成「创建成功但面板永远看不到」的陷阱（2026-08-27 复验实测），等 gbrain 上游支持后再开放
const kindOptions = [
  { label: "event（事件）", value: "event" }, { label: "preference（偏好）", value: "preference" },
  { label: "commitment（承诺）", value: "commitment" }, { label: "belief（信念）", value: "belief" },
  { label: "fact（事实）", value: "fact" },
];

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ include_expired: String(includeExpired.value), limit: "200" });
    if (entity.value.trim()) params.set("entity", entity.value.trim());
    const json = await api<{ facts?: Fact[] }>(`/facts?${params}`);
    facts.value = json.facts ?? [];
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function submitForget() {
  if (!forgetTarget.value || !forgetReason.value.trim()) { message.warning("理由必填"); return false; }
  const id = forgetTarget.value.fact_id ?? forgetTarget.value.id ?? "";
  try {
    await api(`/facts/${encodeURIComponent(id)}/forget`, { method: "POST", body: JSON.stringify({ reason: forgetReason.value.trim() }) });
    message.success("已遗忘（过期，审计保留）");
    showForget.value = false; forgetReason.value = "";
    await load();
  } catch (e) { message.error(String(e)); return false; }
}

async function createFact() {
  if (!newFact.value.trim()) { message.warning("内容必填"); return false; }
  try {
    await api("/facts", { method: "POST", body: JSON.stringify({
      fact: newFact.value.trim(),
      ...(newEntity.value.trim() ? { entity: newEntity.value.trim() } : {}),
      ...(newKind.value ? { kind: newKind.value } : {}),
    }) });
    message.success("已记住");
    newFact.value = ""; newKind.value = null; showNew.value = false;
    await load();
  } catch (e) { message.error(String(e)); return false; }
}

function hForget(f: Fact) {
  return h(NButton, { size: "tiny", type: "warning", onClick: () => { forgetTarget.value = f; showForget.value = true; } }, { default: () => "遗忘" });
}

const columns = [
  { title: "ID", key: "id", render: (f: Fact) => f.fact_id ?? f.id ?? "" },
  { title: "实体", key: "entity", render: (f: Fact) => f.entity_slug ?? f.entity ?? "" },
  { title: "内容", key: "fact", render: (f: Fact) => f.fact ?? "" },
  { title: "类型", key: "kind", render: (f: Fact) => f.kind ?? "" },
  { title: "可见性", key: "visibility", render: (f: Fact) => f.visibility ?? "" },
  { title: "状态", key: "expired", render: (f: Fact) => f.expired
      ? `已过期${f.expired_at ? "（" + f.expired_at.slice(0, 19).replace("T", " ") + "）" : ""}`
      : "生效中" },
  { title: "操作", key: "actions", render: (f: Fact) => (!f.expired ? hForget(f) : "") },
];

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>记忆库</h2>
    <div class="toolbar">
      <NInput v-model:value="entity" placeholder="按实体过滤（如 people/alice）" clearable style="width: 260px" @keyup.enter="load" />
      <NCheckbox v-model:checked="includeExpired" @update:checked="load">含已过期（审计视角）</NCheckbox>
      <NButton size="small" @click="load">查询</NButton>
      <NButton size="small" type="primary" @click="showNew = true">新增记忆</NButton>
    </div>
    <NDataTable :columns="columns" :data="facts" :loading="loading" :bordered="false" size="small" />

    <NModal v-model:show="showForget" title="遗忘记忆（需填理由，审计保留）" preset="dialog" positive-text="确认遗忘" negative-text="取消" @positive-click="submitForget">
      <p class="muted">目标：{{ forgetTarget?.fact ?? "" }}</p>
      <NInput v-model:value="forgetReason" placeholder="遗忘理由（必填）" />
    </NModal>

    <NModal v-model:show="showNew" title="新增记忆" preset="dialog" positive-text="记住" negative-text="取消" @positive-click="createFact">
      <NInput v-model:value="newFact" type="textarea" placeholder="记忆内容（必填）" :rows="3" />
      <div style="display:flex; gap:8px; margin-top:8px">
        <NInput v-model:value="newEntity" placeholder="实体（可选，如 people/alice）" />
        <NSelect v-model:value="newKind" :options="kindOptions" placeholder="类型（可选，默认 fact）" clearable style="width: 200px" />
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.muted { color: #888; font-size: 12px; }
</style>
