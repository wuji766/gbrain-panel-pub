<!-- web/src/views/Pages.vue -->
<script setup lang="ts">
import { ref, onMounted, h } from "vue";
import { useRouter } from "vue-router";
import { NInput, NButton, NDataTable, NTabs, NTabPane, NPopconfirm, useMessage } from "naive-ui";
import { api } from "../api/client";

interface Row { slug?: string; name?: string; title?: string; frontmatter?: { title?: string }; type?: string; updated_at?: string; deleted_at?: string | null }

const router = useRouter();
const message = useMessage();
const loading = ref(false);
const rows = ref<Row[]>([]);
const total = ref(0);
const query = ref("");
const typeFilter = ref("");
const page = ref(1);
const pageSize = 20;
const recycled = ref<Row[]>([]);

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String((page.value - 1) * pageSize) });
    if (query.value.trim()) params.set("q", query.value.trim());
    if (typeFilter.value.trim()) params.set("type", typeFilter.value.trim());
    const json = await api<{ pages?: Row[]; results?: Row[]; total?: number }>(`/pages?${params}`);
    rows.value = (json.pages ?? json.results ?? []) as Row[];
    total.value = json.total ?? rows.value.length;
  } catch (e) { message.error(String(e)); }
  finally { loading.value = false; }
}

async function loadRecycled() {
  try {
    const json = await api<{ pages?: Row[] }>(`/pages?include_deleted=true&limit=100`);
    recycled.value = (json.pages ?? []).filter(r => r.deleted_at);
  } catch (e) { message.error(String(e)); }
}

async function softDelete(slug: string) {
  try { await api(`/pages/${encodeURIComponent(slug)}`, { method: "DELETE" }); message.success(`已软删除 ${slug}`); await Promise.all([load(), loadRecycled()]); }
  catch (e) { message.error(String(e)); }
}

async function restore(slug: string) {
  try { await api(`/pages/${encodeURIComponent(slug)}/restore`, { method: "POST" }); message.success(`已恢复 ${slug}`); await Promise.all([load(), loadRecycled()]); }
  catch (e) { message.error(String(e)); }
}

const columns = [
  { title: "slug", key: "slug", render: (r: Row) => r.slug ?? r.name ?? "(?)" },
  { title: "标题", key: "title", render: (r: Row) => r.title ?? r.frontmatter?.title ?? "" },
  { title: "类型", key: "type", render: (r: Row) => r.type ?? "" },
  { title: "更新", key: "updated_at", render: (r: Row) => (r.updated_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "操作", key: "actions", render: (r: Row) => h("div", { style: "display:flex;gap:8px" }, [
      h(NButton, { size: "tiny", onClick: () => router.push(`/pages/${encodeURIComponent(r.slug ?? r.name ?? "")}`) }, { default: () => "详情" }),
      h(NPopconfirm, { onPositiveClick: () => softDelete(r.slug ?? r.name ?? "") }, { trigger: () => h(NButton, { size: "tiny", type: "warning" }, { default: () => "软删" }), default: () => "确认软删除？（72h 内可恢复）" }),
  ]) },
];

const recycleColumns = [
  { title: "slug", key: "slug", render: (r: Row) => r.slug ?? r.name ?? "(?)" },
  { title: "删除时间", key: "deleted_at", render: (r: Row) => (r.deleted_at ?? "").slice(0, 19).replace("T", " ") },
  { title: "操作", key: "actions", render: (r: Row) => h(NButton, { size: "tiny", onClick: () => restore(r.slug ?? r.name ?? "") }, { default: () => "恢复" }) },
];

onMounted(() => { load(); loadRecycled(); });
</script>

<template>
  <div class="page">
    <h2>页面库</h2>
    <div class="toolbar">
      <NInput v-model:value="query" placeholder="搜索（全文+语义）" clearable style="width: 260px" @keyup.enter="page = 1; load()" />
      <NInput v-model:value="typeFilter" placeholder="类型过滤（如 note）" clearable style="width: 160px" @keyup.enter="page = 1; load()" />
      <NButton size="small" @click="page = 1; load()">查询</NButton>
      <NButton v-if="page > 1" size="small" @click="page--; load()">上一页</NButton>
      <NButton v-if="rows.length === pageSize" size="small" @click="page++; load()">下一页</NButton>
      <span class="muted">共 {{ total }} 条（第 {{ page }} 页）</span>
    </div>
    <NDataTable :columns="columns" :data="rows" :loading="loading" :bordered="false" size="small" />
    <NTabs type="line" style="margin-top: 16px">
      <NTabPane name="recycle" tab="回收站（软删除，仅恢复）">
        <NDataTable :columns="recycleColumns" :data="recycled" :bordered="false" size="small" />
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.muted { color: #888; font-size: 12px; }
</style>
