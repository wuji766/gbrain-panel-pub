<!-- web/src/components/MarkdownView.vue -->
<script setup lang="ts">
import { computed } from "vue";
// @ts-expect-error markdown-it@14 未提供类型声明，仓库亦未安装 @types/markdown-it（偏离简报逐字代码的最小修复，详见 m2-task-5-report.md）
import MarkdownIt from "markdown-it";

const props = defineProps<{ source: string }>();
const md = new MarkdownIt({ html: false, linkify: true });
const html = computed(() => md.render(props.source ?? ""));
</script>

<template>
  <div class="md" v-html="html"></div>
</template>

<style scoped>
.md :deep(h1) { font-size: 1.4em; margin: 0.6em 0 0.3em; }
.md :deep(h2) { font-size: 1.2em; margin: 0.6em 0 0.3em; }
.md :deep(p) { margin: 0.4em 0; }
.md :deep(code) { background: #f3f3f6; padding: 1px 4px; border-radius: 3px; }
.md :deep(pre) { background: #f6f6fa; padding: 10px; border-radius: 6px; overflow: auto; }
</style>
