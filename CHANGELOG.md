# Changelog

All notable changes to this project will be documented in this file.
本项目所有重要变更均记录于此文件。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),并遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### Added

- **MCP 直接添加位置**:新增 `whale_add_location`,可将已存在的绝对路径目录加入 WhaleTag,支持自定义名称与位置只读标记。调用需用户在应用窗口明确批准;批准后等待授权记录落盘,由渲染层走标准位置 action、同步 allowed roots 并等待 `redux-persist` 落盘确认,无需退出或重启。重复路径幂等返回,添加调用串行执行,失败会回滚;无窗口、超时与持久化失败均不会误报成功。文件/标签工具确认后可用,搜索索引仍按现有流程单独构建,结果会显式提示。
  **Add locations directly through MCP**: the new `whale_add_location` tool adds an existing absolute-path directory with an optional display name and per-location read-only marker. It requires explicit approval in the app window, persists the authorization record, then uses the renderer's standard location action, syncs allowed roots and waits for the `redux-persist` flush before acknowledging success — no quit or restart. Duplicate paths are idempotent, additions are serialized and failures roll back; missing windows, timeouts or persistence failures never produce false success. File/tag tools are available after acknowledgement, while search indexes remain a separate, explicitly surfaced step.

- **MCP 智能标签目录**:新增只读 `whale_smart_tag_catalog`,直接向 agent 返回看板工作流、任务象限、评分、动态日期、周期和地图坐标的规范值、互斥规则及对应视图;目录从共享智能标签定义派生,并明确区分 UI 别名与实际存储值(如 `5star` 而非 `star5`),说明默认工作流可自定义、涉及自定义阶段时需显式移除旧阶段、WGS-84 多坐标存储及地图仅显示首个有效坐标的约定。`whale_apply_tags` / `whale_list_tags` 描述和服务器初始化说明同步指向该目录。
  **MCP smart-tag catalog**: the new read-only `whale_smart_tag_catalog` gives agents the canonical values, exclusivity rules and views for Kanban workflows, task quadrants, ratings, dynamic dates, periods and map coordinates. Derived from the shared smart-tag definitions, it distinguishes UI aliases from stored values (for example `5star`, not `star5`), documents customizable default workflows, the need to remove old stages explicitly when custom stages are involved, WGS-84 multi-coordinate storage and the map's first-valid-coordinate display rule. The `whale_apply_tags` / `whale_list_tags` descriptions and server initialization instructions now point agents to the catalog.

- **可见 / 隐藏选择计数**:文件列表头的主计数只统计**当前筛选下仍可见**的选中行(批量删除 / 移动 / 打包实际消费的就是这批),被筛选隐藏的选中项另起一行用新键 `nSelectedHidden`(en / zh / zh-TW / ja / ko)说明;隐藏项保持选中、撤销筛选即恢复,但永不进入批量命令,两者都为空时整块不渲染。
  **Visible vs. hidden selection counts**: the file-list header now counts only the selected rows that remain visible under the active filter — exactly the set bulk delete/move/package consume — and reports filter-hidden selections on a separate `nSelectedHidden` line in all five locales. Hidden rows stay selected and reappear when the filter clears, but never enter a bulk command; the block renders nothing when both counts are zero.

- **属性托盘的键盘调宽**:列宽分隔条可聚焦,带 `role="separator"`、`aria-orientation` 与 `aria-valuemin` / `aria-valuemax` / `aria-valuenow`,`←` / `→` 每步 10 px(向左变宽),与鼠标拖拽共用同一对 260–600 px 上下界。
  **Keyboard resizing for the properties tray**: the column separator is focusable and exposes `role="separator"`, `aria-orientation` and `aria-valuemin` / `aria-valuemax` / `aria-valuenow`; the arrow keys resize in 10 px steps (left widens) while sharing the same 260–600 px bounds as pointer dragging.

- **读屏可识别的图标按钮与对话框**:文件工具栏的四个导航按钮、侧栏的添加位置 / 新建 Excalidraw / 新建 Draw.io、标签组折叠按钮都补了 `aria-label`(折叠按钮另带 `aria-expanded`),MCP 审批对话框用 `aria-labelledby` 指向自己的标题。
  **Named icon buttons and dialogs for screen readers**: the four FileToolbar navigation buttons, the sidebar's add-location / new Excalidraw / new Draw.io actions and the tag-group toggles now carry `aria-label` (toggles also expose `aria-expanded`), and the MCP approval dialog labels itself from its own title via `aria-labelledby`.

- **可复跑 GUI 回归**:新增 `scripts/packaged-gui-regression.js`,`npm run test:gui` 默认验证 `release/build/win-unpacked/WhaleTag.exe`,`npm run test:gui:current` 验证当前 `npm run build` 产物(不重新打包);每次使用独立 profile 与 fixture,输出 `result.json` 和关键步骤截图,覆盖冷启动、Add Location、六个图标按钮、四个 Switch、快捷键搜索焦点、三套主题、高级搜索关闭重开后的状态、简体中文日期、属性托盘键盘调宽、1024×640 / 720×480 窄窗口与 console/pageerror/404。已接入手动 `packaged-smoke.yml`。
  **Repeatable GUI regression**: added `scripts/packaged-gui-regression.js`; `npm run test:gui` checks `release/build/win-unpacked/WhaleTag.exe` by default, while `npm run test:gui:current` checks the current `npm run build` output without repackaging. Each run uses an isolated profile and fixture and writes `result.json` plus per-step screenshots, covering cold start, Add Location, six icon buttons, four Switches, shortcut-search focus, three themes, advanced-search state across close/reopen, Simplified Chinese dates, keyboard resizing of the properties separator, 1024×640 / 720×480 narrow windows, and console/pageerror/404 output. Wired into the manual `packaged-smoke.yml`.

- **局域网只读访问(桌面端)**:设置新增「局域网」分类,默认关闭;启动后主进程在 `0.0.0.0` 的临时端口上开只读 HTTP 服务,每次启动生成新的 32 字节随机 token。面板列出全部内网 URL(多网卡可切换)、复制配对链接 `<url>#token=…`、显示二维码(编码器按需 `import('qrcode')`,停止时不加载),运行时每 2 秒轮询状态。手动停止、网卡地址变化、位置增删与应用退出都会立刻结束服务并作废 token 与全部会话。
  **Read-only LAN access (desktop)**: Settings gains a LAN section, off by default; starting it opens a read-only HTTP server on an ephemeral `0.0.0.0` port with a fresh 32-byte random token per start. The panel lists every private-LAN URL (switchable when several interfaces exist), copies the pairing link `<url>#token=…`, shows a QR code (the encoder is loaded through `import('qrcode')` on demand and never while stopped) and polls the status every 2 seconds. Manual stop, a network-address change, added/removed locations, or app quit all end the server immediately and invalidate the token and every session.

- **手机 / 平板只读客户端**:新增 `src/mobile` 独立 web bundle(`dist/mobile`)。用粘贴 token 或扫码配对:fragment 里的 token 在首次请求前就由 `history.replaceState` 抹掉,换取 `HttpOnly` + `SameSite=Strict` 的会话 cookie;自动配对不会并发未认证 roots 探测或重复加载位置。配对后可浏览位置(单层,最多 500 项)、按文件名与索引标签搜索、预览图片 / 视频 / 音频与 256 KiB 文本、下载文件;PDF 只给下载入口;上传 / 删除 / 移动 / 打标入口一概不存在。界面采用紧凑品牌 / 只读顶栏、独立导航与搜索区、手机 76px 左对齐列表和两列网格、平板三列网格与居中限宽列表;安全栅格原图可直接作列表视觉预览,失败回退图标且不生成缓存。
  **Read-only phone / tablet client**: a standalone `src/mobile` web bundle (`dist/mobile`). Pairing accepts a pasted token or a QR scan: the token in the URL fragment is erased with `history.replaceState` before the first request and exchanged for an `HttpOnly` + `SameSite=Strict` session cookie, without a parallel unauthenticated roots probe or duplicate roots load. Once paired it browses locations one level at a time (500 entries max), searches by file name and indexed tags, previews images / video / audio and the first 256 KiB of text, and downloads files; PDFs are download-only and there is no upload, delete, move or tagging entry point at all. The interface uses a compact brand/read-only header, dedicated navigation and search regions, 76px left-aligned phone rows and a two-column phone grid, plus a three-column tablet grid and centered width-limited tablet list. Safe raster originals provide in-list visual previews with icon fallback and no generated cache.

- **索引与 sidecar 的只读读取路径**:index worker 新增 `index:readonly-advanced` / `index:readonly-tags`;`getReadOnlyDb()` 以 `readonly: true` + `PRAGMA query_only = ON` 打开短连接、查完立即关闭(不走会设 WAL 并执行 SCHEMA 的 `getDb()`),索引库不存在时返回 `indexUnavailable` 而不是创建 `.whale/`。标签走 `readSidecarsReadOnly()`:不加写锁、不导入 legacy JSON、不持久化经纬度换算、不创建 `wsd.json`。
  **Read-only query paths for the index and sidecars**: the index worker gains `index:readonly-advanced` / `index:readonly-tags`; `getReadOnlyDb()` opens a short-lived connection with `readonly: true` and `PRAGMA query_only = ON`, closes it right after the query and deliberately avoids `getDb()` (which sets WAL mode and executes SCHEMA). A missing database reports `indexUnavailable` instead of creating `.whale/`. Tags go through `readSidecarsReadOnly()`, which takes no write lock, imports no legacy JSON, persists no lat/lng conversions and creates no `wsd.json`.

- **移动端构建与冒烟接线**:新增 `build:mobile` / `build:mobile:dev` / `watch:mobile`(webpack `target: 'web'` → `dist/mobile`,`npm run build` 与 `npm run dev` 已包含),`dist/mobile` 随现有 `dist/**/*` 规则进 `app.asar`;新增 `test:lan` 并接入手动 `packaged-smoke.yml`(步骤 `Smoke read-only LAN desktop and mobile clients`)。真实打包冒烟覆盖配对、目录 / 搜索 / 标签、Range 文本、原生下载、图片解码、390px 紧凑列表 / 两列网格、768px 三列网格、停止失效、只读元数据快照及禁用动画并保留 opacity 断言后的稳定截图。
  **Mobile build and smoke wiring**: new `build:mobile` / `build:mobile:dev` / `watch:mobile` scripts (webpack `target: 'web'` → `dist/mobile`, already part of `npm run build` and `npm run dev`), with `dist/mobile` shipping inside `app.asar` through the existing `dist/**/*` rule; a new `test:lan` script is wired into the manual `packaged-smoke.yml` (`Smoke read-only LAN desktop and mobile clients`). The real packaged smoke covers pairing, directories / search / tags, ranged text, native downloads, image decoding, the compact 390px list and two-column grid, the 768px three-column grid, stop invalidation, read-only metadata snapshots and animation-disabled screenshots with opacity assertions.

### Performance

- **首屏 JS 减少 45,789 B**:`AdvancedSearchDialog` 改为首次打开才加载,`advancedEverOpened` 让它在关闭后保持挂载以保留输入;`ExtensionViewPanel` 仅在扩展视图激活时加载。初始 JS 1,151,343 → 1,105,554 B(`main` 435,963 + vendor 669,591),`FileList` 视角与 ECharts / leaflet / @xyflow 的异步边界不变。
  **45,789 B less initial JS**: `AdvancedSearchDialog` now loads on first open and stays mounted afterwards through `advancedEverOpened`, preserving its input across close/reopen, while `ExtensionViewPanel` loads only when the extension view becomes active. Initial JS drops from 1,151,343 to 1,105,554 B (`main` 435,963 + vendor 669,591) without changing the FileList views' or the existing ECharts / leaflet / @xyflow async boundaries.

