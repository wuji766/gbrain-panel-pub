import { createRouter, createWebHashHistory } from "vue-router";

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "dashboard", component: () => import("./views/Dashboard.vue") },
    { path: "/:rest(.*)", name: "coming", component: () => import("./views/ComingSoon.vue") },
  ],
});
