import { defineStore } from "pinia";
import { api } from "../api/client";

export interface PanelStatus { state: string; effectivePort: number; panelPort: number; backupRunning?: boolean; logs: string[] }

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
        this.backupRunning = this.status.backupRunning ?? false;
        this.online = true;
      } catch {
        // 备份进行中会停 serve/阻塞响应，status 拉取失败不算离线（容忍取自最近一次成功响应的 backupRunning）
        if (!this.backupRunning) this.online = false;
      }
    },
  },
});