- **Excalidraw 入口 bundle 缩小 83%**:扩展构建改为 8 个独立 compiler,各自输出到 `dist/extensions/<extId>/`,并用 `dynamicImportMode: 'lazy'`、`chunkFilename: 'chunks/[id].[contenthash].js'` 与编译器内 `splitChunks: { chunks: 'async' }`;Excalidraw entry 7,777,059 → 1,314,536 B,132 个异步 chunk 合计 6,496,642 B,文件与运行时 URL 均位于 `excalidraw-editor/chunks/`。entry + chunk 合计 7,811,178 B,比拆分前单文件多 34,119 B(+0.4%),收益是首屏只加载入口与按需 chunk;没有跨扩展共享 chunk,CommonJS、CSP、扩展协议与 text-editor 均未改。
  **Excalidraw entry bundle 83% smaller**: eight independent extension compilers now emit into their own `dist/extensions/<extId>/` directories with `dynamicImportMode: 'lazy'`, `chunkFilename: 'chunks/[id].[contenthash].js'` and per-compiler `splitChunks: { chunks: 'async' }`. The Excalidraw entry drops from 7,777,059 to 1,314,536 B, and its 132 async chunks total 6,496,642 B; both files and runtime URLs live under `excalidraw-editor/chunks/`. Entry plus chunks total 7,811,178 B, 34,119 B (+0.4%) above the former single file; the gain is that first load fetches only the entry and the chunks it needs. No chunks are shared across extensions, and CommonJS, CSP, the extension protocol and text-editor are unchanged.

### Security

- **局域网访问的边界收紧**:桌面端服务只接受私网 / 回环 / 链路本地来源,且本机目的地址必须在启动时的网卡快照内;`Host` 必须是字面 IP 且端口等于实际监听端口(DNS rebinding 不成立),`Origin` 与 `Sec-Fetch-Site` 双向校验。`POST /api/session` 要求 `X-Whale-Request: read-only` 头,同一来源 60 秒内 5 次失败即 429 + `Retry-After`,成功才下发 `HttpOnly` + `SameSite=Strict` 的会话 cookie;token 只在主进程内存、用 `timingSafeEqual` 比较。`.html .htm .xhtml .xml .svg .svgz .js .mjs .cjs .pdf` 一律 `Content-Disposition: attachment`,每个响应带 CSP、`Cache-Control: no-store`、`Referrer-Policy: no-referrer` 与 `X-Content-Type-Options: nosniff`。数据面是明文 HTTP,不防嗅探,只应在可信局域网使用(安全边界见 docs/13 §14,已知取舍见 docs/09 §36)。
  **Tighter boundary for LAN access**: the desktop server accepts only private / loopback / link-local peers, and the local address must be in the startup interface snapshot; `Host` must be a literal IP whose port matches the listener (so DNS rebinding does not apply) while `Origin` and `Sec-Fetch-Site` are both validated. `POST /api/session` requires the `X-Whale-Request: read-only` header, rate-limits five failures per peer within 60 seconds with 429 + `Retry-After`, and only then issues an `HttpOnly` + `SameSite=Strict` session cookie; the token stays in main-process memory and is compared with `timingSafeEqual`. `.html .htm .xhtml .xml .svg .svgz .js .mjs .cjs .pdf` are always served as `Content-Disposition: attachment`, and every response carries CSP, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. The data plane is plain HTTP with no sniffing protection, so it belongs on a trusted LAN (see docs/13 §14 for the boundary and docs/09 §36 for the tradeoffs).

- **只读位置与批量读的边界补漏**:`removeSidecar` 以及目录缩略图 / 背景的设置与清除,现在与其余元数据写入一样拒绝只读位置(此前仍可改写只读位置内的 `.whale/`);`sidecar:readManyDetailed` / `sidecar:readForPathsDetailed` 补上位置边界:目录参数过 `assertWithinAllowedRoot`,路径列表逐个校验,任一路径在已配置位置之外整批拒绝。同时删除 7 个渲染层零调用的 preload API 及其 IPC handler(`homeDir`、`getExifSummary`、`markExifProcessed`、`readSidecars`、`readSidecarsForPaths`、`loadFolderBackground`、`backupRevision`),preload API 104 → 97。
  **Boundary gaps closed for read-only locations and batch reads**: `removeSidecar` and the folder thumbnail / background set and clear channels now refuse a read-only location like every other metadata write (they could still rewrite `.whale/` inside one), and `sidecar:readManyDetailed` / `sidecar:readForPathsDetailed` are fenced to configured locations: the directory argument goes through `assertWithinAllowedRoot`, every path in a batch is checked, and one out-of-bounds path rejects the whole batch. Seven preload APIs with no renderer caller were removed together with their IPC handlers (`homeDir`, `getExifSummary`, `markExifProcessed`, `readSidecars`, `readSidecarsForPaths`, `loadFolderBackground`, `backupRevision`), taking the bridge from 104 to 97 APIs.

### Fixed

- **移动端目录栈、搜索范围与会话恢复**：子目录面包屑改由完整目录栈驱动，深层返回和中间层级跳转不再丢名称或父级；在子目录激活搜索 / 标签过滤会明确切到整个位置查询，清除后回根目录。已建立会话的 list / search / tags / text / roots 遇到 `401` 统一清理并回配对页提示重新配对；roots 与目录 loading 分离，错误用消息键保存，切换语言不再重取数据。预览错误不再反射底层异常，关闭未完成的文本预览会复位 loading，文件按钮改为合法的 phrasing 内容，标签组补 group 语义，DOCX 等扩展徽章不再截断，英文单条目计数使用 `1 item`。
  **Mobile directory stack, search scope and session recovery**: breadcrumbs now use a complete directory stack, so deep Back and intermediate-level navigation retain names and parents. Activating search or a tag inside a folder explicitly switches to a whole-location query, and clearing filters returns to the root. Established list / search / tags / text / roots requests now consistently clear local state and return to pairing with a session-expired notice on `401`. Roots and directory loading are independent, errors are stored as message keys, and language changes no longer refetch data. Preview failures no longer reflect raw exceptions, closing a pending text preview resets loading, file buttons use valid phrasing content, tag filters expose group semantics, DOCX-style extension badges are no longer truncated, and English uses `1 item` for a single result.

- **属性托盘不再被目录刷新冲掉输入**:在描述框里打字、或重命名框还开着时,任何一次保存触发的目录刷新都会重置编辑缓冲——描述被回填成旧值、重命名框被关掉。现在编辑缓冲只跟随「当前选中的条目」:同一条目刷新时,正在编辑的字段保持不动;选中换成另一个条目时才重置。
  **The properties tray keeps your input across a directory refresh**: typing in the description field, or leaving the rename box open, used to be clobbered whenever a save triggered a directory refresh — the description snapped back to the stored value and the rename box closed. Edit buffers now follow the selected entry: a refresh of the same entry leaves the field being edited alone, and the buffers reset only when the selection moves to another entry.

- **Gantt 筛选的中性态与持久化**:筛选是否「收窄」改按「已知值全部选中」判断;以前用集合大小比较,删掉某个阶段 / 象限后残留的旧值会让无标签行永久隐藏、Reset 提示常驻。工作流与象限两个筛选共用同一个偏好键,现在写入前先合并另一维度已存的值,不再互相抹掉。
  **Gantt filter neutral state and persistence**: a filter now counts as neutral when every known value is selected. The old set-size comparison let a stale value from a deleted stage or quadrant hide untagged rows for good and keep the Reset hint on screen; and because the workflow and quadrant filters share one preference key, each write now merges the other dimension's stored selection instead of wiping it.

- **Knowledge Graph 拖拽只记住被拖动的节点**:拖动结束后只持久化被拖动的那几个节点的坐标,其余节点继续跟随自动布局;以前拖一次会把全图坐标写进 localStorage,之后布局变化对其余节点不再生效。
  **Knowledge Graph drags persist only the dragged nodes**: when a drag ends, only the moved nodes store their coordinates and the rest keep following the automatic layout; previously one drag wrote every node position to localStorage, so later layout changes no longer reached the other nodes.

- **只读位置上的操作反馈**:只读位置打开 Map 视角时不再为每张照片弹「只读」提示(懒提取 GPS 直接跳过,手动放置标记照常);往只读位置拖放标签或文件改为提示原因,不再静默无效。
  **Feedback on read-only locations**: opening the Map view in a read-only location no longer raises one read-only notice per photo (lazy GPS extraction is skipped; placing markers by hand still works), and dropping tags or files onto a read-only location now explains why instead of silently doing nothing.

- **带标签新建时标签写失败**:条目已创建但标签写盘失败时,列表照常刷新并提示「条目已创建,但写入标签失败」;以前条目建好了却不刷新,重试会撞上「已存在」。
  **Tag write failure after creating a tagged entry**: when the entry is created but its tag cannot be written, the list still refreshes and a notice says the entry exists but its tag failed; previously the new entry stayed out of the list until a manual refresh and a retry hit an already-exists error.

- **扩展页签按最近使用淘汰**:打开第 9 个页签时,淘汰的是除新页签与未保存页签之外最久未激活的那个;以前实际按打开顺序淘汰,时间戳并列时偏向更早打开的页签。
  **Extension tabs evict by least recent use**: opening a ninth tab now closes the least recently activated tab other than the new one and unsaved tabs; eviction previously followed opening order, with timestamp ties favouring the earlier-opened tab.

- **MCP 设置落盘失败不再残留内存状态**:`setMcpEnabled` / `setMcpReadOnly` / `regenerateMcpToken` 写盘失败时把缓存改回原值并照常抛错,状态读取与磁盘保持一致。
  **Failed MCP config writes no longer leave stale in-memory state**: `setMcpEnabled`, `setMcpReadOnly` and `regenerateMcpToken` restore the previous cached value when the disk write fails and still surface the error, so status reads keep matching the config on disk.

- **图片导出失败文案本地化**:视角图片捕获失败时抛出的错误改为本地化的 `imageExportCaptureFailed`(五种语言),不再是由 FolderViz、Knowledge Graph、Map 与标签云视图原样显示的英文硬编码。
  **Localized image-export failure**: the error thrown when a perspective image cannot be captured is now the localized `imageExportCaptureFailed` (all five locales) instead of a hard-coded English string shown as-is by the FolderViz, Knowledge Graph, Map and Tag Cloud views.

- **Excalidraw 初始场景与恢复失败不再覆盖源文件**:Excalidraw 0.18.1 的命令式 API 可能早于异步 `initializeScene` 暴露,首份 `fileContent` 直接 `updateScene` 会被随后初始化的空场景覆盖。现在首份内容 resolve 进一次性 `initialData` Promise,后续刷新才走 `applyScene`;非空 JSON 先验证 `type==='excalidraw'` 与 elements 形状,拒绝上游 total restore 对 `{}`、library export 等输入的 fail-open。恢复失败会报 fatal error 并重新抛出,扩展与宿主均禁止 Save,关闭保存立即失败,宿主提供 Retry;重试清旧 revision/自写回读快照,成功恢复强制 dirty=false 对账。
  **Excalidraw initialization and restore failures cannot overwrite source files**: Excalidraw 0.18.1 can expose its imperative API before the asynchronous `initializeScene` finishes, so an early `updateScene` was overwritten by the empty initialized scene. The first payload now resolves a one-shot `initialData` promise and later refreshes use `applyScene`; non-empty JSON must have `type==='excalidraw'` and a valid elements shape, closing the upstream total-restore fail-open for `{}`, library exports and similar input. Restore failures raise a fatal error and rethrow, disable Save in both layers, fail close-save immediately and expose Retry; retry clears stale revision/write-readback state and successful recovery forces a dirty=false reconciliation.

