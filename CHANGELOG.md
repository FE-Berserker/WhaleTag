# Changelog

All notable changes to this project will be documented in this file.
本项目所有重要变更均记录于此文件。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),并遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [0.3.1] - 2026-07-18

### Added

- **pdf-viewer large-file streaming**: PDFs stream via `whale-file://` Range requests (pdfjs `getDocument({url, rangeChunkSize})`) instead of base64-encoding the whole file through IPC + postMessage — eliminates the O(n²) renderer string concat and ~3× peak memory on big PDFs.
  **pdf-viewer 大文件流式**:PDF 通过 `whale-file://` Range 请求流式加载(pdfjs `getDocument({url, rangeChunkSize})`),而非整份文件 base64 经 IPC + postMessage 传输 —— 消除大 PDF 的 O(n²) 渲染层字符串拼接与约 3 倍峰值内存。

### Performance

- **Office→PDF keep-alive UNO worker** (P3-3): a long-lived LibreOffice UNO listener (Python worker in a utility process) replaces per-conversion `soffice` spawns — cold start happens once, subsequent Office→PDF conversions reuse the initialized process (~200–500ms vs 2–5s per spawn). Falls back to the legacy `execFile` path when Python/UNO is unavailable.
  **Office→PDF 常驻 UNO worker**(P3-3):保活一个 LibreOffice UNO listener(utilityProcess 里的 Python worker),取代每次转换都 spawn 新 `soffice` —— 冷启动只付一次,后续 Office→PDF 复用已初始化的进程(约 200–500ms,vs 每次 spawn 的 2–5s)。Python/UNO 不可用时回退到旧的 `execFile` 路径。
- **dwg/ebook IPC zero-copy** (P1-4): `convertDwgToDxf` / `convertEbookToEpub` handlers return the Buffer directly (Electron IPC serializes it to `Uint8Array`) instead of allocating a fresh `ArrayBuffer` + `.set()` memcpy on every open.
  **dwg/ebook IPC 零拷贝**(P1-4):`convertDwgToDxf` / `convertEbookToEpub` handler 直返 Buffer(Electron IPC 自动序列化为 `Uint8Array`),而非每次打开都新分配 `ArrayBuffer` + `.set()` memcpy。

### Fixed

- **UNC network share playback** (`\\server\share\...`): `whale-file://` / `whale-audio://` URL encode/decode now handles UNC paths — the server is encoded as the URL host (WHATWG `file://` semantics) and recovered on decode, instead of being dropped by Chromium's host normalization (which surfaced as a 403). ASCII server names only; a non-ASCII server is rejected with a clear error rather than a silent bad URL.
  **UNC 网络共享播放**(`\\server\share\...`):`whale-file://` / `whale-audio://` URL 编解码现支持 UNC 路径 —— server 编为 URL host(WHATWG `file://` 语义),decode 时还原,而非被 Chromium 的 host 规范化丢掉(此前表现为 403)。仅支持 ASCII server 名;非 ASCII server 返回明确错误而非静默坏 URL。

## [0.3.0] - 2026-07-16

### Added

- **Audio playback + transcoding**: in-app background music dock that keeps playing across view switches; `whale-audio://` protocol serves transcoded audio; media-player extension + dock wired through ExtensionHost. Audio conversion pipeline reuses the cache/semaphore pattern.
  **音频播放 + 转码**:应用内背景音乐 dock,跨视角切换持续播放;`whale-audio://` 协议提供转码音频;media-player 扩展 + dock 经 ExtensionHost 接入。音频转换管线复用缓存/信号量模式。
- **`whale-file://` HTTP Range support**: `<video>`/`<audio>`/`<img>` can scrub and load metadata without re-downloading from byte 0. Range math factored into a unit-tested `protocol-range.ts`.
  **`whale-file://` HTTP Range 支持**:`<video>`/`<audio>`/`<img>` 可拖动进度、加载元数据而无需从 0 字节重下。Range 计算抽进有单测的 `protocol-range.ts`。
- **office-viewer**: cached-thumbnail placeholder during cold LibreOffice convert + rAF scroll-synced "cur / total" page indicator.
  **office-viewer**:LibreOffice 冷转码期间显示缓存缩略图占位 + rAF 滚动同步的「当前 / 总」页码指示。
