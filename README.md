# gbrain-panel

gbrain 个人知识大脑的可视化操作面板。设计规格：`docs/superpowers/specs/2026-08-26-gbrain-panel-design.md`。

## 架构

面板后端（127.0.0.1:7070，Bun + Hono）spawn `gbrain serve --http --surface full`（127.0.0.1:3131）
作为唯一持锁子进程；admin cookie 会话 + 自签 API key 走 `/mcp`；Vue 3 SPA 由后端静态托管。

## 安装与运行（构建/启动均由用户手动执行）

```bash
bun install                 # 根目录一次即可（workspace）
bun run build:web           # 或 cd web && bun run build，构建前端
bun run server/src/index.ts # 启动面板，随后打开 http://127.0.0.1:7070
```

开发模式（两个终端）：`bun run dev:server` + `cd web && bun run dev`（Vite 代理 /api → 7070）。

## 测试

```bash
bun test
```

## 与 ZCode / CLI 的关系（重要）

- 面板运行期间，gbrain 的 PGLite 锁由面板的 serve 子进程持有：**ZCode 的 stdio gbrain MCP 与
  随手敲的 gbrain CLI 命令在此期间不可用**（属预期）。
- 面板正常退出（Ctrl+C）会整树杀掉 serve 并释放锁，ZCode MCP 随即恢复可用。
- 若面板被强杀留下孤儿 serve/锁：任务管理器结束 gbrain 相关进程，或用面板的
  `/api/stale-lock` 判定后清理（心跳超 90s 视为陈旧）。
- fallback（面板换 3132+ 自建 serve）仅适用于「3131 被占但 PGLite 锁空闲」的场景；若锁被
  ZCode 的 stdio MCP 或其他进程持有，新端口上的 serve 也会因锁冲突启动失败（表现：面板 error
  态 + 日志含锁冲突信息），此时请先释放锁再启动面板。

## M1 验收清单（手动）

1. `bun run server/src/index.ts` → 控制台出现 `[panel] gbrain 状态: own (port 3131)` 与面板地址。
2. 浏览器打开面板 → 仪表盘显示统计卡片与健康指标（需先构建 web）。
3. Ctrl+C 退出面板 → `gbrain status`（CLI）可正常执行（锁已释放）。
4. ZCode 打开 gbrain MCP 正常（stdio 持锁）→ 启动面板 → 面板状态显示 `foreign` 或按提示
   fallback 换端口，**ZCode 的 serve 不被杀**。
5. `bun run discover`（需先关 ZCode 的 gbrain MCP）→ 生成 `docs/discovery.json`。

## M2 使用说明（内容管理）

- **页面库**：列表/搜索（全文+语义混合）/类型过滤/分页；详情页看正文（markdown）、元数据、
  关联链接、时间线；编辑器支持 frontmatter（title/tags）+ 正文；软删除后可在回收站恢复。
  （gbrain 无 purge op，M2 不提供彻底清除。）
- **记忆库**：按实体过滤、含已过期（审计视角）；新增记忆（类型/可见性可选）；遗忘必须填理由
  （过期语义，审计保留）。
- **快速记事**：一句话记事，可选归属实体。

### M2 验收清单（手动，需先 build:web 并启动面板）

1. 页面库能看到真实页面列表；搜索框输入关键词出混合检索结果。
2. 点进一个页面：正文 markdown 正常渲染；「元数据」tab 的 JSON 与真实 get_page 形状一致
   ——若正文空白而元数据里有内容字段，说明字段名与前端假设不符，记入 M2 修正。
3. 编辑一个页面（改 title 保存）→ 重新打开确认生效。
4. 软删除一个页面 → 回收站出现 → 恢复 → 列表回归。
5. 快速记事记一条 → 记忆库按实体过滤能看到 → 遗忘（填理由）→ 勾"含已过期"能看到已过期状态。
6. 仪表盘出现「内容统计」卡（若 502 则显示隐藏提示，需核对 full-stats 真实形状）。

## M3 使用说明（图谱与时间线）

- **知识图谱**：以最近更新的 30 个页面为种子；单击节点展开一度邻居并显示实体卡片
  （摘要/反链数/活跃事实/关联边）；双击节点进页面详情；可按类型过滤种子、重置画布。