- **保存后不再被自己的 fs.watch 回读重载**:ExtensionHost 记录最近一次成功写盘的内容,`fs.watch` 回读与之逐字相同时跳过 `fileContent`,不再在保存后重建编辑器(例如关掉刚插入的 Mermaid 预览);不同内容的外部修改仍刷新并作废旧自写快照,避免 B→C→B 吞掉最后一次外部修改,切换文件/重试时清空记录与旧 revision。
  **Saves no longer reload through their own fs.watch readback**: ExtensionHost remembers the content of its last successful write and skips a `fileContent` whose readback is identical, so saving no longer rebuilds the editor (for example closing a just-inserted Mermaid preview); genuinely different external edits still refresh and invalidate the old self-write snapshot, so B→C→B cannot swallow the final external B; both the record and old revision are also cleared on file switch or retry.

- **脏标签状态全部按 tabId 读取**:关闭确认、保存后复查、fs.watch 外部刷新与 flush 统一使用 `isTabDirty(editState, tabId)`;LRU 淘汰也按 `dirtyTabIds` 保护对应标签,不再因残留 filePath 查询而跳过脏标签确认、覆盖未保存编辑或静默驱逐 dirty 标签。
  **Dirty-tab state consistently uses tabId**: close confirmation, post-save checks, fs.watch refreshes and flush now all read through `isTabDirty(editState, tabId)`, and LRU eviction protects the matching entries in `dirtyTabIds`. Stale filePath lookups can no longer bypass dirty-close confirmation, overwrite unsaved edits or silently evict a dirty tab.

- **懒加载失败可恢复**:`AdvancedSearchDialog` / `ExtensionViewPanel` 的 chunk 被拒后,ErrorBoundary 用 `resetKey` 清错并重建 lazy;高级搜索保留重试入口,扩展页保留 `ExtensionTabBar` 可切 tab/关闭,扩展页的 Suspense fallback 改为不透明背景。正常 tab 切换仍复用同一 lazy,不重挂 iframe。
  **Lazy-load failures recover**: when an `AdvancedSearchDialog` / `ExtensionViewPanel` chunk is rejected, ErrorBoundary clears the error through `resetKey` and rebuilds the lazy component; advanced search keeps a retry action, the extension view keeps `ExtensionTabBar` for switching/closing tabs, and the Suspense fallback is now opaque. Normal tab switches still reuse the same lazy component without remounting the iframe.

- **MUI 测试告警**:`CalendarView` / `EntryContextMenu` 测试改为在 `globalJsdom()` 之后动态加载 MUI 依赖链,避免 Emotion 在无 `document` 时选到 SSR 包装而产生 Tooltip / Menu ref 与 Grow 告警,并新增 ref 告警必须为空的断言;生产组件未改。
  **MUI test warnings**: the `CalendarView` / `EntryContextMenu` tests now load their MUI dependency chain dynamically after `globalJsdom()`, so Emotion no longer selects SSR wrappers when no `document` exists and the Tooltip / Menu ref and Grow warnings disappear. New assertions require the ref warnings to stay empty; production components are untouched.

- **主题健壮性**:持久化的 `themeMode` 不再被直接当索引使用 —— 新增 `isThemeMode` 只认 11 个自身键(`__proto__` / `constructor` 之类不算合法),损坏、缺失或已删除的未来模式在 `useResolvedTheme` 回退到 `{ mode: 'light', presetId: 'whale' }`、在 `migrateAppearance` 归一成 `light`,且只在非法时才分配新对象。
  **Theme robustness**: persisted `themeMode` values are no longer used as direct indexes. A new `isThemeMode` guard accepts only the eleven own keys (`__proto__` / `constructor` and friends are rejected), so corrupt, missing or removed future modes fall back to `{ mode: 'light', presetId: 'whale' }` in `useResolvedTheme` and normalize to `light` in `migrateAppearance`, which allocates only when the value is actually invalid.

- **配色对比度达到 WCAG AA**:13 套预设的浅色主色与次要文字按"刚好达标"压暗(如 whale `#0ea5e9` → `#0a7bae`),`primary` 与 `textSecondary` 对 `backgroundDefault` / `backgroundPaper` 均 ≥ 4.5:1,全局 focus outline 取 `primary` 且 ≥ 3:1;`presets.test.ts` 逐预设 × 明暗变体断言。
  **Color contrast now meets WCAG AA**: light-side primaries and secondary text across all 13 presets are darkened just enough to pass (whale `#0ea5e9` → `#0a7bae`), keeping `primary` and `textSecondary` ≥ 4.5:1 against both `backgroundDefault` and `backgroundPaper` while the global focus outline uses `primary` at ≥ 3:1. `presets.test.ts` asserts every preset in both variants.

- **快捷主题切换回经典模式时重置预设**:从策划主题循环回 light / dark / system 会显式把 `themePreset` 重置为 `whale`,不再残留上一个策划预设。
  **Quick theme toggle resets the preset**: cycling back into light / dark / system now explicitly resets `themePreset` to `whale` instead of leaving the previous curated preset behind.

- **输入法组合期误提交**:新增 `isImeComposing`(`isComposing` 或 `keyCode 229`)守卫并接入 7 处 Enter 语义(行内重命名、属性托盘重命名与描述 `Ctrl+Enter`、标签输入、PromptDialog、添加位置、搜索框、工作流管理器),候选框里的回车与空格不再被当成提交。
  **IME composition no longer submits**: a new `isImeComposing` guard (`isComposing` or `keyCode 229`) covers all seven Enter semantics — inline rename, tray rename and description `Ctrl+Enter`, tag input, PromptDialog, add-location, search and the workflow manager — so confirming a candidate with Enter or Space is no longer treated as a commit.

- **设置页误导读屏的静态 "Enabled"**:两个通用开关不再渲染恒显的 "Enabled" 文案,状态由 `checked` 表达;快捷键搜索框补了 `aria-label` 与随主题变化的 `:focus-visible` 焦点环(2 px `primary` + 2 px offset),替代硬编码 rgba 边框与 `outline: none`。
  **Removed the misleading static "Enabled" text**: the two general switches no longer render a permanently visible "Enabled" label — the checked state carries that meaning — and the shortcut search field gained an `aria-label` plus a theme-aware `:focus-visible` ring (2 px `primary`, 2 px offset) replacing its hard-coded rgba border and `outline: none`.

- **静默失败**:属性托盘重命名失败除全局通知外也回落到本地 notice(失败后输入框回滚成原文件名),侧栏的新建 Excalidraw / Draw.io 与"在文件管理器中显示"改走应用级通知,不再 `.catch(() => undefined)`。
  **Silent failures surfaced**: a failed tray rename now also reaches the local notice (the input rolls back to the original name) on top of the global notification, and the sidebar's new-Excalidraw / new-Draw.io plus reveal-in-file-manager paths report through the app-level notice instead of swallowing errors with `.catch(() => undefined)`.

- **语言与本地化日期**:`document.documentElement.lang` 跟随语言设置;绝对日期与版本历史时间戳显式传 `i18n.language`,不再跟随 OS 区域。
  **Language tag and localized dates**: `document.documentElement.lang` now follows the language setting, and absolute dates plus revision-history timestamps pass `i18n.language` explicitly instead of following the OS locale.

## [0.5.1] - 2026-11-19

### Added

- **发布质量门禁**:新增 Windows CI 执行 lint、strict type-check 与全量 Electron 测试；手动 packaged-smoke workflow 构建 fresh unpacked 包,以隔离 userData 启动真实应用并验证主进程健康、持久化隔离和 utilityProcess 全文 build/search/has/shutdown。真实 GUI 冒烟另经 Add Location 页面流程验证 known-roots、Copy Path 剪贴板、Image Viewer fullscreen、Text Editor Ctrl+S 落盘,以及后台脏标签取消关闭后的焦点恢复与保留。Draw.io 冒烟覆盖真实 webapp 初始化、fixture 渲染、label 编辑、宿主 Save 与磁盘读回。Excalidraw 冒烟进一步以 canvas 实际像素、绑定文本编辑、元素 version/mtime 和两次磁盘读回验证保存，并覆盖 Mermaid 最小 flowchart 的 lazy preview、原生 Insert、A/B 节点与连线落盘。扩展 manifest 的 `MANIFEST_INJECTED_BY_BUILD` 占位符未命中时构建直接失败,不再静默产出无样式 bundle。
  **Release quality gates**: added Windows CI for lint, strict type-check and the full Electron test suite; a manual packaged-smoke workflow builds a fresh unpacked app, launches it with isolated userData and verifies main-process health, persistence isolation and real utilityProcess full-text build/search/has/shutdown. A real GUI smoke also drives the Add Location page flow and verifies known-roots, Copy Path clipboard writes, Image Viewer fullscreen, Text Editor Ctrl+S persistence, and restoration/retention after cancelling a background dirty-tab close. The Draw.io smoke covers real webapp initialization, fixture rendering, label editing, the host Save control and disk read-back. The Excalidraw smoke additionally verifies saving through actual canvas pixels, bound-text editing, element version/mtime and two disk read-backs, and covers a minimal Mermaid flowchart through lazy preview, native Insert, and persisted A/B nodes plus an edge. Extension builds now fail when the `MANIFEST_INJECTED_BY_BUILD` manifest placeholder is not consumed instead of silently shipping an unstyled bundle.

- **隔离性能基准**:新增可复现的全文 cold/no-op/1% 增量/查询与目录缩略图 cold/warm/同目录 burst 基准,另附全文读取阶段和真实 SQLite 事务批次对照；所有样本均来自临时 fixture,校验命中、陈旧清理、JPEG 产物与统计中位数,不扫描个人目录。缩略图测量前排空应用索引并断言产物不存在,内存字段标明 phase 后采样与共享 worker peak,清理失败单独报错。核心断言已有隔离测试,阶段探针验证 synthetic 分支真实执行,事务探针验证全部 1000 行写入；全文基准严格拒绝未知参数/缺值，报告带 generatedAt/completedAt，失败时用 --output 覆盖旧成功报告；批次对照未显示足以扩大生产内存边界的稳定收益。
  **Isolated performance benchmarks**: added reproducible full-text cold/no-op/1%-incremental/query and folder-thumbnail cold/warm/same-directory-burst benchmarks, plus extraction-phase and real SQLite transaction-batch controls. Every sample uses temporary fixtures with hit, stale-removal, JPEG and median-statistics validation, never personal directories. Thumbnail timing now drains application indexing and asserts absent artifacts first, labels memory as post-phase resident/shared-worker peak, and reports cleanup failures separately. Core assertions have isolated tests; the phase probe proves the synthetic branch runs, and the transaction probe verifies all 1000 rows. Full-text benchmarks reject unknown or missing arguments, timestamp reports with generatedAt/completedAt, and overwrite stale success reports on failure when --output is supplied. Batch controls showed no stable benefit that would justify larger production memory buffers.

### Changed

