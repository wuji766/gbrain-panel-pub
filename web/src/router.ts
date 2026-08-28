import { createRouter, createWebHashHistory } from "vue-router";

export default createRouter({
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
