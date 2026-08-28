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

## M5 验收清单（手动，需先 build:web 并启动面板）

M5-3 行为改动（备份轮询降载 + online 容忍 + SSE 原生重连）手验点：

1. **status 合并 backupRunning**：面板打开后，DevTools Network 里 `/api/status` 响应含
   `backupRunning` 字段；每 5s 的全局轮询**不再**请求 `/api/backups`（备份列表仅在打开备份页时拉取）。
2. **备份期 online 不闪断**：点「立即备份」→ 顶部横幅出现；备份期间（serve 停止/阻塞，status 可能
   短暂拉取失败）顶栏连接状态保持在线，不闪红；备份完成后横幅消失。
3. **SSE 原生重连**：请求日志页点「实时流」→ 正常收事件；重启面板后端（Ctrl+C 再启动）→ 出现一次
   「连接中断，自动重连中…」提示，按钮保持「实时中」；后端起来后**不做任何操作**，新事件自动恢复
   插入列表头部（EventSource 原生重连）；点按钮手动停止仍立即断开。

## 里程碑

- M1（本计划）：地基——编排、客户端、骨架、仪表盘。
- M2：内容 CRUD（页面库/记忆库/快速记事）。M3：图谱/时间线/回收站。M4：运维/备份/配置。
