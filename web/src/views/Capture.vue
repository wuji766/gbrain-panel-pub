<!-- web/src/views/Capture.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { NInput, NButton, useMessage } from "naive-ui";
import { api } from "../api/client";

const message = useMessage();
const fact = ref("");
const entity = ref("");
const submitting = ref(false);

async function submit() {
  if (!fact.value.trim()) { message.warning("内容必填"); return; }
  submitting.value = true;
  try {
    await api("/facts", { method: "POST", body: JSON.stringify({ fact: fact.value.trim(), ...(entity.value.trim() ? { entity: entity.value.trim() } : {}) }) });
    message.success("已记住");
    fact.value = "";
  } catch (e) { message.error(String(e)); }
  finally { submitting.value = false; }
}
</script>

<template>
  <div class="page">
    <h2>快速记事</h2>
    <NInput v-model:value="fact" type="textarea" :rows="5" placeholder="想到什么记什么……（Ctrl+Enter 提交）" @keydown.ctrl.enter="submit" />
    <div class="bar">
      <NInput v-model:value="entity" placeholder="归属实体（可选，如 people/alice）" style="width: 280px" />
      <NButton type="primary" :loading="submitting" @click="submit">记住</NButton>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 20px; max-width: 760px; }
.bar { display: flex; gap: 8px; margin-top: 8px; }
</style>