- **安装包瘦身 28.5%**:electron-builder 此前把根 `package.json` 的整棵生产依赖树打进 `app.asar`(约 500MB,其中 echarts / @mui / @excalidraw / codemirror 等 ~150-200MB 与 webpack bundle 重复,mermaid 链 ~110MB 只服务一个懒加载功能);`resources/builder.json` 的 `files` 改为显式白名单——只保留 `dist/**` 与运行时真正 require 的原生/外部包(pdfjs-dist、sharp、better-sqlite3 及其 bindings、ffmpeg-static、@napi-rs、exifr、jschardet、iconv-lite、ajv 链)。安装包 265.2MB → 189.7MB,`app.asar` 496.8MB/59,928 文件 → 164.4MB/5,725 文件;功能零变化(渲染层与扩展 bundle 本就不读这些 node_modules)。
  **Installer slimmed by 28.5%**: electron-builder used to pack the root `package.json`'s entire production dependency tree into `app.asar` (~500MB, of which echarts / @mui / @excalidraw / codemirror etc. totalled ~150-200MB duplicating the webpack bundles, and a ~110MB mermaid chain served one lazy feature). `resources/builder.json` now uses an explicit `files` whitelist — `dist/**` plus only the native/external packages actually required at runtime (pdfjs-dist, sharp, better-sqlite3 with its bindings, ffmpeg-static, @napi-rs, exifr, jschardet, iconv-lite, the ajv chain). Installer 265.2MB → 189.7MB and `app.asar` 496.8MB/59,928 files → 164.4MB/5,725 files, with zero functional change (the renderer and extension bundles never read those node_modules).

- **ECharts 依赖兼容**:对齐 `echarts@^5.6.0` 与 `echarts-wordcloud@2.1.0` 声明的 `^5.0.1` peer,消除 `npm ls echarts --all` 的 invalid 树和 electron-builder collector 警告；应用、React 适配器与词云继续共享同一个 ECharts 实例。
  **ECharts dependency compatibility**: aligned `echarts@^5.6.0` with the `^5.0.1` peer declared by `echarts-wordcloud@2.1.0`, eliminating the invalid tree reported by `npm ls echarts --all` and the electron-builder collector warning; the app, React adapter and word cloud continue to share one ECharts instance.

- **依赖安全补丁**:升级 `electron@42.11.18`、`electron-builder@26.18.0`、`concurrently@9.2.5`、`rimraf@6.1.4` 与 `webpack-dev-server@5.2.7`,再应用非破坏性传递补丁；随后只对三条 chevrotain 依赖边声明经隔离 `npm ci` 验证的 lodash-es 4.18.1 override，npm 析取后由 chevrotain-allstar 与 Mermaid 的 dagre-d3-es 一并共享，这些实际消费者均纳入导入检查；Excalidraw 直接 nanoid 使用 3.3.20，Mermaid 转换器显式保持 nanoid 4.0.2 作为 major 护栏。完整 npm audit 从 49 项(3 critical)降为 27、再降为 21 项(0 critical)，运行时节点从 20 降为 12、再降为 6(1 high / 3 moderate / 2 low)。未用 `--force`、跨 major 降级或 blanket override；剩余 mte nanoid、KaTeX 与 ECharts 5 的可达性和兼容约束已记录，ECharts 用户名称 tooltip 继续统一 HTML 转义。
  **Dependency security patches**: upgraded `electron@42.11.18`, `electron-builder@26.18.0`, `concurrently@9.2.5`, `rimraf@6.1.4` and `webpack-dev-server@5.2.7`, then applied non-breaking transitive patches. Narrow lodash-es 4.18.1 overrides, validated by an isolated `npm ci`, are declared only on three chevrotain dependency edges; npm hoisting also shares that version with chevrotain-allstar and Mermaid's dagre-d3-es, and all of these actual consumers were included in import checks. Excalidraw's direct nanoid is pinned to 3.3.20, while the Mermaid converter explicitly retains nanoid 4.0.2 as a major-version guard. The full npm audit dropped from 49 findings (3 critical) to 27 and then 21 (0 critical), while runtime-scoped nodes fell from 20 to 12 and then 6 (1 high / 3 moderate / 2 low). No `--force`, cross-major downgrade or blanket override was used; residual mte nanoid, KaTeX and ECharts 5 advisories retain documented reachability/compatibility constraints, and user names in ECharts HTML tooltips remain uniformly escaped.

- **无引用构建依赖清理**:移除没有任何源码或构建脚本引用的 `png-to-ico` 与 `png2icns`,连同传递依赖共减少 10 个安装包；Windows 继续使用现成 `resources/icon.ico`,mac `.icns` 生成仍是独立事项。
  **Unused build dependency cleanup**: removed `png-to-ico` and `png2icns`, which had no source or build-script references, eliminating 10 installed packages including their transitive entries. Windows continues to use the existing `resources/icon.ico`; generating a mac `.icns` remains a separate task.

- **Draw.io 离线资源收敛**:只剔除 vendor node_modules、source map、未使用的独立 viewer bundle 和孤儿 workbox，保留 OPEN_FORM 的 open.html；复制后的 index 与 PreConfig 将 HTML viewer/lightbox/base 固定到随包 viewer-static，不再回退公网 CDN，并仅为 Draw.io assets 根目录开放受控 Lightbox index 映射。合计减少 138 个文件 / 3,050,820 bytes，构建后的离线配置、viewer 与 Lightbox 文档可服务性由真实包冒烟验证；上游缺少 embed-static/embed.js 的 HTML-embed 缺口不纳入完成声明。
  **Smaller offline Draw.io payload**: removes only vendor node_modules, source maps, an unused standalone viewer bundle and an orphan workbox while preserving open.html for OPEN_FORM. The copied index and PreConfig now pin HTML-viewer/lightbox/base URLs to the packaged viewer-static instead of falling back to public CDNs, with a scoped index mapping only for the Draw.io assets root used by Lightbox. This removes 138 files / 3,050,820 bytes in total, with offline configuration plus viewer and Lightbox document availability covered by the real packaged smoke; the upstream HTML-embed gap caused by missing embed-static/embed.js is explicitly not claimed as fixed.

- **全文索引资源边界**:首建每 100 条执行事务性 delete+insert,不再把全部正文驻留内存；失败保留已提交批次,下轮按旧 mtime 恢复,removed 只在完整遍历与末批成功后删除。PDF 解析加全局 2 路并发上限,大文件用精确 Uint8Array 视图避免第二次全量复制,10 秒超时后停止后续页循环；异常路径的 loadingTask.destroy() 最多等待 1 秒,销毁卡死也不会永久占住许可。索引构建的非 PDF 实际提取再经 worker 级 8 路信号量,嵌套目录不再叠乘并发；PDF 不占非 PDF 许可,只走原有 2 路专用闸门,避免 PDF 队列饿死文本,直接 MCP 提取语义不变。
  **Full-text indexing resource bounds**: initial builds now commit transactional delete+insert batches of 100 entries instead of retaining every extracted body; completed batches survive a failure and the next prior-mtime walk resumes safely, while removals are deferred until the full walk and final flush succeed. PDF parsing has a global two-job semaphore and uses an exact Uint8Array view instead of a second full-size copy; the 10-second watchdog stops the page loop, and abnormal loading-task destruction waits at most one second so a stuck destroy cannot permanently retain a permit. Non-PDF build extraction also passes through a worker-wide eight-job semaphore so nested directories no longer multiply concurrency; PDFs use only their existing two-job lane instead of occupying non-PDF permits while queued, and direct MCP extraction semantics remain unchanged.

- **ZIP 与目录背景资源边界**:PowerShell、POSIX zip 和 python3 fallback 统一 120 秒超时、SIGKILL 与 1 MiB 输出上限；OS 工具先写唯一 staging ZIP,成功后原子改名,失败清理半成品,超时/输出上限错误不再回显完整 argv。目录背景的 sharp 编码纳入现有 4 路缩略图信号量,失败后正常释放许可；同目录缩略图/背景的并发加载按目标路径合并,成功或失败都清除在飞行记录,不引入陈旧持久缓存。
  **ZIP and folder-background resource bounds**: PowerShell, POSIX zip and the python3 fallback now share a 120-second timeout, SIGKILL and a 1 MiB output cap. The OS tool writes a unique staging ZIP that is atomically renamed only on success, partial archives are cleaned on failure, and timeout/output-limit errors no longer echo the full argv. Folder-background sharp encoding now uses the existing four-job thumbnail semaphore and releases its permit on errors. Concurrent loads of the same folder thumbnail/background are coalesced by target path, with in-flight entries cleared on both success and failure rather than retained as a stale persistent cache.

- **批量 IO 与媒体列表**:批量移动/删除改为 K 次 IO 加一次目录列表刷新,目录树也仅对实际成功项的源目录与移动目标目录去重刷新；成功、部分失败与全部失败聚合提示,部分失败使用单条 `partialFailure` 翻译模板,批量删除通过 `trashedItems` / `deletedItems` 带真实成功数量；错误通知最多显示前三条并汇总剩余数量,完整错误数组输出到控制台,失败项保留选择；目录树刷新依赖为必填,不再由 FileList 用 no-op 静默降级；非法的目录子孙移动逐项报错,不再静默跳过。Gallery 多目标打标统一 saveMany，等待所有写入 settle 后一次刷新，部分失败也报告真实成功数并保留完整错误；Lightbox memoize playlist,胶片条限制为 41 个 cell 且保留远程翻页与点击定位。
  **Batch IO and media lists**: bulk move/delete now performs K IO operations followed by one directory-listing refresh, with tree refreshes deduplicated across only successful source parents and the move destination; success/partial/total failure notices are aggregated through a single translated partial-failure template, bulk deletion reports the actual successful count, at most three errors are shown with the remaining count summarized, the complete error array is logged, and failed items stay selected. The directory-tree refresh dependency is required rather than silently replaced by a FileList no-op. Invalid moves into a folder's own descendant are reported per item instead of silently skipped. Gallery multi-target tagging uses one saveMany operation, waits for every write to settle before one refresh, and reports the actual success count with complete errors on partial failure, while Lightbox memoizes its playlist and bounds the filmstrip to 41 cells without losing remote paging or click-to-navigate.

### Fixed

- **多选拖拽与编辑器保存竞态**:文件拖拽在 drag-start 读取当前选择,不再使用原地修改 Set 的旧 memo；text、drawio 与 Excalidraw 按内容 revision 确认写盘,旧回执不会清掉保存期间的新编辑。只读切换不再重灌旧 fileContent,drawio 只读真正禁止输入,Excalidraw 按实际写盘快照推进 dirty 基线。
  **Multi-selection dragging and editor save races**: file dragging now reads the current selection at drag-start instead of a memo holding an old, mutated Set; text, drawio and Excalidraw acknowledge writes by content revision so stale acknowledgements cannot clear newer edits. Read-only toggles no longer reload stale fileContent, drawio read-only actually blocks input, and Excalidraw advances its dirty baseline to the snapshot that was really written.

