# gbrain 可视化操作面板 — 设计规格

日期：2026-08-26
状态：已与用户逐节确认，待最终审阅
目标项目路径：`D:\gbrain-panel`（独立项目，不修改 gbrain 源码）

## 1. 背景与目标

gbrain（D:\gbrain-stock，v0.46.30.0）的官方 admin 面板只有只读观测（dashboard/agents/请求日志/calibration/jobs）和密钥管理，**没有知识内容的浏览与增删改界面**。本项目为其补一个本地可视化操作面板，覆盖：

1. 知识库内容浏览（页面/实体、记忆 facts、时间线、关系图）
2. 内容增删改（页面编辑/软删/恢复、fact 新增/遗忘、快速记事）
3. 运维功能复刻（统计、请求日志、任务队列、Agents/密钥管理）
4. 维护工具（备份+保留策略、配置展示）

### 硬约束（源码勘察结论）

- **PGLite 单写者锁**：brain.pglite 无只读连接，任何访问必须经由一个常驻 `gbrain serve --http` 进程。CLI 命令在 serve 持锁期间会被拒绝（LiveServeLockError，属预期行为）。
- **内容操作原料齐全**：`/mcp` 端点（StreamableHTTP）暴露全量 op 目录（`--surface full`），含 `list_pages/get_page/put_page/delete_page/restore_page/search/get_links/get_timeline/traverse_graph/recall/remember/forget` 等。
- **运维数据走 admin API**（cookie 会话鉴权）：`/admin/api/stats`、`/admin/api/health-indicators`、`/admin/api/requests`、`/admin/api/jobs/watch`、`/admin/api/agents`、`/admin/api/api-keys`、SSE `/admin/events`。
- **删除语义**：页面软删（deleted_at，72h 可恢复）；fact 遗忘=过期（审计保留，非物理删除）。

## 2. 架构与进程模型（用户已确认）

```
浏览器 ── http://127.0.0.1:7070 ── 面板后端（Bun + Hono，仅监听 127.0.0.1）
                                    ├─ 静态托管 Vue SPA
                                    ├─ orchestrator：serve 生命周期管理
                                    ├─ gbrain-client：admin 会话 + API key + /mcp 调用
                                    └─ backup：停机备份 + 保留策略
                                    ▼
                        gbrain serve --http :3131（面板子进程，--surface full）
                                    │ 唯一持锁者
                                    ▼
                        D:\gbrain-stock\brain-data\.gbrain\brain.pglite
```

**生命周期**：
- 面板启动 → 探测 `http://127.0.0.1:3131/health`。
  - 不通 → spawn `gbrain serve --http --surface full --port 3131`，注入 `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`（面板自有固定 token，首启生成）与 `GBRAIN_HOME=D:\gbrain-stock\brain-data`，等待健康（超时 30s）。
  - 通 → attach 模式（复用已有 serve）；随后用自有 token 登 admin 验证身份，登不上则提示用户处理，**绝不自动杀未知进程**；用户可选择让面板从 3132 起递增探测空闲端口、自己再拉一个 serve。
- 面板退出 → `taskkill /PID <pid> /T /F` 整树清理，锁释放，ZCode 的 stdio gbrain MCP 恢复可用。
- **共存前瞻**：attach 模式使未来 ZCode 切换为 HTTP MCP 接入同一 serve 成为可能，届时无需改架构。

**鉴权链**（全部在后端完成，token 不进浏览器）：
1. bootstrap token → `POST /admin/login` → cookie 会话（24h）。
2. `POST /admin/api/api-keys` 为面板签一张 API key。
3. 内容操作走 `/mcp`（`Authorization: Bearer <key>`，StreamableHTTP `tools/call`）。
4. 前端 ↔ 面板后端：本机无鉴权。

**配置文件** `D:\gbrain-panel\config.json`（首启生成）：gbrain 可执行路径（默认 `C:\Users\wuji\.bun\bin\gbrain.exe`）、GBRAIN_HOME、面板端口（默认 7070）、gbrain 端口（默认 3131）、bootstrap token（≥32 位随机，符合 `[A-Za-z0-9_-]+`）、备份目录（默认 `D:\gbrain-backup`）、备份保留份数（默认 5）。

