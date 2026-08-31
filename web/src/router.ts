import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "dashboard", component: () => import("./views/Dashboard.vue") },
    { path: "/pages", name: "pages", component: () => import("./views/Pages.vue") },
    { path: "/pages/:slug", name: "pageDetail", component: () => import("./views/PageDetail.vue") },
    { path: "/facts", name: "facts", component: () => import("./views/Facts.vue") },
    { path: "/capture", name: "capture", component: () => import("./views/Capture.vue") },
    { path: "/graph", name: "graph", component: () => import("./views/Graph.vue") },
    { path: "/timeline", name: "timeline", component: () => import("./views/Timeline.vue") },
    { path: "/ops/requests", name: "opsRequests", component: () => import("./views/RequestLog.vue") },
    { path: "/ops/jobs", name: "opsJobs", component: () => import("./views/Jobs.vue") },
    { path: "/ops/agents", name: "opsAgents", component: () => import("./views/Agents.vue") },
    { path: "/backup", name: "backup", component: () => import("./views/Backup.vue") },
    { path: "/config", name: "config", component: () => import("./views/Config.vue") },
    { path: "/:rest(.*)", name: "coming", component: () => import("./views/ComingSoon.vue") },
  ],
});

// 懒加载导航自愈（2026-08-29 M5 验收清单外发现 P2）：路由组件全部懒加载，chunk 拉取失败
// （面板重启窗口连接拒绝 / 重建后旧 hash 404）会被浏览器模块映射按 URL 缓存——之后每次
// 导航都静默中止（URL 不变、无提示），整页刷新才恢复。自愈：失败时定向整页刷新一次
// （新文档 = 新模块映射）；sessionStorage 按路由去重，同一路由只自动刷新一次防循环。
// 非 chunk 失败的导航错误：结构化落 console（M6 验收范围外观察①——健康后端下偶发一次
// 静默中止，先埋点拿到发生条件再定修法）。
router.onError((error, to) => {
  const msg = error instanceof Error ? error.message : String(error);
  const importFailed = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
  const key = `gbrain-panel:nav-reload:${to.fullPath}`;
  if (importFailed && !sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, "1");
    window.location.hash = to.fullPath;
    window.location.reload();
  } else {
    console.error("[router] 导航失败:", {
      to: to.fullPath,
      name: error instanceof Error ? error.name : typeof error,
      message: msg,
      time: new Date().toISOString(),
    });
  }
});

// 成功到达某路由后清除其自愈守卫键：同一路由未来再次发生 chunk 失败时仍能再自愈一次
// （否则同标签页会话内第二次真失败只能手动刷新——M6 验收条5复现的候选池项）
router.afterEach((to) => {
  sessionStorage.removeItem(`gbrain-panel:nav-reload:${to.fullPath}`);
});

export default router;
