<!-- web/src/views/PageDetail.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NTabs, NTabPane, NInput, NPopconfirm, useMessage } from "naive-ui";
import { api } from "../api/client";
import MarkdownView from "../components/MarkdownView.vue";

interface PageData { page: Record<string, unknown>; links: { links?: unknown[] }; timeline: { entries?: unknown[] } }

const route = useRoute();
const router = useRouter();
const message = useMessage();
const slug = decodeURIComponent(String(route.params.slug));

const data = ref<PageData | null>(null);
const error = ref<string | null>(null);
const editing = ref(false);
const editTitle = ref("");
const editTags = ref("");
const editBody = ref("");
const saving = ref(false);

function splitContent(raw: string): { title: string; tags: string; body: string } {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end > 0) {
      const fm = raw.slice(3, end);
      const t = /^title:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? "";
      const tags = /^tags:\s*\[(.*)\]$/m.exec(fm)?.[1]?.trim() ?? "";
      return { title: t, tags, body: raw.slice(end + 4).replace(/^\s+/, "") };
    }
  }
  return { title: "", tags: "", body: raw };
}

function assemble(): string {
  const fm: string[] = [];
  if (editTitle.value.trim()) fm.push(`title: ${editTitle.value.trim()}`);
  if (editTags.value.trim()) fm.push(`tags: [${editTags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(", ")}]`);
  return fm.length ? `---\n${fm.join("\n")}\n---\n\n${editBody.value}` : editBody.value;
}

async function load() {
  error.value = null;
  try {
    data.value = await api<PageData>(`/pages/${encodeURIComponent(slug)}`);
    const p = data.value.page as { content?: string };
    if (typeof p.content === "string") {
      const s = splitContent(p.content);
      editTitle.value = s.title; editTags.value = s.tags; editBody.value = s.body;
    }
  } catch (e) { error.value = String(e); }
}

async function save() {
  saving.value = true;
  try {
    await api(`/pages/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify({ content: assemble() }) });
    message.success("已保存");
    editing.value = false;
    await load();
  } catch (e) { message.error(String(e)); }
  finally { saving.value = false; }
}

async function softDelete() {
  try { await api(`/pages/${encodeURIComponent(slug)}`, { method: "DELETE" }); message.success("已软删除（回收站可恢复）"); router.push("/pages"); }
  catch (e) { message.error(String(e)); }
}

async function restore() {
  try { await api(`/pages/${encodeURIComponent(slug)}/restore`, { method: "POST" }); message.success("已恢复"); await load(); }
  catch (e) { message.error(String(e)); }
}

const content = () => (data.value?.page as { content?: string } | undefined)?.content ?? "";
const deleted = () => Boolean((data.value?.page as { deleted_at?: string | null } | undefined)?.deleted_at);

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>{{ slug }}</h2>
      <div class="actions">
        <NButton size="small" v-if="!editing" @click="editing = true">编辑</NButton>
        <NButton size="small" type="primary" v-if="editing" :loading="saving" @click="save">保存</NButton>
        <NButton size="small" v-if="editing" @click="editing = false">取消</NButton>
        <NButton size="small" v-if="deleted()" type="success" @click="restore">恢复</NButton>
        <NPopconfirm v-if="!deleted()" @positive-click="softDelete">
          <template #trigger><NButton size="small" type="warning">软删除</NButton></template>
          确认软删除？（72h 内可恢复）
        </NPopconfirm>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="editing" class="editor">
      <div class="fm-row">
        <NInput v-model:value="editTitle" placeholder="标题（frontmatter title）" />
        <NInput v-model:value="editTags" placeholder="标签（逗号分隔，frontmatter tags）" />
      </div>
      <textarea v-model="editBody" class="body-editor" placeholder="正文（markdown）"></textarea>
      <p class="muted">保存时按 title/tags 是否填写自动组装 frontmatter；清空即移除对应字段。</p>
    </div>

    <NTabs v-else-if="data" type="line">
      <NTabPane name="content" tab="正文">
        <MarkdownView v-if="content()" :source="content()" />
        <p v-else class="muted">无内容（或真实 get_page 未返回 content 字段——见下方元数据）</p>
      </NTabPane>
      <NTabPane name="meta" tab="元数据">
        <pre>{{ JSON.stringify(data.page, null, 2) }}</pre>
      </NTabPane>
      <NTabPane name="links" tab="关联链接">
        <pre>{{ JSON.stringify(data.links, null, 2) }}</pre>
      </NTabPane>
      <NTabPane name="timeline" tab="时间线">
        <pre>{{ JSON.stringify(data.timeline, null, 2) }}</pre>
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.head { display: flex; justify-content: space-between; align-items: center; }
.actions { display: flex; gap: 8px; }
.error { color: #d03050; }
.fm-row { display: flex; gap: 8px; margin-bottom: 8px; }
.body-editor { width: 100%; min-height: 320px; font-family: Consolas, monospace; border: 1px solid #e0e0e6; border-radius: 6px; padding: 10px; box-sizing: border-box; }
.muted { color: #888; font-size: 12px; }
</style>