- **时间线**：gbrain 无跨页时间线接口，本视图按最后更新日期归组展示最近 100 个页面（降级方案）。
- **版本历史**：页面详情新增「版本」tab（get_versions 透传，只列不 diff）。
- 记忆库触达 recall 上限（100 条）时会提示改用实体过滤；快速记事支持类型选择。

### M3 验收清单（手动，需先 build:web 并启动面板）

1. 图谱页初始出现节点；单击一个节点 → 画布长出一度邻居 + 右侧实体卡（真实 entity op 的
   card 形状首次实测——若字段名与假设不符，侧栏降级为"未找到/建议"或 JSON 兜底属预期，记录即可）。
2. 图谱里 traverse_graph 的真实返回形状若与归一化假设不符（edges/paths、source/from），
   节点/边会缺失——记录实际形状以便 M4 修正归一化层。
3. 双击节点跳详情正常。
4. 时间线按日分组显示，点击条目进详情。
5. 详情页「版本」tab 显示真实版本列表（形状首次实测，JSON 展示即可）。
6. 记忆库在不过滤实体时能看到上限提示（若真实库不足 100 条则不出现，属预期）。

## M4 使用说明（运维与维护）

- **请求日志**：分页浏览 MCP 请求；可按 agent/操作/状态过滤；「实时流」经 SSE 追加最新事件。
- **任务队列**：jobs 快照（等待/执行中/停滞/租约压力/按类型统计/Top 错误），5 秒自动刷新。
- **Agents · 密钥**：查看 OAuth 客户端与 API key；签发新 key（token 只显示一次）；撤销按名称
  一次性撤所有同名 key（面板自签的 gbrain-panel key 已改为签发前先撤同名，不再累积）。
- **备份**：一键停机备份（停 serve → 复制整个 `<GBRAIN_HOME>/.gbrain` 含数据库与 WAL → 重启 →
  自动清理只保留最近 N 份）；仅在面板自有 serve（own）时可用；备份期间顶部显示暂停横幅。
- **配置**：面板 config.json 只读展示（token 隐藏）+ gbrain 版本与更新检查（分量比较）。
- 顺带修复：图谱邻居展开（traverse_graph 真实形状 + entity 兜底）、图谱类型过滤、
  index.html 禁缓存（升级后不再需要硬刷新）、锁路径修正。

### M4 验收清单（手动，需先 build:web 并启动面板）

1. 图谱页单击节点长出一度邻居（M3 缺陷 1 回归验证）；过滤框输类型回车后画布只剩该类型（缺陷 2）。
2. 请求日志分页/过滤可用；点「实时流」后在面板里做一次操作（如查询页面），列表头部出现新事件。
3. 任务队列页显示快照并 5 秒刷新。
4. Agents 页签发一个测试 key（复制一次性 token）、撤销它；确认 gbrain-panel 的自签 key 只剩 1 条 active。
5. 备份：点立即备份 → 顶部横幅出现 → 完成后列表新增一条、旧份数超保留数被清理；
   D:\gbrain-backup 下目录含 brain.pglite 子目录。面板 attach 模式下点备份应被拒绝并提示。
6. 配置页 token 显示为 <已隐藏>；版本比较正确（可对比 gbrain --version）。
7. 构建新前端后直接刷新浏览器（不硬刷新）应加载新版本（no-cache 生效）。

## M5 使用说明（备份修复与打磨）

- **备份修复（P0）**：复制排除运行时工件（resolve sock / lock 簇 / postmaster.pid——恢复安全），
  失败自动清理残缺目录，复制前活锁检查（外部 serve 抢占时中止且源数据不动）。
- 备份状态并入 /api/status 轮询（消除备份列表高频磁盘扫描）；备份阻塞期间不再误报"面板不可达"。
- 请求日志 SSE 断开后自动重连；Agents 签发成功后按钮禁用防连点；仪表盘统计卡附口径说明
  （active_api_keys 含 gbrain bootstrap-harness 同名历史累积，可在 Agents 页按名撤销清理）。

