# Whale 开发文档(入口)

> Whale = 本地优先、离线、隐私安全的文件管理与打标签桌面应用。
> 项目基于 Electron + React + TS,代码 MIT,全部功能免费开源。
> 本文档只做导航与原则,细节一律在 `docs/` 下按域拆分。

---

## 模块文档索引

每篇文档描述**当前代码行为**,不写历史变更;改代码就改对应模块文档,不动本文。

| 文档 | 主题 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 三进程模型、`window.whale` 桥、`.whale/` 元数据目录、安全模型、构建/打包、关键踩坑 |
| [docs/02-file-io.md](docs/02-file-io.md) | 位置、目录浏览、文件操作、回收站、redux-persist 同步 IO |
| [docs/03-tagging.md](docs/03-tagging.md) | `wsd.json` 聚合 sidecar、标签库/组、互斥家族、颜色回退、InlineTagInput |
| [docs/04-search-index.md](docs/04-search-index.md) | SQLite FTS5 即时搜索、目录/全文索引、高级查询、保存搜索 |
| [docs/05-perspectives.md](docs/05-perspectives.md) | 9 类有效视角 + Task 第三档(Kanban/Matrix/Gantt)与全局递归深度 |
| [docs/06-thumbnails.md](docs/06-thumbnails.md) | 缩略图管线(7 种 ThumbKind)、文件夹缩略图、回退图标 |
| [docs/07-extensions.md](docs/07-extensions.md) | 扩展协议、8 个内置扩展、修订历史、双层 iframe 拓扑 |
| [docs/08-data-depth.md](docs/08-data-depth.md) | `DirectoryContentContextProvider` 单一数据源、全局 `viewDepth`、path-keyed 投影 |
| [docs/09-known-issues.md](docs/09-known-issues.md) | 已修关键 bug 与反复踩过的坑(冷启动黑魔法、redux-persist 引用一致性等) |
| [docs/10-ui.md](docs/10-ui.md) | 11 种主题模式、12 套 `PRESETS` token、`'system'` 必须解析、设置面板 |
| [docs/12-frontend-checklist.md](docs/12-frontend-checklist.md) | 前端 UI 手动核对清单 |
| [docs/13-security.md](docs/13-security.md) | 当前安全模型(隔离/沙箱/CSP/allowedRoots)+ 不在范围的能力 |
| [docs/14-packaging.md](docs/14-packaging.md) | `npm run package:win` 流程、nsis 离线、打包/AI 调试排坑(国内网络) |
| [docs/15-perf-audit.md](docs/15-perf-audit.md) | 性能审计与待办清单(§F 例外追踪文档) |
| [docs/16-cross-platform.md](docs/16-cross-platform.md) | macOS / Linux 打包可行性(§F 例外评估文档) |
| [docs/18-auto-update.md](docs/18-auto-update.md) | 应用自动更新(electron-updater + GitHub Releases) |
| [docs/19-code-audit.md](docs/19-code-audit.md) | 代码质量审计与改进清单(§F 例外追踪文档) |
| [docs/20-relative-links.md](docs/20-relative-links.md) | drawio/excalidraw 文件链接相对路径方案(§F 例外方案追踪) |
| [docs/21-mcp.md](docs/21-mcp.md) | 本地 MCP 服务器:外部 AI 客户端经 Streamable HTTP + Bearer token 搜索/读取/打标/打包,文件级操作需审批 |
| [docs/UI.md](docs/UI.md) | 设计语言(从 Pencil `.pen` 导出的主题 token) |

> 找不到某模块的现状?直接从对应 `docs/0X-*.md` 入口找,不必翻 git 历史。

---

## A. 设计原则

1. **本地优先 / 离线**:无后端、无遥测、无强制云。
2. **数据神圣**:任何 IO/删除操作 merge 优先于 wipe;错误必须上抛,绝不静默吞。
3. **安全默认**:`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`;渲染层只经 `window.whale`。
4. **可移植元数据**:标签统一存 sidecar JSON(`.whale/`),不改动文件名与文件夹结构。
5. **平台一致**:路径三形态归一(Mac/Linux `\`、Windows `\ `、云 `/` 无盘符)。
6. **免费优先**:无功能阉割、无试用倒计时、不联网鉴权。

## B. 架构速览

三进程 ERB 模型:**Main**(全部 FS IO / 缩略图 / 索引 / 扩展转换 / AI CLI 子进程)→ **Preload**(`contextBridge` 暴露 `window.whale`,渲染层唯一桥)→ **Renderer**(React,web target)。`src/shared/` 只放 main + renderer 都引用的契约;纯渲染层逻辑放 `src/renderer/domain/`。持久化走主进程 IPC 原子落盘(tmp+rename),不用 Chromium localStorage。元数据全部在 `.whale/` 目录(sidecar + 索引 + 缩略图 + 修订),相对路径存储便于整体迁移。

详见 [docs/01-architecture.md](docs/01-architecture.md)。

## C. 已知坑速查(进入新模块前请读)

1. `unset ELECTRON_RUN_AS_NODE` 是 dev 启动硬约束(残留会让 Electron 退化成 Node)。
2. `autoMergeLevel1` reconciler 比较引用 —— 返回新对象的纯函数会跳过 slice rehydration。
3. 路径须过 `fs.realpathSync` 校验才能进 `setAllowedRoots`(symlink 逃逸)。
4. `'system'` 与策划主题模式绝不能直接流入 `createTheme.palette.mode`。
5. drawio/excalidraw 双层 iframe 拓扑:扩展协议 + CSP + 协议注册三件套缺一不可。
6. redux-persist 写盘必须 `writeFileSync(.tmp) + renameSync`,close-fallback 不能丢数据。

完整列表见 [docs/09-known-issues.md](docs/09-known-issues.md);性能、测试、i18n 等横切关注点见各模块文档。

## D. 文档维护约定

- **代码 / bug / 改 API** → 更新对应 `docs/0X-*.md`,**不动 plan.md**。
- **新增模块** → `docs/0X-name.md`,头部加 `← 返回 [plan.md](../plan.md)`,并加到本文件"模块文档索引"表。
- **跨文档引用**:`plan.md` → `./docs/0X.md`;docs 互引 → `./0X.md`;docs 指源码 → `../src/...`。
- **不做未来计划**:roadmap 与待办落进相应 `docs/0X-*.md` 的"已知取舍 / 遗留"或开新章节,不在 plan.md 与 docs 主体保留"未来做 X"段落。