- **i18n**: ja / ko / zh-TW locales (en / zh / zh-TW / ja / ko), with a key/plural/placeholder alignment test.
  **国际化**:新增 ja / ko / zh-TW 语言(en / zh / zh-TW / ja / ko),附 key/复数/占位符对齐测试。

### Performance

- **Cold start**: heavy native deps (sharp / @napi-rs/canvas / exifr / jschardet / iconv-lite) lazy-loaded via `createRequire` instead of eager top-level imports; thumbnail generation bounded by a shared `Semaphore(4)` across file + folder paths.
  **冷启动**:重型原生依赖(sharp / @napi-rs/canvas / exifr / jschardet / iconv-lite)经 `createRequire` 惰性加载,而非顶层 eager import;缩略图生成受跨文件/文件夹路径的共享 `Semaphore(4)` 约束。
- **Renderer**: memoized `EntryTagChips` / `ThumbIcon`; virtualized Kanban / Matrix card stacks (`react-window`); narrowed Redux selectors + stable empty-reference constants; ResizeObserver guards.
  **渲染层**:`EntryTagChips` / `ThumbIcon` memo 化;Kanban / Matrix 卡片堆虚拟化(`react-window`);收窄 Redux selector + 稳定空引用常量;ResizeObserver 守卫。
- **Main**: `importExternal` parallelized; `atomicWrite` stale-temp scan memoized per target; ODA binary probe + immutable wasm/pdf asset reads cached.
  **主进程**:`importExternal` 并行化;`atomicWrite` 残留 temp 扫描按目标 memo;ODA 二进制探测 + 不可变 wasm/pdf asset 读取缓存。

### Fixed

- `EntryContextMenu` test no longer hangs the single-process `npm test` run (final MUI Modal portal now unmounted in `after()`).
  `EntryContextMenu` 测试不再卡住单进程 `npm test`(最终的 MUI Modal portal 现在在 `after()` 里卸载)。
- `MapiqueView` tray-filter test updated for the Select-based filter (was ToggleButton).
  `MapiqueView` tray-filter 测试改为基于 Select 的过滤器(原来是 ToggleButton)。

## [0.1.0] - 2026-07-10

### Performance

- **Renderer bundle**: code-split the 9 perspective views via `React.lazy` (echarts / leaflet / @xyflow load on demand); initial entry 4.7 MiB → 0.94 MiB (-80%).
  **渲染层 bundle**:9 个视角经 `React.lazy` 代码分割(echarts / leaflet / @xyflow 按需加载);首屏入口 4.7 MiB → 0.94 MiB(-80%)。
- **Main process**: archive extraction moved off the synchronous path (was a 60 s UI freeze); pdfjs / ffmpeg-static deferred off cold start; LibreOffice / ffmpeg / calibre / dwg2dxf spawns bounded by a shared concurrency semaphore (soffice serialized for profile-lock safety); binary-path probes memoized once per process.
  **主进程**:解压移出同步路径(原来是 60s UI 卡顿);pdfjs / ffmpeg-static 移出冷启动;LibreOffice / ffmpeg / calibre / dwg2dxf spawn 受共享并发信号量约束(soffice 串行化以防 profile-lock 冲突);二进制路径探测每进程 memo 一次。
- **Full-text index**: incremental rebuild (only mtime loaded into memory, not document bodies) + parallel walk/extraction; re-indexing an unchanged corpus is now near-free.
  **全文索引**:增量重建(只把 mtime 载入内存,不含文档正文)+ 并行遍历/抽取;对未变语料重索引近乎零成本。
- **Re-render**: `FileListHeader` memoized; `useNow` shares a single 60 s interval across all consumers; new-tag colors assigned in one batched dispatch; `DirectoryContentContext` split into data/UI slices so a rescan no longer re-renders the tree/toolbar.
  **重渲**:`FileListHeader` memo 化;`useNow` 在所有消费方间共享单个 60s 定时器;新标签颜色一次性批量 dispatch;`DirectoryContentContext` 拆成数据/UI 切片,重扫描不再重渲目录树/工具栏。
- **Directory tree**: virtualized (react-window) — expanding a large subtree no longer mounts thousands of rows.
  **目录树**:虚拟化(react-window)—— 展开大子树不再挂载上千行。
- **EXIF cache**: batched writes (one fsync per folder vs one per image).
  **EXIF 缓存**:批量写入(每文件夹一次 fsync,而非每图一次)。