### M5 验收清单（手动，需先 build:web 并启动面板）

1. **备份红线**：own 态点立即备份 → 完成后到 `D:\gbrain-backup\<名称>\brain.pglite\` 核对
   真实数据库文件（PG_VERSION、base/ 等）与体积（约 40+ MB）——列表有条目不算数。
   备份产物中不得出现 .gbrain-resolve.sock / .gbrain-lock / postmaster.pid。
2. **status 合并 backupRunning（DevTools Network 验证）**：面板打开后，DevTools Network 里
   `/api/status` 响应含 `backupRunning` 字段；每 5s 的全局轮询**不再**请求 `/api/backups`
   （备份列表仅在打开备份页时拉取）。
3. **备份期 online 不闪断**：点「立即备份」→ 顶部横幅出现；备份期间（serve 停止/阻塞，status 可能
   短暂拉取失败）顶栏连接状态保持在线，不闪红、不闪"面板服务不可达"；备份完成后横幅消失、
   serve 恢复（页面库可查）。
4. **attach 模式备份拒绝（M4 遗留补测）**：先手动起一个占 3131 的 serve → 启动面板（attach 态）
   → 备份页点立即备份 → 预期 503 + "复用他人 serve"提示 → 测完关外部 serve 重启面板回 own。
5. 配置页 backupRetention 显示 ≥1（手改 config.json 为 0 重启面板验证回 1）。
6. **SSE 原生重连**：请求日志页点「实时流」→ 正常收事件；重启面板后端（Ctrl+C 再启动）→ 出现一次
   「连接中断，自动重连中…」提示，按钮保持「实时中」；后端起来后**不做任何操作**，新事件自动恢复
   插入列表头部（EventSource 原生重连）；点按钮手动停止仍立即断开。
7. 仪表盘统计卡显示中文口径标签与说明行。
8. Agents 页撤销遗留的 panel-m3-seed ×2、gbrain-panel-discover ×3（顺手复验撤销链路；
   撤后 active_api_keys 相应下降）。

## M6 验收清单（2026-08-29）

> 前置：`bun run build:web` 重建前端 + 重启面板（备份/SSE/状态逻辑均需重启后端生效）。

1. **备份红线（M5 条 1 重测）**：own 态点「立即备份」→ 成功提示 + 列表出现新份；到
   `D:\gbrain-backup\<名称>\brain.pglite\` 核对 PG_VERSION、base/ 等真实数据库文件与体积
   （40+ MB，列表有条目不算数）；产物内无 sock/lock/postmaster.pid；结束后顶栏恢复 own、页面库可查。
2. **外部 serve 抢占仍拒绝（回归）**：外部 `gbrain serve --http` 占 3131 时（foreign 态）点备份 → 503 拒绝文案，无备份产生。
3. **SSE 空闲稳定**：请求日志页开实时流后挂起 ≥60s——不出现「连接中断，自动重连中…」循环闪现（心跳生效）。
4. **SSE 恢复补插（M5 缺陷 B 补测）**：重启面板后端，实时流自动重连；随后触发一次 MCP 操作（如页面库刷新），新事件应自动插入列表头部，无需手动停止/重开。
5. **导航自愈**：打开面板 → 重启面板后端 → 趁后端未恢复点一次本会话未访问过的路由（如「配置」，此时无反应属预期——失败已被浏览器缓存）→ 等后端恢复（顶栏状态回归）后再点「配置」→ 应自动整页刷新并落在该路由（而非永久点不动）。
6. **retention 口径**：config.json 改 `backupRetention: 0` → 重启 → 配置页显示 1；删掉该字段 → 重启 → 显示 5。
7. **offline 逃生口**：own 态点「立即备份」，备份横幅出现后立刻强杀面板进程 → 约 60s 内出现「面板服务不可达」覆盖层（不再无限容忍）。
8. **Agents 时间列**：最近使用/签发时间以本地化格式（toLocaleString）显示，与备份页一致。

## 里程碑

- M1（本计划）：地基——编排、客户端、骨架、仪表盘。
- M2：内容 CRUD（页面库/记忆库/快速记事）。M3：图谱/时间线/回收站。M4：运维/备份/配置。
