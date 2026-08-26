import { defineStore } from "pinia";
import { api } from "../api/client";

export interface PanelStatus { state: string; effectivePort: number; panelPort: number; logs: string[] }

export const useConnection = defineStore("connection", {
  state: () => ({
    online: false,
    status: null as PanelStatus | null,
  }),
  actions: {
    async refresh() {
      try {
        this.status = await api<PanelStatus>("/status");
        this.online = true;
      } catch {
        this.online = false;
      }
    },
  },
});