- **多标签与 Lightbox 清理**:取消关闭后台脏标签后恢复此前的活动标签并保留目标；保存失败或只读无法写入时恢复焦点并明确提示修改仍在标签中。位置只读状态只同步同 location 的标签,其他后台位置不被误改；重载优先精确路径,只有大小写/分隔符归一化后唯一匹配才回退,避免误写大小写敏感文件。缩放拖拽的 window 监听在 mouseup、Esc、切换媒体及 unmount 时幂等清理。
  **Multi-tab and Lightbox cleanup**: cancelling a background dirty-tab close restores the previously active tab while keeping the target open; failed or read-only saves also restore focus and explicitly report that changes remain in the tab. Location read-only changes only update tabs from that location, and reloads prefer exact paths, falling back to normalized case/separator matching only for one unambiguous tab so case-distinct files cannot be confused. Zoom-pan window listeners are idempotently removed on mouseup, Escape, media changes and unmount.

- **watcher 溢出、权限与崩溃日志边界**:fs.watch 的未知文件名标记 `['']` 现在保守重建 location 下全部全文根,不再长期保留陈旧索引；权限从一律拒绝改为主界面/json-viewer 剪贴板写和 image-viewer fullscreen 的精确白名单,其余继续 fail-closed；主进程崩溃堆栈同样脱敏并覆盖 Windows 正反斜杠 home 路径,POSIX crash.log 在写入前对已打开 fd 执行 0600 fchmod,并按 UTF-8 字节在 1 MiB 阈值前轮换为单份 crash.log.1,轮换失败会脱敏告警且不丢当前记录；MCP 配置原子写的权限强化失败会上抛且不替换原文件。
  **Watcher overflow, permissions and crash-log boundaries**: the unknown-filename fs.watch marker `['']` now conservatively rebuilds every full-text root in the location instead of leaving stale search data; blanket permission denial became a precise allowlist for main/json-viewer clipboard writes and image-viewer fullscreen while everything else remains fail-closed; main-process crash stacks are sanitized with both native and slash-normalized home paths, and POSIX crash.log is fchmod'd to 0600 on the open descriptor before any bytes are appended, rotates by UTF-8 bytes at the 1 MiB threshold into one crash.log.1 backup, and warns with sanitized details without dropping the current record if rotation fails. Atomic MCP config writes now propagate permission-hardening failures without replacing the original file.

- **打包版启动即崩(0.5.0 存量缺陷)**:`mcp-tools.ts` 值导入 `fulltext.ts`(连带 `index-db.ts`),而后者的守卫在主进程 production 下直接抛 "must be required from the index utilityProcess worker";webpack 把整条链打进 `dist/main/main.js`,导致**打包版一启动就弹 "A JavaScript error occurred in the main process" 对话框**——0.5.0 安装包全部中招,dev 与测试因 `NODE_ENV≠production` 全绿而漏网。修复:`whale_extract_text` 改经 index worker 新增的 `fulltext:extract` RPC op(与其余 fulltext 工具同路,pdfjs 解析不占主进程);PDF 上限常量抽到无依赖的 `fulltext-limits.ts` 供 mcp 预检与 worker 共享;`mcp-http.test.ts` 的 `utilityProcess.fork` stub 升级为进程内假 worker,把这条链纳入端到端覆盖。
  **Packaged builds crashed on launch (a 0.5.0 defect)**: `mcp-tools.ts` value-imported `fulltext.ts` (pulling in `index-db.ts`), whose guard throws "must be required from the index utilityProcess worker" in the main process under production; webpack inlined the whole chain into `dist/main/main.js`, so **every packaged 0.5.0 install showed an "A JavaScript error occurred in the main process" dialog at startup** — dev and tests stayed green only because the guard checks `NODE_ENV`. `whale_extract_text` now goes through a new `fulltext:extract` RPC op on the index worker (the same route as the other fulltext tools, keeping pdfjs parsing off the main process); the PDF size cap moved into a dependency-free `fulltext-limits.ts` shared by the MCP precheck and the worker; and the `utilityProcess.fork` stub in `mcp-http.test.ts` became an in-process fake worker so this chain is covered end-to-end.

- **MCP 传输、配置与生命周期加固**:`/mcp` 端点改为精确匹配(前缀路径 404),未知/过期会话返回 404 让客户端重新 initialize;请求体按 UTF-8 字节数限 4 MiB,超限回 413 并在响应后 drain(不再中途断 socket);会话带 `lastSeen` 与 unref 的 idle sweeper,默认闲置 30 分钟回收;监听成功后才发布内部状态,绑定失败不再泄漏 core;停止服务时在同一 Promise 内 `closeAllConnections()`,keep-alive 客户端不能再吊住设置开关或退出。`mcp-config.json` 的非对象 JSON(此前会在 bootstrap 抛 TypeError)、越界端口与坏 token 统一归一化并带日志回退,写入串行化。新增 `mcp-config` / `mcp-server` 回归测试并把 `mcp-http` 扩到 27 用例。
  **MCP transport, config and lifecycle hardening**: the `/mcp` endpoint is now matched exactly (prefix paths 404) and unknown/expired sessions answer 404 so the client re-initializes; request bodies are capped at 4 MiB of UTF-8 bytes with a clean 413 and a post-response drain instead of a mid-request socket destroy; sessions carry `lastSeen` plus an unref'd idle sweeper that reaps them after 30 minutes by default; internal state is published only after a successful bind (a failed bind no longer leaks a core), and stopping the server calls `closeAllConnections()` in the same promise so keep-alive clients can no longer hang the settings toggle or app quit. A `mcp-config.json` holding valid non-object JSON (previously a bootstrap TypeError), out-of-range ports and malformed tokens are normalized and fall back with a log, and writes are serialized. Added `mcp-config` / `mcp-server` regression tests and grew `mcp-http` to 27 cases.

- **自动更新并发与退出安全**:`downloadUpdate()` 共享同一个 in-flight Promise,双击不再把 electron-updater 的 "download already in progress" 冒成错误提示(失败后仍可重试);`quitAndInstall()` 加 try/catch——下载未完成时该调用会同步抛,未捕获将逃出 IPC listener(主进程没有 `uncaughtException` 兜底)。新增 `auto-update.test.ts`(18 用例)覆盖 feed 接线、release notes 归一、并发 check/download 去重、事件隔离、dev-mode 短路与启动探测。
  **Auto-update concurrency and shutdown safety**: `downloadUpdate()` shares one in-flight promise, so a double-click no longer surfaces electron-updater's "download already in progress" as an error toast (retry after a failure still works), and `quitAndInstall()` is wrapped in try/catch — asking to install before a download finishes throws synchronously and would otherwise escape the IPC listener (the main process has no `uncaughtException` handler). Added `auto-update.test.ts` (18 cases) covering feed wiring, release-note normalization, concurrent check/download dedupe, event isolation, the dev-mode short-circuit and the startup probe.

- **MCP 工具面守卫与并发写原子性**:修复 move/copy 的跨调用竞态——「目标不存在」检查与写入现在按目标目录加锁串行,`cp` 改用 `force:false + errorOnExist`(否则并发抢同一目标名时落败者被静默替换,与"Never overwrites"矛盾);配置的位置 root 本身不再允许打标 / 写描述 / move / copy / delete(`assertNotLocationRoot`),杜绝 `.whale/` 落到边界上一层目录、以及整根被一次泛化审批删除;`whale_build_fulltext` 纳入只读模式,审批等待返回后再查一次只读,切换只读为开会立即拒绝未决审批;`whale_read_text` 先 `stat()` 并拒绝 >16 MiB 的非文件 / 超大文件(避免整文件读入打爆主进程);批量工具整批失败时标 `isError`,`whale_roots` 不再把索引 worker 失败伪装成空位置,`whale_create_text_file` 的 `bytes` 改按 UTF-8 字节计。新增真实 root 上的端到端守卫测试、`isConfiguredRoot` 归一化测试与并发 copy/move 回归测试。
  **MCP tool-surface guards and atomic concurrent writes**: fixed a cross-call race in move/copy — the "destination does not exist" check and the write now run under a per-destination-directory lock, and `cp` uses `force:false` plus `errorOnExist` (without it, two parallel calls racing for the same destination name silently replaced the loser, contradicting "Never overwrites"); a configured location root itself can no longer be tagged, described, moved, copied or deleted (`assertNotLocationRoot`), which previously let `.whale/` land one directory above the boundary and let one generic approval trash an entire location; `whale_build_fulltext` now respects read-only mode, approval re-checks read-only after the wait, and switching read-only on denies pending approvals immediately; `whale_read_text` stats first and refuses non-files or files above 16 MiB instead of loading the whole file into memory; batch tools mark `isError` when every item failed, `whale_roots` no longer disguises an index-worker failure as an empty location, and `whale_create_text_file` reports UTF-8 byte counts. Added end-to-end guard tests against a real configured root, `isConfiguredRoot` normalization tests and concurrent copy/move regression tests.

- **读-改-写不再把「读失败」当空**:`wsm.json` / `wtaglib.json` 的单字段写入改为经 `merge-read.ts` 取合并基底——文件损坏或外形不符时先隔离为 `<name>.corrupt-<时间戳>`(字节原样保留、告警)再从空开始,非 ENOENT 的 IO 错误直接上抛;此前一次改颜色会抹掉该目录全部标签/描述,一次改标签描述会丢掉其余所有 tag 描述。legacy sidecar 迁移只删除确实解析成功的文件,坏文件重命名为 `<name>.json.corrupt-<时间戳>` 永久保留(重命名失败则原地保留);redux-persist 的 purge 只把 ENOENT 当正常,其余删除失败重新抛出,不再"假成功 → 下次启动复活";目录/全文索引重建失败会置 dirty 并按 1.5s 起、上限 60s 的退避自动重试,空闲目录不再永久陈旧。新增 `merge-read` / `tag-library` / `persist-storage` 测试并补 `folder-meta` / `sidecar` / `dir-watcher` 回归用例;MCP 配置落盘失败改为向 IPC 调用方上抛。
  **Read-modify-write no longer treats a failed read as empty**: single-field writes to `wsm.json` / `wtaglib.json` now take their merge base from `merge-read.ts` — a corrupt or wrong-shaped file is first quarantined as `<name>.corrupt-<timestamp>` (bytes preserved, warning logged) before starting empty, and non-ENOENT IO errors are re-thrown; previously one colour change wiped every tag/description of that folder and one tag-description edit dropped all the others. Legacy sidecar migration now deletes only the files that actually parsed, renaming malformed ones to `<name>.json.corrupt-<timestamp>` for permanent preservation (left in place if the rename fails); redux-persist purge treats only ENOENT as done and re-throws other delete failures instead of reporting a fake success that resurrects data on the next launch; index/full-text rebuild failures set the dirty flag and retry with a 1.5 s-to-60 s backoff, so a quiet folder no longer stays stale forever. Added `merge-read` / `tag-library` / `persist-storage` tests plus `folder-meta` / `sidecar` / `dir-watcher` regression cases, and a failed MCP config persist now rejects the IPC call.