### Changed

- **Responsive layout**: the perspective switcher folds specialized views into an overflow menu below 720 px; below 1200 px the locations + directory-tree panels merge into a tabbed column; AI panel default width narrowed (420 → 380).
  **响应式布局**:视角切换器在 720px 以下把专用视角折进溢出菜单;1200px 以下位置 + 目录树面板合并为标签列;AI 面板默认宽度收窄(420 → 380)。

### Fixed

- AI tool-approval modal never appeared (`allowDangerouslySkipPermissions` was always on, shadowing `canUseTool`) — now scoped to `yolo` mode only.
  AI 工具批准弹窗从不出现(`allowDangerouslySkipPermissions` 一直开着,遮蔽了 `canUseTool`)—— 现仅在 `yolo` 模式启用。
- 8 unit-test files were silently never executed (hardcoded test list) — replaced with glob auto-discovery; a `pretest` type-check gate now catches type regressions before tests run.
  8 个单测文件静默地从未执行(硬编码测试列表)—— 改为 glob 自动发现;新增 `pretest` type-check 闸门,测试前先抓类型回归。

## [0.0.1] - 2026-07-08

### Added

- Initial release of WhaleTag, a local-first, offline, privacy-respecting desktop file manager and tagging tool.
  WhaleTag 初版发布 —— 本地优先、离线、隐私安全的桌面文件管理与打标签工具。
- **Locations**: local folder locations with read-only flags and LRU recent access tracking.
  **位置管理**:本地文件夹位置 + 只读标记 + LRU 最近访问追踪。
- **Browsing**: directory tree, breadcrumb navigation, and virtual scroll across list / grid / gallery views, with nine perspectives gated by a global `viewDepth`.
  **浏览**:目录树 + 面包屑导航 + 跨 list / grid / gallery 的虚拟滚动,9 个视角受全局 `viewDepth` 控制。
- **Perspectives**: list, grid, gallery, task (Kanban + Matrix + Gantt), calendar (five levels), mapique, folderviz, tag cloud, and knowledge graph.
  **视角**:list、grid、gallery、task(Kanban + Matrix + Gantt)、calendar(5 档)、mapique、folderviz、tag cloud、knowledge graph。
- **Tagging**: `wsd.json` aggregate sidecar; mutex tag families (rating 1–5, workflow, quadrant, smart date ×7, period); inline tag editor; three-tier color fallback.
  **标签**:`wsd.json` 聚合 sidecar;互斥标签家族(评分 1–5、workflow、quadrant、smart date ×7、period);inline 标签编辑器;颜色三级回退。
- **Search**: SQLite FTS5 index over filenames, tags (trigram), and full text; advanced `SearchQuery` with ten fields; saved searches.
  **搜索**:SQLite FTS5 索引覆盖文件名、标签(trigram)、全文;高级 `SearchQuery` 10 个字段;保存搜索。
- **Thumbnails**: image, SVG, video, PDF, Office, eBook, and font thumbnails plus folder thumbnails; 39 fallback file icons.
  **缩略图**:image、SVG、video、PDF、Office、eBook、font 缩略图 + 文件夹缩略图;39 类回退文件图标。
- **Themes**: 11 built-in themes (3 classic + 8 curated) plus system theme resolution before MUI.
  **主题**:11 种内置主题(3 经典 + 8 策划)+ system 主题在流入 MUI 前先解析。
- **Extensions**: 17 built-in viewers and editors; revision history; Open With support; archive viewer for 9 formats; CAD viewer with four tiers.
  **扩展**:17 个内置 viewer/editor;修订历史;Open With 支持;archive-viewer 解码 9 种格式;CAD viewer 4 tier。
- **AI assistant**: embedded Claude Code CLI plus HTTP provider (Ollama / OpenAI-compatible); streaming sidebar; read-only guardrails; safeStorage key management.
  **AI 助手**:嵌入 Claude Code CLI + HTTP provider(Ollama / OpenAI 兼容);流式侧栏;只读护栏;safeStorage 密钥管理。
- Security model: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; all file IO in the main process through `assertWithinAllowedRoot`.
  安全模型:`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`;所有文件 IO 在主进程,统一走 `assertWithinAllowedRoot`。

### Changed

- README cleanup: removed remaining TagSpaces references.
  README 清理:移除残留的 TagSpaces 引用。
