# Changelog

All notable changes to this project will be documented in this file.
本项目所有重要变更均记录于此文件。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),并遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### Fixed

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