- **渲染层失败不再"看起来像成功"**:补齐 15 处失败不可见。打标路径(`PropertiesTray` 快捷行、`EntryContextMenu` 周期标签/移除标签)的写失败统一进本地 Snackbar;`SearchBar` 与 `AdvancedSearchDialog` 查询失败先清空旧结果再显示错误与 Retry,不再拿上一次的命中冒充本次;`DirectoryTree` 加载失败记为错误行(`folderLoadFailed` + 真实错误 tooltip + Retry),不再缓存空数组显示成空目录,树的展开规则抽到 `src/renderer/domain/directory-tree-rows.ts` 以便单测;`McpSection`、`RevisionHistoryDialog`、`AddLocationDialog`、`SettingsDialog`(全文索引探测)、`MapiqueView`、`Sidebar`、`FileList` 的写/探测/打开动作也不再吞错;启动清理、fulltext 路径同步、外部改动重载与窗口命令这类后台失败改为带 tag 的日志。新增 `errorMessage` 与 `AppNoticeHost` 应用级提示通道,文案补齐 5 套 locale。
  **Renderer failures no longer look like success**: closed 15 "failure invisible" sites. Write failures on the tagging paths (`PropertiesTray` quick rows, `EntryContextMenu` period-tag and tag removal) now reach the local snackbar; `SearchBar` and `AdvancedSearchDialog` clear stale results before showing an error plus Retry instead of presenting the previous query's hits as current; `DirectoryTree` records a failed load as an inline error row (`folderLoadFailed`, real message in the tooltip, Retry) instead of caching an empty array that looked like an empty folder, and its row-expansion rules moved to `src/renderer/domain/directory-tree-rows.ts` so they can be unit-tested; `McpSection`, `RevisionHistoryDialog`, `AddLocationDialog`, `SettingsDialog` (full-text probe), `MapiqueView`, `Sidebar` and `FileList` no longer swallow errors from their write/probe/open actions; background failures (boot cleanup, full-text path sync, external-change reload, window commands) are logged with tags. Added `errorMessage` plus the app-level `AppNoticeHost` channel, with strings in all five locales.

- **审计遗留项收尾**:MCP 审批改为 FIFO 队列——一次只广播队首,排队请求的 60s 超时**从被显示时**开始计时(旧实现让第二条在看不见的队列里烧完超时,用户从未见过的对话框被自动拒绝),队列上限 8 条超出立即拒绝,退出时清空队列而不弹出下一条,广播失败也 fail-closed;`before-quit` 现在最多等 2s 让 `shutdownMcpServer()` 拒绝未决审批并释放端口,不再出现"窗口已关、端口还在收工具调用";`zipEntries` 在 POSIX 上从所有源的最近公共父目录执行,多选跨目录时不再静默丢弃/重复其余源;删除后的 sidecar/缩略图/扫描缓存清理失败与修订目录清理失败改为带 tag 的警告,不再无声无息。
  **Audit leftovers closed**: MCP approvals are now a FIFO queue — only the head is broadcast and its 60 s timer starts when it is actually shown (previously a second request burned its timeout unseen and was auto-denied for a dialog the user never saw), the queue caps at 8 and fails closed beyond that, quitting clears the queue instead of promoting the next request, and a failed broadcast also fails closed; `before-quit` now waits up to 2 s for `shutdownMcpServer()` to deny pending approvals and release the port, so the port can no longer accept tool calls after the window is gone; `zipEntries` builds POSIX archives from the deepest common parent of all sources, so cross-folder selections are no longer silently dropped or duplicated; and failures to clean up sidecars/thumbnails/scan cache after a delete and failures in revision cleanup are logged with tags instead of vanishing.

- **全文索引:读取失败不再清空搜索内容,PDF 设内存上限**:增量重建此前把"这次没看到"一律当删除——打不开的子目录、stat 失败的条目、读失败的文本都会让既有行被删,一次权限抖动就清空整棵子树的全文索引;现在不可读的目录 / 条目和超过 128 MiB 的 PDF 记入 `skipped`,删除集合由 `selectRemoved` 按路径边界豁免(旧行保留为"陈旧但可搜索"),读失败与空文件也在 `extractText` 内部分离(`unreadable` 标志)。PDF 抽取不再无上限整读:`MAX_PDF_BYTES = 128 MiB`,超限在 `readFile` 前拒绝并保留旧行,`whale_extract_text` 返回明确错误;docs/15 的 Tier 3 至此全部闭环。新增 `fulltext.test.ts` 10 例。
  **Full-text index: read failures no longer wipe searchable content, and PDFs got a memory cap**: an incremental rebuild used to treat "not seen this walk" as "deleted" — unreadable subdirectories, entries whose `stat` failed and files whose read failed all pushed their existing rows into `removed`; one permission blip emptied a whole subtree's index. Unreadable directories/entries and PDFs above 128 MiB now go to `skipped`, and `selectRemoved` exempts them by path boundary (the old row survives as stale-but-searchable); read failures and empty files are also distinguished inside `extractText` via the `unreadable` flag, and a PDF that cannot be opened no longer fails the whole build. PDF extraction is no longer an unbounded whole-file read: `MAX_PDF_BYTES = 128 MiB`, refused before `readFile` (old row kept) and reported as an explicit error by `whale_extract_text`; this closes the last Tier 3 item in docs/15. Added 10 `fulltext.test.ts` cases.

- **Linux 外部改动重新自动刷新**:Linux 的 `fs.watch` 不支持递归监听,此前整个 location 直接回落手动刷新——外部新增/改名/删除既不出现在文件区、也不进索引。现在 recursive 创建失败即切 **per-dir 递归兜底**:启动遍历目录树逐目录挂 watcher,新目录出现补挂(含同一调用里建出的嵌套子目录),删除/改名释放其下 watcher;`.whale` / `node_modules` / `.git` 不下降(自写回声 + inotify 预算),watcher 总数上限 4096(到顶警告一次)。Windows 回调的绝对路径(`\\?\C:\...`)按绝对路径解析,不再拼出 `a/b/?/C:/...` 垃圾路径。Windows/macOS 仍走单 recursive watcher,行为不变;测试用强制 per-dir 的 seam 在任意平台覆盖同一代码路径。
  **Linux external changes refresh automatically again**: Linux `fs.watch` has no recursive mode, so a location fell back to manual refresh and external creates/renames/deletes never reached the file area or the index. When the recursive watcher cannot be created the watcher now falls back to **one watcher per directory**: it walks the tree once, attaches a watcher to every folder, follows folders created later (including nested subtrees made in the same call), and releases the watchers beneath deleted or renamed folders. `.whale`, `node_modules` and `.git` are never descended into (self-echo plus the inotify watch budget) and the total is capped at 4096 watchers with a single warning. Absolute callback paths on Windows (`\\?\C:\...`) are resolved as absolute instead of being joined into junk like `a/b/?/C:/...`. Windows/macOS keep the single recursive watcher; tests force the per-dir path through a seam so both platforms exercise the same code.


