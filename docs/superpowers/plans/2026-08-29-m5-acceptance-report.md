# M5 验收报告（2026-08-29，Playwright 真机实测）

- 验收对象：gbrain-panel m5-backup-fixes（面板 127.0.0.1:7070，own 态 serve @3131，gbrain 0.46.32.0，PGLite）
- 验收方式：Playwright GUI 黑盒 + 进程树/磁盘/源码只读取证；截图证据 17 张存于
  `C:\Users\wuji\ZCodeProject\gbrain-panel-m5-acceptance\`（t1~t8 系列 PNG）
- 总结论：**8 条中 5 条通过（2/3/4/7/8）；条 5、条 6 部分通过（各带一处口径/缺陷）；条 1 备份红线不通过（P0：own 态备份在本机必现中止，从未产出备份文件）**

## 逐条明细

### 1. 备份红线 —— ❌ 不通过（P0）

- 现象：own 态点「立即备份」→ 确认弹窗 → 横幅「备份进行中」+ 按钮禁用 → 数秒后 503：
  `Error: /backups -> 503 {"error":"Error: 检测到活跃锁——疑似外部 serve 已抢占，已中止复制（源数据未被修改）"}`
- 红线核对结果：`D:\gbrain-backup` 全程为空——没有 `brain.pglite\` 可核对（无 PG_VERSION/base/、谈不上 40+ MB 体积；也无 sock/lock/pid 产物，因为复制从未开始）。非上次的"列表有条目但文件为空"型假成功，UI 有明确 503 报错。
- 根因（进程树 + 源码实证）：面板 spawn 的直接子进程是 `gbrain.exe`（bun shim，如 PID 32480），它再 exec 出孙进程 `bun …\gbrain\src\cli.ts serve`（如 PID 30336）——**真正持锁、写锁文件 pid 的是孙进程**。`killServe()` 返回子进程 PID，锁文件记录孙进程 PID，`server/src/backup.ts:84` 的 `lockPid === killedPid` 在本机永不成立 → 永远走"外部抢占"保守中止分支。
- 日志佐证：kill 18:16:19.397 → spawn 18:16:19.728（331ms ≈ 300ms 等待 + 判定），中间无任何复制动作；gbrain 经 bun shim 安装（`bun link` 全局路径）的机器上必现。
- 失败方向安全：中止发生在复制前，源数据零改动、serve 正确拉回、无残缺目录。
- 证据：t1_backup_before / t1_backup_during（横幅）/ t1_backup_abort_error（503 报错）

### 2. status 合并 backupRunning —— ✅ 通过

- `/api/status` 响应含 `backupRunning` 字段（实测 false，own 态）。
- 页面打开 81s 内 `/api/status` 轮询 16 次（≈5s/次），`/api/backups` 零请求（未开备份页时；备份列表仅在打开备份页时拉取）。
- 方法说明：用页面 Resource Timing API 观测网络请求（与 DevTools Network 同源等价）。

### 3. 备份期 online 不闪断 —— ✅ 通过

- 横幅「备份进行中」出现、按钮禁用；全程顶栏保持 `gbrain: own :3131`，无闪红、无"面板服务不可达"。
- 结束后横幅消失、serve 恢复：页面库 21 条数据正常加载。
- 注：本次备份实际是"中止"而非"完成"（见条 1），但条 3 自身判据（横幅生命周期/在线不闪断/serve 恢复/页面库可查）全部符合。
- 证据：t1_backup_during、t3_pages_after_backup

### 4. attach 模式备份拒绝（M4 遗留补测）—— ✅ 通过

- 场景构造：外部 `gbrain serve --http` 占 3131（持锁）→ 面板启动进入 foreign（attach）态，顶栏 `gbrain: foreign :3131`。
- 点「立即备份」→ 确认弹窗 → 精确返回 503：
  `Error: /backups -> 503 {"error":"Error: 当前复用他人 serve（attached/foreign），无法安全停机备份——请以面板自有 serve 运行时备份"}`
- 无备份产生、外部 serve 未受影响；测后已清理（杀外部 serve + 重启面板回 own，顶栏复核 `own :3131`）。
- 证据：t4_attach_backup_page（foreign 态备份页）/ t4_attach_reject_message（503 提示）

### 5. backupRetention ≥1 / 改 0 回 1 —— ⚠️ 前半通过、后半不符

- 显示 ≥1 ✓：配置页 JSON 显示 `backupRetention: 5`（token 同屏 `<已隐藏>`）。
- 改 0 重启验证"回 1" ✗：实测显示 **5**——`server/src/config.ts:50`
  `Math.max(1, Math.floor(Number(cfg.backupRetention) || 5))` 把 0 当 falsy 回退默认 5（源码注释自述"0/非数经 || 回默认 5"，仅负数钳到 1）。与 README 验收口径"回 1"不符，M6 待办第 6 条恰好点名"回退 vs 钳制"测试口径未区分。安全方向无害（≥1）。
- 测试后 config.json 已还原为 5。
- 证据：t5_config_page / t5_config_clamped

### 6. SSE 原生重连 —— ⚠️ 部分通过（P1 缺陷）

- 通过项：开实时流正常收事件；重启面板后端后出现「连接中断，自动重连中…」且按钮保持「实时中（点击停止）」；点按钮手动停止立即断开（按钮回「实时流」、重连循环消失）。
- 缺陷 A（P1）：提示并非"出现一次"，后端恢复后每 ~13s 循环闪现。根因：面板日志出现
  `[Bun.serve]: request timed out after 10 seconds. Pass idleTimeout to configure.`
  ——Bun 默认 idleTimeout 10s 杀空闲 SSE，服务端无心跳（keep-alive comment），空闲时连接永不稳定；每次 ~3s 重连空窗内到达的事件会丢失。
- 缺陷 B（观察空白）：后端恢复后 47s 内无任何自发 MCP 流量，"新事件自动恢复插入列表头部"未获直接证据（受缺陷 A 影响该机制本身也不可靠）。
- 证据：t6_live_on / t6_reconnect_message / t6_stopped；后端日志 idleTimeout 行

### 7. 仪表盘中文口径 —— ✅ 通过

- 统计卡中文标签（已连接 Agents／活跃 OAuth Token／活跃 API Key／近 24h 请求数）+ 口径说明行（active_api_keys 口径、可按名撤销清理）+ 内容统计（full-stats）+ 健康指标齐备。
- 证据：t7_dashboard

### 8. Agents 撤销遗留 key —— ✅ 通过

- 撤销 `panel-m3-seed` ×2、`gbrain-panel-discover` ×3（确认弹窗「撤销 … 的所有同名 active key？」→ 全部 revoked，两张表一致）。
- 仪表盘活跃 API Key：6 → 1（剩 gbrain-panel 面板自用 key，未动）。
- 证据：t8_agents_before / t8_agents_after / t8_dashboard_after_revoke

## 清单外新发现

1. **配置页导航失效（P2）**：备份页确认弹窗流程之后，点侧栏「配置」无法导航（URL 不变，`#/pages` 原地不动），Playwright 定位点击与坐标级真实点击（CUA）均无效；其他路由（仪表盘/页面库）正常；整页刷新后恢复。复现序列：备份操作 → 页面库 → 配置（不可达）。疑似 dx 弹窗残留影响路由或守卫，建议排查。
2. （轻微）后端完全下线时页面闪现一次「面板服务不可达」横幅随即自行消失（~1.5-5s 窗口），与 SSE 断连提示并存——与 M6 已列"连续失败置 offline 逃生口"议题相关，如实记录。

## 环境交接

- 数据侧变更：5 个测试遗留 key 已撤销（清单要求，不可恢复）；config.json 除 backupRetention 临时改 0 又还原 5 外未动；gbrain 数据库与源数据零改动（备份从未执行到复制阶段）。
- 面板进程：验收期间按清单要求共重启 3 次（条 6 一次、条 4 两次），结束时由验收会话以后台任务承载运行（own 态、serve 就绪 @3131）；验收会话结束后需手动重启面板。面板运行期间 ZCode 的 gbrain stdio MCP 不可用（PGLite 单写者，属预期）。

## 证据文件清单（C:\Users\wuji\ZCodeProject\gbrain-panel-m5-acceptance\）

t1_backup_before.png、t1_backup_during.png、t1_backup_abort_error.png、t3_pages_after_backup.png、
t4_attach_backup_page.png、t4_attach_backup_rejected.png、t4_attach_reject_message.png、
t5_config_page.png、t5_config_clamped.png、t6_requests_before.png、t6_live_on.png、
t6_reconnect_message.png、t6_stopped.png、t7_dashboard.png、t8_agents_before.png、
t8_agents_after.png、t8_dashboard_after_revoke.png
