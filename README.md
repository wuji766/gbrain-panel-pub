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

## 里程碑

- M1（本计划）：地基——编排、客户端、骨架、仪表盘。
- M2：内容 CRUD（页面库/记忆库/快速记事）。M3：图谱/时间线/回收站。M4：运维/备份/配置。