- **Linux 桌面动作不再"点了没反应"**:终端打开此前只试 `xterm`,GNOME/KDE 上缺它就静默失败(错误被吞成 best-effort);现在按 `$TERMINAL`、`x-terminal-emulator`、`gnome-terminal`、`konsole`、`xfce4-terminal`、`tilix`、`kitty`、`alacritty`、`xterm` 顺序逐个尝试,只有子进程真正 `spawn` 才算成功,全部失败时把每个候选的原因抛给渲染层提示。在文件管理器中显示改为 `org.freedesktop.FileManager1.ShowItems`(D-Bus)→ `nautilus --select` → `dolphin --select` → `xdg-open <父目录>`,第一个成功即返回,全部失败才报错(KDE 用户不再被 `nautilus` 缺失打断)。打包在 `zip` 缺失时(如 Ubuntu 桌面默认没有 zip)自动回落 `python3` 的 `zipfile`,压缩目录时跳过空目录。
  **Linux desktop actions no longer do nothing**: opening a terminal used to try only `xterm` and fail silently where it is missing (the error was swallowed as best-effort); it now tries `$TERMINAL`, `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `tilix`, `kitty`, `alacritty` and `xterm` in order, counts only an actual `spawn` as success, and reports every candidate's failure to the renderer when none works. Revealing in a file manager now runs `org.freedesktop.FileManager1.ShowItems` over D-Bus, then `nautilus --select`, then `dolphin --select`, then `xdg-open` on the parent, returning on the first success and only failing when all do (KDE users are no longer stopped by a missing `nautilus`). Packaging falls back to `python3` `zipfile` when the `zip` binary is missing (Ubuntu Desktop does not ship it) and skips empty directories when zipping a folder.

- **崩溃可恢复、致命异常有日志**:渲染进程崩溃此前只留一个白窗口;现在 `render-process-gone` 先写 `crash.log`,再按 2 次 / 60 秒预算自动重载,超出预算弹 `Restart interface / Quit` 对话框,`clean-exit` 不重载。主进程补上 `uncaughtException`:写日志、尽力落 `crash.log`、弹错误框后 `exit(1)`,不再静默退出;`unhandledRejection` 行为不变。日志位于 `<userData>/crash.log`。
  **Crashes recover and fatal exceptions leave a log**: a renderer crash used to leave only a white window; `render-process-gone` now appends to `crash.log` and reloads within a 2-attempt / 60-second budget, after which a `Restart interface / Quit` dialog appears (`clean-exit` never reloads). The main process gained an `uncaughtException` handler that logs, best-effort appends to `crash.log`, shows an error box and exits with code 1 instead of dying silently; `unhandledRejection` is unchanged. The log lives at `<userData>/crash.log`.

- **首屏白屏也有出口、有日志**:错误边界只覆盖 root 之下的渲染错误;`Root` 渲染期抛错、`PersistGate` 卡在 rehydrate、React 之外的异步错误此前只留下一个白窗口和 DevTools 里一行字。新增 `boot-guard`,在 `createRoot` 之前安装全局 `error` / `unhandledrejection` 监听与 15 秒启动看门狗;未就绪时盖一层不依赖 React/MUI/i18n/theme 的恢复界面(显示原因与 `Reload / 重载`),就绪后错误只上报、不再遮界面。错误边界与渲染层错误经 preload → IPC 上报主进程,清洗控制字符并截断后写入同一个 `crash.log`,并做每分钟 20 条限流。bundle 静态 `import` 在 `index.tsx` 之前求值,这一层的抛错目前仍覆盖不到(需 HTML 内联脚本,未做)。
  **A blank first screen now has an exit and a log**: the error boundary only covered render errors below the root; a throw while `Root` renders, a `PersistGate` stuck in rehydration or an async error outside React used to leave nothing but a white window and one DevTools line. `boot-guard` now installs global `error` / `unhandledrejection` listeners and a 15-second startup watchdog before `createRoot`; while not ready it shows a recovery overlay that depends on neither React, MUI, i18n nor the theme (with the reason and a `Reload` action), and once ready errors are only reported instead of covering the UI. Error-boundary and renderer failures are reported through preload → IPC to the main process, sanitized and truncated, and appended to the same `crash.log`, rate-limited to 20 entries per minute. A bundle's static `import`s are evaluated before `index.tsx`, so a throw at that layer is still not covered (it would need an inline HTML script; not done).

- **MCP token 不再明文落盘**:本地 MCP 服务器的 bearer token 此前以明文存在 <userData>/mcp-config.json,任何能读该文件的进程或一份备份都能完整冒充客户端(读工具无需审批)。现在持久化文档带 `tokenStorage` / `tokenEncrypted`:有可用密钥库时用 Electron safeStorage 加密后再原子落盘,文件里不再出现明文 token;无可用密钥库时回退明文并标记,旧明文配置在下次写入时自动迁移。密文读不出来(换机、密钥库重置)时先退回同文件里的明文,两者都没有才重新生成并告警(此时旧客户端会 401)。Linux 无 keyring 时 Electron 的 `basic_text` 后端只有混淆强度,不能当真正的密钥保护。
  **MCP tokens are no longer stored in clear text**: the local MCP server’s bearer token used to sit in <userData>/mcp-config.json in plain text, so any process able to read that file — or a backup of it — could impersonate a client completely (read tools need no approval). The persisted document now carries `tokenStorage` / `tokenEncrypted`: when an OS keyring is available the token is encrypted with Electron safeStorage before the atomic write, so the file no longer contains it in clear text; without a usable keyring it falls back to plaintext and says so, and legacy plaintext configs migrate on the next write. When the ciphertext cannot be opened (new machine, reset keyring) the plaintext copy in the same file is used first, and a fresh token is only generated when neither works — with a log line and a 401 for the old client. On Linux without a keyring Electron’s `basic_text` backend only obfuscates, so it must not be treated as real key protection.


- **MCP 审批弹窗不再“点了就消失”**:此前点击允许/拒绝会在 IPC 返回前把请求从列表删掉,失败也被吃掉;一旦 IPC 出错,用户以为已答复、弹窗也关了,而外部 AI 客户端的工具调用要挂到 60 秒超时才被自动拒绝。现在作答要等主进程确认(`mcpResolveApproval` 返回 `settled`):真结算了才关闭,请求已超时则关闭并提示“已超时”,IPC 失败时弹窗保留、提示错误并与主进程重新对齐。弹窗还显示剩余秒数,作答在途时两个按钮都禁用。
  **MCP approval dialogs no longer vanish on click**: clicking Allow or Deny used to drop the request from the list before the IPC resolved, and any failure was swallowed; when the IPC did fail, the user believed the request was answered and the dialog closed, while the external AI client stayed blocked until the 60-second auto-deny. Answers now wait for main to confirm (`mcpResolveApproval` returns `settled`): the dialog closes only when the request was really settled, closes with an “already expired” notice when it had timed out, and stays visible with an error notice plus a reconciliation pull when the IPC fails. The dialog also shows the remaining seconds and disables both buttons while an answer is in flight.


- **目录枚举也受位置边界约束**:`fs:listDirectory` / `fs:listDirectoryRecursive` / `folderMeta:read` 此前不校验 allowedRoots,被注入的渲染层可以枚举任意目录、在任意目录写扫描缓存——尽管文档声称“读取入口也遵守同一位置边界”。三个通道现在与写通道、文件读取用同一把尺子(fail-closed:未注册位置时一律拒绝),递归扫描的缓存因此也只落在边界内;同时删除了渲染层从未调用、没有任何校验的 `fs:pathExists`(handler + preload + 类型声明)。`waitForAllowedRoots()` 在首次挂载时先让出一个 microtask,避免目录列表早于 Root 的 `setAllowedRoots` 被误拒。
  **Directory enumeration is now bounded by the locations too**: `fs:listDirectory`, `fs:listDirectoryRecursive` and `folderMeta:read` did not check allowedRoots, so an injected renderer could enumerate any directory and even write the recursive scan cache into arbitrary `.whale/` folders — despite the docs claiming reads honour the same boundary. All three now use the same guard as writes and file reads (fail-closed: refused when no location is registered), which also keeps the recursive cache inside the boundary. The unused, unguarded `fs:pathExists` channel was removed (handler, preload and type), and `waitForAllowedRoots()` now yields one microtask on first mount so directory listing cannot be refused before Root has pushed `setAllowedRoots`.


- **位置边界不能再被渲染层自行登记绕过**:`fs:setAllowedRoots` 此前直接信任渲染层传来的根目录数组,渲染层一旦被注入,push 一个 `/` 就能让 allowedRoots 形同虚设。现在主进程用 `known-roots.json` 记住用户真正在原生对话框里选过的目录,只放行这些;升级/首装时做一次种子(TOFU)避免既有位置失效,记录损坏或不可读时重新 seed 而不是把用户锁在门外。
  **The location boundary can no longer be widened by the renderer itself**: `fs:setAllowedRoots` used to trust the array the renderer sent, so an injected renderer could push `/` and turn allowedRoots into decoration. The main process now keeps `known-roots.json` — the directories the user picked in the native folder dialog — and only accepts those; an upgrade or first install seeds the record once (trust on first use) so existing locations keep working, and a corrupt or unreadable record re-seeds instead of locking the user out.


- **MCP 工具面补齐审批「放行」路径的端到端测试**:此前只有「拒绝」用例,而且它在未注册 root 时运行、先撞位置守卫,审批闸被整体删掉也照样通过。新增 tool surface 组用自动放行的传输层走真实审批队列,逐工具断言副作用(list_directory / get_meta / write_description / extract_text / create_folder / create_text_file / copy / move / delete / zip),其中创建文本文件同时验证 UTF-8 字节数与拒绝覆盖,删除走 `shell.trashItem`。
  **End-to-end coverage for the MCP approval ALLOW path**: the only approval test was the deny side, and it ran without a configured root — so the location guard fired first and the test would still pass with the approval gate deleted. A new tool-surface suite injects an auto-approving transport and goes through the real queue, asserting the side effect of each tool (list_directory / get_meta / write_description / extract_text / create_folder / create_text_file / copy / move / delete / zip); the text-file case also pins UTF-8 byte accounting and the no-overwrite rule, and delete goes through `shell.trashItem`.


- **侧车读失败不再擦掉索引里的标签**:索引遍历遇到读不出的 `wsd.json` 时,此前会把该目录文件的标签按"只剩文件名标签"覆盖进数据库——一次瞬时的权限/损坏错误就让标签从搜索和标签过滤里消失,直到下次重建成功。现在这类条目带 `tagsUnreadable` 标记,写入时保留数据库里已有的标签(且不参与"未变就跳过"),下一次读取成功时仍以侧车为准。
  **A failed sidecar read no longer erases tags from the index**: when the walk could not read a directory's `wsd.json`, indexing used to overwrite that directory's tag rows with the filename-derived partial view — one transient permission or corruption error made the tags disappear from search and tag filters until a later rebuild. Those rows now carry a `tagsUnreadable` flag; the ingester keeps the stored tags (and never skips them as "unchanged"), while a later successful read is authoritative again.

## [0.5.0] - 2026-09-15

### Added

- **本地 MCP 服务器**:新增设置 ▸ MCP 服务器,外部 AI 客户端(Claude Desktop、ZCode 等)可经 Streamable HTTP(仅 127.0.0.1)+ Bearer token 接入,提供 18 个工具覆盖四大场景——搜索(FTS 名/路径/标签/正文全文)、读取(编码自适应文本、PDF 抽取、sidecar 元数据)、整理(打标/描述写 sidecar 免审批;移动/复制/删除(仅回收站)/打包/建夹需在应用窗口弹窗审批,超时即拒绝)、打包(zip 多文件、报告落盘)。默认关闭且默认只读;所有路径过 allowedRoots 校验,move/copy 目的地也必须在位置内。归纳结果推荐写入文件描述(sidecar,可搜索)。详见 docs/21。
  **Local MCP server**: Settings ▸ MCP Server exposes WhaleTag to external AI clients (Claude Desktop, ZCode, …) over Streamable HTTP (127.0.0.1 only) + bearer token, with 18 tools across four scenarios — search (FTS name/path/tag + full-text content), reading (encoding-adaptive text, PDF extraction, sidecar metadata), organizing (tags/descriptions to sidecar without approval; move/copy/delete (recycle bin only)/zip/create-folder gated by an in-app approval dialog, fail-closed on timeout), and packaging (multi-file zip, report files). Disabled and read-only by default; every path passes the allowedRoots guard, and move/copy destinations must also sit inside configured locations. Summaries are meant to land in file descriptions (sidecar, searchable). See docs/21.

### Removed

- **移除内置 AI 助手**:删除整个 AI 子系统——`src/main/ai/`(Claude Code CLI 运行时、Ollama/OpenAI HTTP provider、safeStorage 密钥管理、审批闸门、内联改写、标题生成)、`.whaleai` 可选组件安装系统、AI 侧栏面板与会话 redux slice、设置页 AI 分类(19 个 `ai*` 设置字段)、扩展编辑器 AI 选区桥(`requestSelection`/`applyReplacement`)与「AI 编辑选中」按钮、5 语言各 108 个文案键;卸载 `@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/claude-code`(~229MB claude.exe)与 `marked` 依赖,安装包显著瘦身。AI 能力由本地 MCP 服务器 + 外部客户端取代(见上)。搜索/索引/打标/缩略图零受影响;旧持久化会话与 `ai*` 设置字段在迁移中清理。
  **Removed the built-in AI assistant**: the entire AI subsystem is gone — `src/main/ai/` (Claude Code CLI runtime, Ollama/OpenAI HTTP providers, safeStorage key management, approval gate, inline rewrite, title generation), the `.whaleai` optional-component installer, the AI side panel + conversation redux slice, the settings AI section (19 `ai*` fields), the extension-editor AI selection bridge (`requestSelection`/`applyReplacement`) with its "AI edit selection" button, and 108 locale keys × 5 languages; uninstalled `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-code` (~229MB claude.exe) and `marked`, notably slimming the installer. AI capability is superseded by the local MCP server + external clients (above). Search/indexing/tagging/thumbnails are unaffected; legacy persisted conversations and `ai*` settings fields are cleaned up in migration.

### Fixed

- **安全加固**:`ext:deleteRevision` 此前接受渲染层传来的任意路径并 `rm --force`(绕过回收站与 allowedRoots)——现在与 `restoreRevision` 相同,把 revision 绑定到所属文件的 `.whale/revisions/` 前缀,`backup`/`restore` 入口补 `assertWithinAllowedRoot`;`sidecar:write`、`exif:extractGps`、`exif:get-summary` 三个 IPC 入口补 allowedRoots 校验;主窗口锁定 `will-navigate`(渲染层无法携带 preload 桥导航离站);升级 `pdfjs-dist`(≥6.2.108,恶意 PDF 任意 JS 执行)与 `sharp`(≥0.35.4,libheif)两个特权进程解析依赖。
  **Security hardening**: `ext:deleteRevision` used to accept any renderer-supplied path and `rm --force` it (bypassing the recycle bin and allowedRoots) — it now binds the revision to its owner file's `.whale/revisions/` prefix (same check as restore), and the backup/restore entries gain `assertWithinAllowedRoot`; the `sidecar:write`, `exif:extractGps` and `exif:get-summary` IPC entries gain the allowedRoots guard; the main window locks `will-navigate` (the renderer can no longer carry the preload bridge off-site); and the two privileged-process parser dependencies are bumped — `pdfjs-dist` (≥6.2.108, malicious-PDF arbitrary JS execution) and `sharp` (≥0.35.4, libheif).

- **MCP 审批体验与加固**:审批弹窗明细改为完整路径(可滚动,超过 20 条显式标注未展示数量),summary 显示完整目标路径;**Deny 成为默认焦点**——连按 Enter 不再等于放行;`whale_apply_tags` 写入前经 `normalizeSmartTags` 规范化,与 UI 打标行为同源;HTTP 端点校验 Host 头(先于 401 返回 403,防 DNS rebinding);MCP 配置变更在生命周期队列内先原子落盘再生效,切换开关后立即崩溃不再丢状态。
  **MCP approval UX & hardening**: the approval dialog lists FULL paths (scrollable, with an explicit "N more not shown" beyond 20) and shows complete destination paths in the summary; **Deny is the default focus** — mashing Enter no longer means allow; `whale_apply_tags` normalizes through `normalizeSmartTags` so external writes match the UI's tag shapes; the HTTP endpoint validates the Host header (403 before the 401 challenge, a DNS-rebinding defense); and MCP config changes persist atomically inside the serialized lifecycle before taking effect, so a crash right after a toggle can't lose it.

- **杂项**:移除 `shell:runCommand` 遗留的 TEMP DEBUG 命令行日志;清理 `protocol-range.ts` 中已删除的 `whale-audio://` 注释残留;修正 `fs-read.ts` 的 `readTextFile` 函数体换行;plan.md 移除已删除 docs/11-ai.md 的索引死链。
  **Misc**: removed the leftover TEMP DEBUG command logging in `shell:runCommand`; cleaned the stale `whale-audio://` comment in `protocol-range.ts`; fixed the `readTextFile` line break in `fs-read.ts`; and dropped the dead docs/11-ai.md index row from plan.md.

