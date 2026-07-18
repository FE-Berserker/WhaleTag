# Whale 开发文档(入口)

> Whale = 本地优先、离线、隐私安全的文件管理与打标签桌面应用。
> 项目基于 Electron + React + TS,代码 MIT,全部功能免费开源。
> 本文档反映**当前代码状态**,各模块细节在 `docs/` 下按域拆分。

---

## 模块文档索引

每篇文档描述**当前代码行为**,不写历史变更记录;新增需求或调整架构时,改对应模块文档而不是本文。

| 文档 | 主题 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 三进程模型、`window.whale` 桥、`.whale/` 元数据目录、安全模型、构建/打包、关键踩坑 |
| [docs/02-file-io.md](docs/02-file-io.md) | 位置、目录浏览、文件操作(重命名/移动/复制/删除/新建)、回收站、redux-persist 同步 IO |
| [docs/03-tagging.md](docs/03-tagging.md) | `wsd.json` 聚合 sidecar、标签库、标签组、互斥家族(评分/工作流/象限/日期/期间)、颜色三级回退、InlineTagInput |
| [docs/04-search-index.md](docs/04-search-index.md) | SQLite FTS5 即时搜索、目录索引、全文索引、高级查询、保存搜索 |
| [docs/05-perspectives.md](docs/05-perspectives.md) | 9 类有效视角 + ViewMode 联合 + Task 第三档(Kanban/Matrix/Gantt)与全局递归深度 |
| [docs/06-thumbnails.md](docs/06-thumbnails.md) | 缩略图管线(image/svg/video/pdf/office/ebook/font)、文件夹缩略图、39 类回退图标 |
| [docs/07-extensions.md](docs/07-extensions.md) | 扩展协议、15 个内置扩展(viewer/editor)、修订历史、双层 iframe 拓扑 |
| [docs/08-data-depth.md](docs/08-data-depth.md) | `DirectoryContentContextProvider` 单一数据源、全局 `viewDepth`、path-keyed 投影、截断与防抖 |
| [docs/09-known-issues.md](docs/09-known-issues.md) | 已修过的关键 bug 摘要与反复踩过的坑(冷启动黑魔法、redux-persist 引用一致性等) |
| [docs/10-ui.md](docs/10-ui.md) | 11 种主题模式(3 经典 + 8 策划)、12 套 `PRESETS` token、`'system'` 必须经过解析、8 分类设置面板 |
| [docs/11-ai.md](docs/11-ai.md) | AI 助手(嵌入 Claude Code CLI + HTTP provider)、流式侧栏、工具/批准、只读护栏、safeStorage 密钥 |
| [docs/12-frontend-checklist.md](docs/12-frontend-checklist.md) | 前端 UI 手动核对清单(分模块 `- [ ]`) |
| [docs/13-security.md](docs/13-security.md) | 当前安全模型(隔离/沙箱/CSP/allowedRoots)+ 不在范围的能力 |
| [docs/14-packaging.md](docs/14-packaging.md) | `npm run package:win` 完整流程、nsis-resources 离线、打包/AI 调试排坑(国内网络环境) |
| [docs/15-perf-audit.md](docs/15-perf-audit.md) | **性能审计与待办清单**(2026-07-12);Tier 0–3 可勾选优化项 + 已接受取舍 + 可复用范式;plan.md §F 的例外追踪文档 |
| [docs/16-cross-platform.md](docs/16-cross-platform.md) | **macOS / Linux 跨平台打包可行性**(2026-07-12);已就绪代码清单 + 硬阻塞(mac 签名)+ 需改项(Linux 大小写守卫/DE fallback/图标);§F 例外评估文档 |
| [docs/17-office-worker.md](docs/17-office-worker.md) | **Office→PDF 常驻 UNO worker**(P3-3,2026-07-18);Python 桥接 + 常驻 soffice listener + cooldown 回退 execFile;UNO gotcha / stale-child race / 打包 extraResources |
| [docs/18-auto-update.md](docs/18-auto-update.md) | **应用自动更新**(Phase 6,2026-07-18);electron-updater + GitHub Releases;5s 启动延迟检查 + 手动按钮;dev-mode 短路由 `unsupported`;macOS 公证与 Linux AppImage 见 `docs/16` 硬阻塞 |
| [docs/UI.md](docs/UI.md) | 设计语言(从 Pencil `.pen` 导出,主题 token;源文件描述比代码实际少 2 个策划主题) |

> 找不到某模块的现状?直接从对应 `docs/0X-*.md` 入口找,不必翻 git 历史。

---

## A. 设计原则

