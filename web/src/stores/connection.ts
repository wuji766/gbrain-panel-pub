import { defineStore } from "pinia";
import { api } from "../api/client";

export interface PanelStatus { state: string; effectivePort: number; panelPort: number; backupRunning?: boolean; logs: string[] }

// 备份窗口容忍上限：status 轮询 5s/次，连续 12 次（约 60s）失败即放弃容忍。备份（停 serve
// 复制）通常数秒~十几秒；60s 仍拉不到 status，更可能是「备份中面板死掉」而非备份本身——
// 诚实置 offline，防 online 永真（M6 逃生口）。
const BACKUP_TOLERANCE_MAX_FAILURES = 12;

export const useConnection = defineStore("connection", {
  state: () => ({
    online: false,
    status: null as PanelStatus | null,
    backupRunning: false,
    failStreak: 0,
  }),
  actions: {
    async refresh() {
      try {
        this.status = await api<PanelStatus>("/status");
        this.backupRunning = this.status.backupRunning ?? false;
        this.online = true;
        this.failStreak = 0;
      } catch {
        this.failStreak++;
        // 备份进行中会停 serve/阻塞响应，status 拉取失败不算离线（容忍取自最近一次成功响应的
        // backupRunning）；逃生口：容忍有上限——连续超限仍失败则视为面板真下线
        if (!this.backupRunning || this.failStreak >= BACKUP_TOLERANCE_MAX_FAILURES) this.online = false;
      }
    },
  },
});