## [0.4.9] - 2026-09-05

### Removed

- **移除 md-editor 扩展**(项目瘦身):删除 `src/extensions/md-editor/` 与其主进程支撑(PDF 导出 `renderHtmlToPdf`、粘贴图片落盘 `saveImageToFile`、剪贴板桥 `readClipboardText`、目录列表 / 文件删除 RPC)、设置页 md 专属面板(渲染主题 / 提示框 / HTML 模板 / PDF 页眉页脚 / 粘贴图片位置 / Markdown 快捷键)及 `extensions` 设置标签页;卸载 `mermaid` / `marked-footnote` / `highlight.js` 三个仅为其存在的依赖。`.md` / `.markdown` 双击现回退系统默认应用打开;全文索引与文件图标不受影响。
  **Removed the md-editor extension** (project slimming): deleted `src/extensions/md-editor/` and its main-process support (PDF export `renderHtmlToPdf`, paste-image `saveImageToFile`, clipboard bridge `readClipboardText`, list-directory / delete-files RPC), the md-only settings panes (render theme / callouts / HTML templates / PDF header & footer / paste-image location / Markdown keybindings) and the `extensions` settings tab; uninstalled the `mermaid` / `marked-footnote` / `highlight.js` dependencies that existed solely for it. Double-clicking `.md` / `.markdown` now falls back to the OS default app; full-text indexing and file icons are unaffected.

- **移除 pdf-viewer 扩展**(项目瘦身续):删除 `src/extensions/pdf-viewer/` 与其专属支撑——`shared/pdfjs-in-iframe.ts` 会话工厂(office-viewer 移除后仅剩它一个消费者)、AI 框选提问管线(`askAi` 消息 / marquee / `aiDraftBus` / `AskQuestionDialog` / 5 语言 `aiPdf*` 文案)、大文件 `requestFileBytes`/`fs:readFileRange` 字节桥、pdfjs 资产服务 `requestPdfAsset`/`ext:getPdfAsset`。`.pdf` 双击现回退系统默认应用打开;**PDF 缩略图与全文索引不受影响**(主进程 `thumb-render.ts` / `fulltext.ts` 自持 pdfjs-dist,依赖保留),文件类型图标不变。
  **Removed the pdf-viewer extension** (slimming round 2): deleted `src/extensions/pdf-viewer/` and its dedicated support — the `shared/pdfjs-in-iframe.ts` session factory (sole consumer since office-viewer's removal), the AI marquee ask pipeline (`askAi` message / marquee / `aiDraftBus` / `AskQuestionDialog` / the 5-locale `aiPdf*` strings), the large-file `requestFileBytes`/`fs:readFileRange` byte bridge, and the pdfjs asset service (`requestPdfAsset`/`ext:getPdfAsset`). Double-clicking `.pdf` now falls back to the OS default app; **PDF thumbnails and full-text indexing are unaffected** (main-process `thumb-render.ts` / `fulltext.ts` own their pdfjs-dist dependency, which is kept), and file-type icons are unchanged.

## [0.4.4] - 2026-07-25

### Added

- **md-editor HTML 模板**:设置 ▸ 扩展 ▸ HTML 模板 管理可复用 HTML 片段,编辑区右键「模板」子菜单插入到光标处;预览经既有 DOMPurify 过滤(inline style 移除,可用 class),不改安全配置。
  **md-editor HTML templates**: manage reusable HTML snippets in Settings ▸ Extensions; insert at the cursor via the editor's right-click "Templates" submenu; preview sanitized by the existing DOMPurify pipeline (inline styles stripped, classes kept) — no config change.

### Fixed

- **office-viewer 请求悬挂**:三个 pending Map(转换 180s / 缩略图、soffice 探测各 15s)套超时,主进程崩溃或 IPC 丢响应时 resolver 不再永久驻留。
  **office-viewer pending resolver leak**: the three pending Maps (conversion 180s / thumbnail + soffice probe 15s each) now time out so resolvers don't hang forever when the main process drops a reply (crash / IPC drop).
- **Gantt 右键文案脱钩**:GanttEntryMenu 改用独立 gantt* i18n key(5 语言),不再复用 Kanban 的 key。
  **Gantt menu i18n decoupled**: GanttEntryMenu now uses its own gantt* keys (5 locales) instead of borrowing Kanban's.

## [0.4.3] - 2026-07-25

### Added

- **多标签页查看文件**:打开新文件不再关闭当前文件,而是开一个标签页;已打开的标签保活、切换不重新加载;同文件去重(激活已有标签)、LRU 上限(默认 8)、关闭前未保存弹确认。目录树支持双击文件打开。
  **Multi-tab file viewing**: opening a file no longer replaces the current one — each open gets its own tab; open tabs stay alive and don't reload on switch; same-file dedup (activates its tab), LRU cap (default 8), dirty-check before close. Directory tree supports double-click to open files.

## [0.4.2] - 2026-07-25

### Added

- **AI AskUserQuestion 问答链路**:Claude CLI 提问工具接入应用内问答弹窗(单选/多选/Other 自由文本),修复此前提问必然失败的问题(allow 不带 updatedInput.answers)。
  **AI AskUserQuestion bridge**: in-app question dialog for the CLI's question tool (single/multi-select + free-text Other) — previously always failed (allow without updatedInput.answers).
- **plan 模式反馈通道**:ExitPlanMode 弹窗可填修改意见,经 ai:resolveApproval(note) 回传模型。
  **plan-mode feedback**: ExitPlanMode dialog takes revision notes, forwarded to the model.
- **pdf-viewer 框选提问**:拖框提取文本/截图,弹出可编辑提问框,AI 面板用框选内容回答(扫描件走模型视觉)。
  **pdf-viewer marquee ask-AI**: box-select extracts text + screenshot; editable question dialog; AI panel answers with the region (scans via vision).

### Fixed

- **大 PDF 打开缓慢**:改为 pdfjs 自定义 range transport 经 IPC 按需取 64KB 分片,首页不再等整份读入。
  **large-PDF open time**: custom pdfjs range transport pulls 64KB slices over IPC — first page no longer waits for the whole file.
- **KanbanView stages 空↔非空 hooks 崩溃**;**FileList Snackbar 空引用崩溃**;**toast 严重度五语言误判**(改为结构化 severity)。
  **Kanban hooks crash** on stages 0↔N; **FileList Snackbar null crash**; **toast severity mis-detection** in all 5 languages (now structured).
- **「问 AI」按钮点击无反应**:mousedown 冒泡销毁迷你条按钮;草稿懒加载竞态(aiDraftBus 槽+事件双通道)。
  **dead "Ask AI" button**: bubbling mousedown destroyed the mini bar mid-click; lazy-mount draft race (aiDraftBus slot + event).
- 主布局 AI 面板打开时左栏自动折叠;命令菜单改悬停飞窗;Silent failures 全面接入用户可见反馈;40+ 项 UI/UX 打磨(i18n 硬编码、aria、focus-visible、键盘可达)。
  Left columns auto-collapse when the AI panel opens; commands flyout menu; silent failures now surface; 40+ UI/UX fixes (hardcoded i18n strings, aria, focus-visible, keyboard).

## [0.4.0] - 2026-07-19

### Added

- **md-editor callout 提示框**:Obsidian/GitHub Alerts 语法 `> [!NOTE/WARNING/TIP/...]`,15 内置类型 + Settings 自定义类型(图标/颜色)。
  **md-editor callout**:Obsidian/GitHub Alerts syntax `> [!NOTE/WARNING/TIP/...]`, 15 built-in types + custom types (icon/color) in Settings.
- **md-editor 右键上下文菜单**:自定义 in-iframe 菜单(撤销/剪贴板/格式/标题/插入/导航/视图/导出),编辑区 + 预览区两套。
  **md-editor right-click context menu**: custom in-iframe menu (undo/clipboard/format/heading/insert/navigate/view/export), separate for editor + preview.
- **md-editor chrome 全量多语言**:工具栏/状态栏/TOC/右键菜单/对话框全部接入 i18n(en/zh/zh-TW/ja/ko)。
  **md-editor chrome fully localized**: toolbar/status bar/TOC/context menu/dialogs wired to i18n (en/zh/zh-TW/ja/ko).
- **md-editor 图片粘贴位置设置**(参考 Typora):当前目录 / 子文件夹模式,子文件夹名支持 `${filename}` 变量(按 md 文件名分目录)。
  **md-editor pasted-image location setting** (Typora-style): current-folder / subfolder mode; subfolder name supports `${filename}` (per-md directory).
- **md-editor 快捷键自定义**:Settings ▸ md-editor 快捷键,CodeMirror combo 重绑,live 生效。
  **md-editor keybinding customization**: Settings ▸ md-editor, CodeMirror combo rebind, live.
- **md-editor 代码折叠 / TOC 大纲侧栏 / 渲染主题预设**(github/solarized/dracula/nord/gruvbox/one-dark/latex,独立于全局主题)。
  **md-editor code folding / TOC outline / render-theme presets** (independent of the global theme).
- **office-viewer 数学公式渲染**、**主进程目录监视(dir-watcher)**、**whale-audio 协议**、KeyCaptureInput、tag-library-pack、callout-types。
  **office-viewer math rendering**, **main-process dir-watcher**, **whale-audio protocol**, KeyCaptureInput, tag-library-pack, callout-types.

### Changed

- md-editor 架构拆分:从单一 `index.ts` 拆为 md-toolbar/md-keymaps/md-i18n/md-fold/md-toc/md-scroll/md-statusbar/md-theme/md-contextmenu/md-render。
  md-editor split from a single `index.ts` into md-toolbar/md-keymaps/md-i18n/md-fold/md-toc/md-scroll/md-statusbar/md-theme/md-contextmenu/md-render.
- IPC:`ipc.ts` → `ipc/` 目录(按域拆分);settings slice → `reducers/settings/`;extension-host → `extension-host/`。
  IPC: `ipc.ts` → `ipc/` dir (per-domain); settings slice → `reducers/settings/`; extension-host → `extension-host/`.

### Performance

- md-editor:图片懒加载、移除 katex 死代码、`content-visibility`、日志精简。
  md-editor: lazy images, dropped katex dead code, `content-visibility`, trimmed logs.
- 移除 md-editor PDF 导出( drop pdf-lib,**-270KB gz**)。
  Removed md-editor PDF export (dropped pdf-lib, **-270KB gz**).

### Fixed

- 网络共享删除失败时提供永久删除选项。
  Offer permanent delete when trash fails on network shares.
- md-editor Ctrl+T 表格对话框失效:`<dialog>`/showModal → div overlay;根因是过时 `src/*.js` 因 webpack `.js` 优先于 `.ts` 而污染 bundle。
  md-editor Ctrl+T table dialog broken: `<dialog>`/showModal → div overlay; root cause was stale `src/*.js` shadowing `.ts` in the bundle (webpack resolves `.js` before `.ts`).

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