1. **本地优先 / 离线**:无后端、无遥测、无强制云。
2. **数据神圣**:任何 IO/删除操作 merge 优先于 wipe;错误必须上抛,绝不静默吞。
3. **安全默认**:`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`;渲染层只经 `window.whale`。
4. **可移植元数据**:标签统一存 sidecar JSON(`.whale/`),**不改动文件名、不改变文件夹结构**。
5. **平台一致**:路径三形态归一(Mac/Linux `\`、Windows `\ `、云 `/` 无盘符)。
6. **免费优先**:无功能阉割、无试用倒计时、不联网鉴权。

## B. 架构总览

**三进程模型(ERB)**:

- **Main**(Node/Electron):所有 FS IO、缩略图、索引、扩展转换、修订历史、AI CLI 子进程;`electron-builder` 打包。
- **Preload**:`contextBridge` 暴露 `window.whale` —— 渲染层唯一接触文件/系统能力的桥。
- **Renderer**(React):web target,webpack 5 多目标打包;`src/renderer` 编译到 `release/app/dist/renderer`。
- **Shared**:`src/shared/` 仅保留**真正跨进程**(main + renderer 都引用)的契约与常量:`ipc-types` / `extension-types` / `ai-types` / `whale-meta` / `whale-file-url` / `search-query` / `archive-types` / `ebook-annotations` / `tags`(`mergeTags`,主进程索引聚合)/ `shell-types` / `smart-tags`(main 用来迁移 / 规范化日期 tag)/ `dedupe-name`。**纯渲染层**的视角计算 / 标签规范化 / GPS 转换 / 大纲布局等独立逻辑都改放 `src/renderer/domain/`(零 main 引用)。改 shared/ 新文件前先确认 main 是否真要用 —— 否则丢 renderer/domain。

**协议**:

- `whale-extension://<ext-id>/...` — 沙箱扩展 iframe (特权协议 `standard+secure`,Electron 42 必需)。
- `whale-file://<encoded-path>` — 支持 Range 的流式文件服务(MediaLightbox 与 `whaleExt.fetch` 媒体)。

**持久化**:redux-persist 走主进程 IPC(async invoke,tmp+rename 落盘;Chromium localStorage 异步会被 3s close-fallback 丢数据),`app.setPath('userData', ...)` 在 `whenReady` 之前 pin 到 `<productName>`,详见 [docs/02-file-io.md](docs/02-file-io.md)。

**`.whale/` 元数据目录**(每个被管理的目录下都建):
```
.whale/
  wsm.json                # 文件夹元数据(viewMode + entrySize + 颜色 / 视角)
  wsd.json                # 目录级聚合 sidecar(所有有标签的文件)
  wtaglib.json            # per-location 标签库(每 tag 描述)
  index.db                # SQLite FTS5 索引(files + files_fts + fulltext_fts + exif_processed)
  thumbs/<basename>.jpg   # 单文件缩略图(256px JPEG)
  wst.jpg                 # 文件夹缩略图
  wsb.jpg                 # 文件夹背景(1024px)
  transcodes/             # 媒体转码缓存(APE/WMA → Opus 等)
  revisions/              # 修订历史备份(<basename>/<ts>.<ext>)
  ebook-annotations/      # 电子书阅读高亮注释(<basename>.json)
  _migration-state.json   # 一次性数据迁移标志
```
相对路径存储,便于整体迁移。

详细架构与安全边界见 [docs/01-architecture.md](docs/01-architecture.md)。

## C. 当前能力清单

| 域 | 实现 |
|---|---|
| 位置管理 | 本地文件夹位置 + 只读标记 + LRU 最近访问;云存储(S3/WebDAV)不在范围 |
| 浏览 | 目录树 + 面包屑 + 虚拟滚动(list/grid/gallery),全部 9 视角受全局 `viewDepth` 控制 |
| 视角 | list / grid / gallery / **task**(Kanban + Matrix + **Gantt**)/ calendar(5 档)/ mapique / folderviz / tagcloud / knowledge-graph(`mindmap` 重命名;TS 联合 10 字面量,运行时有效 9 个) |
| 标签 | `wsd.json` 聚合 sidecar;互斥家族(评分 1–5 / workflow / quadrant / smart date 7 种 / period);`InlineTagInput` 编辑;颜色三级回退 + 标记颜色可覆盖;`period:` 拖拽落日期对话框 |
| 搜索 | SQLite FTS5 文件名 + 标签模糊匹配;`files_fts` (trigram) + `fulltext_fts`;高级查询 `SearchQuery` 10 字段;保存搜索 |
| 缩略图 | image / svg / video / pdf / office / ebook / font(7 种 ThumbKind)+ 文件夹;Excalidraw / Drawio / CAJ / MIDI 不出场景缩略图走品牌图标或系统应用 |
| 主题 | **11 种**(3 经典 + 8 策划 = `warm-paper` / `midnight-plum` / `frosted-mint` / `deep-ocean` / `dawn-blush` / `forest-ink` / `soft-amber` / `high-contrast`);`PRESETS` 数组含 12 项(再加 4 个老 `ocean/forest/sunset/mono`);`'system'` 不流入 MUI,工厂签名收窄为 `mode: 'light' \| 'dark'` |
| 扩展 | **15 个内置**(viewer / editor),主进程 IPC + iframe `postMessage` 桥;修订历史 + 右键 Open With;archive-viewer 解码 9 种(7z 通过 7zip-bin);cad-viewer 4 tier;pdf-viewer iframe 内 pdfjs 浏览器版 + fake worker + 二进制工厂 |
| AI 助手 | Claude Code CLI(**可选 AI 组件**,用户安装 `.whaleai` 7z 包;非主安装包内置,见 [docs/11 §12](docs/11-ai.md))+ HTTP provider(`ollama` / `openai` 共享 runtime);**3 个 IPC 推送通道**(`ai:chunk` / `ai:error` / `ai:approvalRequest`)+ **16 个 invoke 通道**(13 个原 AI 通道 + 3 个组件生命周期 `ai:getComponentState` / `ai:installComponent` / `ai:uninstallComponent`);安全 storage 存 key;统一闸门 `decideToolCall` |
| 自定义命令 | 右键文件/文件夹 → "命令" 子菜单运行用户预置命令(单行模板 + `${path}` / `${dir}` / `${name}` 占位,弹新终端窗口显示输出);设置 → 命令 管理;主进程安全引号([shell-quote.ts](src/main/shell-quote.ts))+ `assertWithinAllowedRoot` 闸 + Windows `%` 拒绝;详见 [docs/13 §11](docs/13-security.md) |

## D. 横切关注点

| 关注点 | 现处理 |
|---|---|
| 路径处理 | `path-util` 三形态归一 + 大小写归一(`isSameOrDescendant`) |
| 只读位置 | 所有写 IPC 走 `assertWithinAllowedRoot`,只读位置不写入 setAllowedRoots(早 throw) |
| 原子写 | `atomicWriteText` / `atomicWriteBytes`:temp + fsync + rename |
| EXDEV 兼容 | move 跨卷时 `copyFile + rm` 回退 |
| 安全 | 沙箱 iframe + 严格 CSP + `registerSchemesAsPrivileged`;扩展 IPC `event.source === iframe.contentWindow` 校验 |
| IO 错误 | 不静默,主进程抛出,renderer 显式 toast |
| 性能 | 缩略图 FIFO 队列 `MAX_CONCURRENT=4`;缩略图/lazy IO;SQLite 分批 yield;viewDepth 200ms 防抖 |
| i18n | `t()` + i18next;en / zh / zh-TW / ja / ko(`scripts/check-locales.test.ts` 强制与 en key 对齐) |
| 测试 | `electron --test --require ts-node/register`(非 jest);70+ `.test.ts(x)` |

## E. 已知坑(进入新模块前请读)

1. **`unset ELECTRON_RUN_AS_NODE`** 是 dev 启动的硬约束(shell 残留会让 Electron 退化成 Node,主进程不启动)
2. **`autoMergeLevel1` reconciler** 比较引用 —— sanitize / migrate 这类返回新对象的纯函数会跳过 settings slice 的 rehydration
3. **路径接受 `fs.realpathSync` 校验** 后才能进 `setAllowedRoots`(symlink 逃逸)
4. **`'system'` 与策划主题模式**绝不能直接流入 `createTheme.palette.mode`
5. **drawio / excalidraw 编辑器**的双层 iframe 拓扑,扩展协议 + 安全 CSP + 协议注册三件套缺一不可
6. **redux-persist 写盘** 必须是 `writeFileSync(.tmp) + renameSync`,Chromium close-fallback 触发时不能丢数据

完整列表见 [docs/09-known-issues.md](docs/09-known-issues.md)。

## F. 文档维护约定

- **代码 / bug / 改 API** → 更新对应 `docs/0X-*.md`,**不动 plan.md**。
- **新增模块** → `docs/0X-name.md`,头部加 `← 返回 [plan.md](../plan.md)`,并加到本文件"模块文档索引"表。
- **跨文档引用**:`plan.md` → `./docs/0X.md`;docs 互引 → `./0X.md`;docs 指源码 → `../src/...`。
- **不做未来计划**:roadmap 与待办在用户讨论中产生,**落进相应 `docs/0X-*.md` 的"已知取舍 / 遗留"或开新章节**,不在 plan.md 与 docs 主体里保留"未来做 X"段落。
