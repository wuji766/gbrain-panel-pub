<script setup lang="ts">
import { onMounted, onUnmounted, computed } from "vue";
import { NTag, NMessageProvider } from "naive-ui";
import { useConnection } from "./stores/connection";

const conn = useConnection();
let timer: number | undefined;
onMounted(() => {
  conn.refresh();
  timer = window.setInterval(() => conn.refresh(), 5000);
});
onUnmounted(() => clearInterval(timer));

const stateType = computed(() => {
  const s = conn.status?.state ?? "unknown";
  return s === "own" || s === "attached" ? "success" : s === "foreign" || s === "error" ? "error" : "warning";
});

const nav = [
  { to: "/", label: "仪表盘" },
  { to: "/pages", label: "页面库" },
  { to: "/facts", label: "记忆库" },
  { to: "/capture", label: "快速记事" },
  { to: "/m3", label: "图谱 · 时间线 · 回收站（M3）", disabled: true },
  { to: "/m4", label: "运维 · 维护（M4）", disabled: true },
];
</script>

<template>
  <n-message-provider>
    <div class="shell">
      <aside class="sider">
        <h1 class="logo">gbrain 面板</h1>
        <nav>
          <template v-for="item in nav" :key="item.to">
            <RouterLink v-if="!item.disabled" :to="item.to" class="nav-item">{{ item.label }}</RouterLink>
            <span v-else class="nav-item disabled">{{ item.label }}</span>
          </template>
        </nav>
      </aside>
      <main class="main">
        <header class="topbar">
          <NTag :type="stateType" size="small">
            gbrain: {{ conn.status?.state ?? "…" }} :{{ conn.status?.effectivePort ?? "?" }}
          </NTag>
        </header>
        <RouterView />
        <div v-if="!conn.online" class="overlay">
          <div class="overlay-card">
            <h2>面板服务不可达</h2>
            <p>后端可能已退出。请重新启动面板（bun run dev:server 或 bun run server/src/index.ts）。</p>
          </div>
        </div>
      </main>
    </div>
  </n-message-provider>
</template>

<style scoped>
.shell { display: flex; height: 100vh; }
.sider { width: 230px; border-right: 1px solid #e0e0e6; padding: 16px; }
.logo { font-size: 16px; margin: 0 0 16px; }
.nav-item { display: block; padding: 8px 10px; margin: 2px 0; border-radius: 6px; color: inherit; text-decoration: none; }
.nav-item:hover { background: #f3f3f6; }
.nav-item.disabled { color: #b0b0b8; cursor: not-allowed; }
.main { flex: 1; position: relative; overflow: auto; }
.topbar { padding: 12px 20px; border-bottom: 1px solid #e0e0e6; }
.overlay { position: absolute; inset: 0; background: rgba(255,255,255,.92); display: grid; place-items: center; }
.overlay-card { text-align: center; }
</style>