## 3. 信息架构（页面树）

```
📊 仪表盘        统计卡片 + 健康指标（admin stats / health-indicators）
📝 内容
   ├─ 页面库     分页列表、混合搜索（全文+语义，带 chunk 证据）、
   │             过滤（source/类型/标签）
   │             详情：markdown 渲染 + 元数据 + 关联链接 + 时间线 + 版本历史
   │             操作：编辑（markdown + frontmatter 双模式）、软删除
   ├─ 记忆库     facts 表格：按实体/类型(事件·偏好·信念·承诺·事实)/可见性过滤，
   │             含已过期/被取代（审计视角）；新增 fact、遗忘（必填理由）
   └─ 快速记事   大输入框 + 实体/类型可选 → remember（provenance="panel"）
🕸️ 知识图谱      G6 力导向图（pages + links），节点懒展开（点击取一度邻居），
                 点节点出实体卡片侧栏；按 source/类型过滤、深度限制
📅 时间线        timeline_entries 全局按日期浏览
🗑️ 回收站        软删除页（72h 窗口）：恢复 / 彻底清除（输入页面名确认）
🛠️ 运维
   ├─ 请求日志   MCP 请求日志分页（admin requests）
   ├─ 任务队列   jobs 快照 + SSE 实时刷新（代理 /admin/events）
   └─ Agents     OAuth 客户端 + API key 管理（建/撤）
⚙️ 维护
   ├─ 备份       一键备份 + 历史列表（时间/大小/手动删除）
   └─ 配置       search.mode / embedding 模型等 config 只读展示
```

## 4. 关键数据流

### 4.1 内容 CRUD 的 op 映射

| 面板操作 | gbrain 接口 | 备注 |
|---|---|---|
| 页面列表/搜索 | `/mcp` `list_pages` / `search` | search 混合检索 |
| 页面详情 | `get_page` / `get_links` / `get_timeline` | 详情页多 tab 数据源 |
| 保存/新建页面 | `put_page` | content + frontmatter |
| 软删/恢复 | `delete_page` / `restore_page` | 回收站数据源 = deleted_at 非空 |
| facts 列表 | `recall`（include_expired + entity 过滤） | fact_id 直接用于遗忘 |
| 新增 fact | `remember` | provenance 固定 "panel" |
| 遗忘 fact | `forget`（id + reason 必填） | 过期语义，审计保留 |
| 图谱 | `list_pages` + `get_links` / `traverse_graph` | 前端 G6 渲染，懒展开 |
| 运维数据 | admin API（cookie 会话） | 见 §2 鉴权链 |
| SSE 实时事件 | 代理 `/admin/events` | 任务队列页 |

### 4.2 危险操作分级

- 软删除 / 遗忘 fact：普通确认弹窗。
- 彻底清除（purge）：输入页面名确认。
- 备份（停 serve）：顶部横幅倒计时提示"服务暂停中（约 N 秒）"。

### 4.3 备份流程（backup.ts）

