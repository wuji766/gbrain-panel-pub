import { defineStore } from "pinia";
import { api } from "../api/client";

export interface PanelStatus { state: string; effectivePort: number; panelPort: number; logs: string[] }

export const useConnection = defineStore("connection", {
  state: () => ({
    online: false,
    status: null as PanelStatus | null,
    backupRunning: false,
  }),
  actions: {
    async refresh() {
      try {
        this.status = await api<PanelStatus>("/status");
        this.online = true;
      } catch {
        this.online = false;
      }
      // 顺带轮询备份进行中状态（App.vue 顶部横幅用）；面板未启用备份（503）时保持 false，不报错
      api<{ running: boolean }>("/backups")
        .then(j => { this.backupRunning = j.running; })
        .catch(() => {});
    },
  },
});
