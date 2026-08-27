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
    { path: "/:rest(.*)", name: "coming", component: () => import("./views/ComingSoon.vue") },
  ],
});