1. 拒绝执行条件校验（serve 非"面板自有子进程"模式时拒绝，避免杀别人的 serve）。
2. tree-kill serve → 完整复制 `brain-data\.gbrain`（含 WAL）→ `D:\gbrain-backup\brain-YYYYMMDD-HHmmss\`。
3. 重启 serve（重新走健康等待 + 登录 + 签 key）。
4. 清理旧备份，只保留最近 5 份。
5. 全程不写系统盘临时目录（磁盘安全铁律）。

## 5. 错误处理与边界

| 场景 | 处理 |
|---|---|
| serve 拉不起来/健康超时 30s | 面板错误态：子进程 stderr 尾部日志 + 重试按钮 |
| attach 模式 token 不匹配 | 提示"端口上有一个不认识的 serve"；用户手动处理，或面板换备用端口自拉 |
| admin 会话中途过期（24h） | 401 → 自动用 bootstrap token 重登一次再重试，失败才报错 |
| serve 子进程意外崩溃 | orchestrator 监听 exit；UI 全局"连接断开"遮罩 + 一键重启；提示写操作可能中断 |
| /mcp 调用失败 | toast 报错（op 名 + gbrain 原始错误），不吞异常 |
| 退出清理 | `taskkill /T /F` 整树杀，防孤儿进程占锁 |
| 陈旧锁 | health 不通但锁目录存在 → 按 30s 心跳规则判定持有者已死 → 提供"清除陈旧锁"按钮（仅删心跳超时的 `.gbrain-lock`） |

## 6. 项目结构

```
D:\gbrain-panel
├─ package.json            # bun 工作区根（scripts: dev/build/start）
├─ config.json             # 首启生成
├─ server/                 # Bun + Hono
│  ├─ index.ts             # 入口：orchestrator → 路由 → 静态托管
│  ├─ orchestrator.ts      # spawn/attach/health/exit 监听/tree-kill
│  ├─ gbrain-client.ts     # admin 登录+保活 / 签 key / /mcp call 封装
│  ├─ backup.ts            # 停机复制 + 保留策略
│  ├─ stale-lock.ts        # 陈旧锁检测与清理
│  └─ routes/              # pages / facts / graph / timeline / recycle / ops / maintain
└─ web/                    # Vue 3 + Vite + Naive UI + AntV G6
   └─ src/
      ├─ views/            # dashboard / pages / pageDetail / facts / capture
      │                    # / graph / timeline / recycle / ops×3 / maintain×2
      ├─ components/       # EntityCard / MarkdownEditor / ConfirmDanger 等
      ├─ api/              # 面板后端 REST 客户端（全局错误 toast）
      └─ stores/           # pinia：连接状态 / 用户偏好
```

## 7. 里程碑（每步为可用增量；构建/启动由用户手动执行）

- **M1 地基**：orchestrator + gbrain-client + 仪表盘。验收：面板启动能拉起 serve；退出后锁释放、ZCode stdio MCP 立即可用。
- **M2 内容 CRUD**：页面库 + 详情（编辑/软删）+ 记忆库 + 快速记事。核心价值。
- **M3 可视化**：知识图谱（懒展开力导向图）+ 全局时间线 + 回收站。
- **M4 运维与维护**：请求日志/任务队列/Agents + 备份（含停机横幅）+ 配置页。

## 8. 测试策略

- **orchestrator 状态机**（bun test）：假 gbrain 脚本（批处理）模拟 health 成功/超时/秒退/占端口，测 spawn/attach/tree-kill/孤儿检测，不依赖真库。
- **gbrain-client**（bun test）：mock fetch 测登录重试、key 签发、/mcp 错误透传。
- **backup**（bun test）：临时目录测复制完整性、保留策略、serve 未停时拒绝执行。
- **真实链路**：每里程碑用户手动验收（M1 专门验收"退出后 ZCode MCP 恢复"）。
- 前端 V1 以手动验收为主，不上 e2e 框架（YAGNI）。

## 9. 实现期需验证的事项（不阻塞设计）

1. full surface 是否含页面彻底清除（purge）op；若无，回收站 V1 仅做恢复，purge 后置。
2. `/admin/api/api-keys` 签发的 key 所需 scope（read/write）与其在 `/mcp` 的鉴权表现。
3. Windows 下 `gbrain.exe`（bun shim）spawn 的进程树形态，确保 taskkill 整树命中。
4. `search` op 的入参形态与过滤条件（source/类型/标签）映射方式。
5. `list_pages` 分页参数与 `traverse_graph` 深度参数的精确签名。
6. 全局时间线页的数据源：确认是否存在跨页的 timeline 列举 op；若无，降级方案为"近期页面流"（按 last_touched 排序的页面列表 + 每页最新 timeline 条目摘要）。

## 10. 明确不做（YAGNI）

- 不修改 gbrain 源码 / 不 fork / 不碰 `D:\gbrain-stock`。
- 不做用户管理、多用户、远程访问（仅 127.0.0.1）。
- 不做 calibration 图表复刻（个人场景价值低，需要时跳官方 admin）。
- 不做 doctor 的 CLI 包装（serve 持锁时不可运行，用 health-indicators 替代）。
- V1 不做页面版本 diff 对比 UI（仅列出版本）。
- 不做 ZCode MCP 配置改动（保持 stdio；共存切换属未来可选演进）。
