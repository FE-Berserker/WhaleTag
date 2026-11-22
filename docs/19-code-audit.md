← 返回 [plan.md](../plan.md)

# 19 · 代码质量审计与改进清单

> **2026-07-28** 起的代码质量审计追踪清单（plan.md §F「不做未来计划」的**经确认例外**，同 [docs/15](./15-perf-audit.md) / [docs/16](./16-cross-platform.md)）。
>
> **形态**：每轮结束后只留 1–2 行结论——「修了什么 + 关键坑」；逐条证据（文件行号、测试断言、基线数字）留在共置测试与 git 历史里，不再回填过程细节。历史轮次的测试计数是当时口径，当前门禁以 `npm test` 输出为准。
>
> **范围与边界**：本篇聚焦**正确性 bug + 测试缺口 + 类型/可维护性**；**不重复** [docs/09](./09-known-issues.md)（已知坑主档）、[docs/13](./13-security.md)（安全模型）、[docs/15](./15-perf-audit.md)（性能）、[docs/16](./16-cross-platform.md)（跨平台）。评估后**不做**的项集中在文末「已接受的取舍」。

---

## 🔴 P0 — 真实正确性 bug

### P0-1. redux-persist 落盘跳过 `datasync` ✅
`persist-storage.ts` 的 `persistWrite` 曾手写 `writeFile`+`rename`，缺 `datasync` 与唯一 tmp 名；改调 `atomicWriteText`，删掉 dead 的 `tmpPathForKey`。

### P0-2. 扩展场景恢复与 dirty 保护 ✅（2026-11-22）
Excalidraw 首份内容改走 `initialData` Promise，避免初始化空场景覆盖；非空 JSON 先验证场景形状，拒绝上游 total restore 的 fail-open；恢复失败标记 fatal、阻断扩展/宿主 Save 并提供 Retry，失败时关闭保存立即失败，重试清旧 revision/自写回读快照，成功恢复强制 dirty 对账。`editState` 的关闭/监听/LRU 读取统一为 `tabId`，不再跳确认、覆盖未保存编辑或误淘汰 dirty 标签。真实 Excalidraw/Mermaid 与脏标签 GUI 冒烟作回归门。

---

## 🔴 P1 — 高优先级

### P1-1. 文件写操作契约与回归网 ✅
`fs-write.ts` 确立「失败必 reject」契约；IPC rig 覆盖 rename 越界、目标已存在不覆盖、源缺失必 reject、mkdir；读侧补 `allowedRoots` 守卫。

### P1-2. 日期标签迁移的幂等与隔离 ✅
`migrate-date-tags.ts` 覆盖纯函数变换、备份幂等、坏 JSON 不覆写、startup once-guard；`migrateIfPresent` 只把 ENOENT 视为「不存在」，其它错误进 `errors`。

### P1-3. 目录锁语义 ✅
`dir-lock.ts` 同 key 串行（高水位 1）、不同 key 并行、reject 隔离、返回值/拒绝正确传播、长链保序。

### P1-4. shell 引号对抗输入 ✅
`shell-quote.test.ts` 覆盖 POSIX 元字符、CJK、NUL、单引号 close-reopen；Windows `%VAR%` 加引号但 `%` 原样。

### P1-5. 读入口边界、原子写与 worker 失败 ✅
缩略图目录入口、六个索引/全文读入口、`ext:listRevisions` 补 `allowedRoots`；原生选择器只写目标 `.whale/`；原子写 stale tmp 只匹配 `.<pid>.<counter>.tmp`；`createTextFile` 用 `flag:'wx'`；重建期变更置 dirty；worker `postMessage` 失败 reject 并清 pending。

### P1-6. sidecar 损坏的显式恢复 ✅
detailed read 上报 corrupt/unreadable，用户确认后按 SHA-256 + `allowedRoots` + 目录锁：排他备份原字节 → 合并 legacy → 原子写；冲突/非损坏/失败一律不覆盖。

### P1-7. MCP 与自动更新回归网 ✅
端点精确 `/mcp`、`/mcp/`；未知会话 404；体 4 MiB 超限 413；会话 `lastSeen` + `unref()` sweeper（30 min）；`mcp-server` 监听成功才发布 core、停止先 `close()` 再 `closeAllConnections()`；`normalizeMcpConfig()` 归一坏配置；`downloadUpdate()` in-flight 共享、`quitAndInstall()` try/catch。

### P1-8. 工具面守卫 ✅
`renameEntry`/`moveEntry`/`copyEntry` 改 `withLock(目标目录)` 包「检查+写入」且 `cp{force:false,errorOnExist}`；`isConfiguredRoot`/`assertNotLocationRoot`；只读两道闸（审批返回后再查）；`whale_read_text` 先 `stat` 限 16 MiB；批量全失败带 `isError`；字节数用 `Buffer.byteLength`。

### P1-9. 读-改-写不再把「读失败」当空 ✅
`folder-meta`/`tag-library` 改用 `readJsonForMerge`（损坏隔离为 `.corrupt-<ts>`）；legacy 只删解析成功的路径，坏文件改名；`persistDelete` 非 ENOENT 重新抛出；watcher 失败置 dirty 并按 1.5s 起翻倍到 60s 退避重试。

### P1-10. 渲染层 15 处失败不可见 ✅
新增 `errorMessage()`、`app-notice.ts` + `AppNoticeHost`；打标、搜索、DirectoryTree（`childrenError` + 错误行 + Retry）、McpSection、RevisionHistoryDialog、AddLocationDialog、SettingsDialog、ExtensionContextProvider、TitleBar、Sidebar、Root 全部接错误态；行展开规则抽 `directory-tree-rows.ts` 便于单测。

### P1-11. 审批 FIFO、退出顺序与打包 ✅
审批改 FIFO（`MAX_PENDING_APPROVALS = 8`，超限 fail-closed）；`before-quit` 等 `shutdownMcpServer()`（2s）；新增 `commonParentDir` 修跨目录打包；删除后的 sidecar/thumbnail/scan-cache 与修订清理失败改 `warn`。

### P1-12. 全文索引读失败不删行 ✅
`skipped` + 纯函数 `selectRemoved(prior, seen, skipped)`（`a/b` 覆盖 `a/b/c` 但不覆盖 `a/bc`；根不可读则一条不删）；`readCappedText()`/`extractTextDetailed()` 区分空文件与读失败；PDF 上限 128 MiB。

### P1-13. Linux per-dir watcher ✅
`rename` 时 `attachDirTree`/`detachTree`；事件路径换算；Windows 删目录回调绝对路径（含 `\\?\C:\...`）；`.whale`/`node_modules`/`.git` 不下降；`MAX_DIR_WATCHERS = 4096`；测试用 `_startWatchForcedPerDirForTest` 强制该路径。

### P1-14. Linux 桌面 fallback ✅
`linuxTerminalCandidates`（`$TERMINAL` → `x-terminal-emulator` → gnome-terminal/konsole/xfce4-terminal/tilix/kitty/alacritty → xterm，必须等 `spawn`）；reveal 走 D-Bus `ShowItems` → nautilus/dolphin `--select` → `xdg-open`；`zip` 缺失时退 `python3` + `zipfile`。

### P1-15. 崩溃守卫 ✅
`render-process-gone` 在 60s 窗口内自动 reload ≤2 次、用尽弹 Restart/Quit；`uncaughtException` → `handleFatalError`（log → append `<userData>/crash.log` → `showErrorBox` → `app.exit(1)`，三步各自 try/catch）。

### P1-16. 渲染层启动守卫 ✅
`index.tsx` 在 `createRoot` 前装 `error`/`unhandledrejection` 监听 + 15s 看门狗，未就绪时盖纯 DOM 恢复层；`reportRendererError` → `sanitizeErrorDetail`（去控制字符、上限 4000）；限流 20 次/分；`ErrorBoundary.componentDidCatch` 也上报。

### P1-17. MCP bearer token 明文落盘 ✅
`mcp-config.ts` 增 `tokenStorage`/`tokenEncrypted`，有密钥库时 `safeStorage.encryptString` 加密后 base64 落盘；无密钥库回退明文（标 `plain`）、密文解不开先退回同文件明文、两者都无才重发 token；旧明文下次写入自动迁移。Linux 无 keyring 时 `basic_text` 只有混淆强度（[docs/13](./13-security.md)）。

### P1-18. MCP 审批弹窗「乐观移除」✅
`mcpResolveApproval` 返回 `{ ok, settled }`，只有 `settled` 才关弹窗；IPC 失败保留弹窗 + 提示 + 重新拉取待办；在途禁用两个按钮；每秒显示「剩余 N 秒」，与主进程 60s 自动拒绝对齐。

### P1-19. 目录枚举越界 ✅
`fs:listDirectory`、`fs:listDirectoryRecursive`、`folderMeta:read` 补 `assertWithinAllowedRoot`；删除死 API `fs:pathExists`；`waitForAllowedRoots()` 在无 in-flight 注册时先让出微任务，目录树与内容 provider 列目录前 `await`；`sidecar:readMany*` 保留例外（无法枚举目录）。

### P1-20. 位置边界可被渲染层「自我登记」绕过 ✅
新增 `known-roots.ts`（记录存 `<userData>/known-roots.json`，在位置边界之外）；`fs:setAllowedRoots` 只放行记录里的目录，未知目录 `warn` 后丢弃；首次推送做一次性 seed（**空的也关闭窗口**），记录损坏或被目录占用时改名 `.corrupt-<ts>` 后重 seed。首装/升级那一次推送仍属 TOFU（[docs/13 §2](./13-security.md)）。

### P1-21. MCP「放行」路径与 9 个工具端到端 ✅
`mcp-http.test.ts` 新增 tool surface 组：`bindApprovalTransport` 自动放行 + 真实审批队列，逐工具断言副作用（列目录 / 元数据回读 / 描述覆盖 / 创建目录与文本文件 / 复制 / 移动 / 删除 / 打包）；electron stub 的 `shell` 补 `trashItem`。依赖 `utilityProcess` 的 5 个索引类工具仍只有只读拒绝用例。

### P1-22. 侧车读失败 → 索引把标签整批擦掉 ✅
`IndexEntry` 增 `tagsUnreadable` 标记 partial 视图；`ingestFiles` 用 `CASE WHEN @keep_tags THEN files.tags ELSE excluded.tags END` 保留库内标签，且该标记行不做「签名未变就跳过」；下一轮读成功时正常清空。

### P1-23. 全仓六通道复核 ✅
条件式 hook 三处（CalendarView / DirectoryTree / GalleryCell）上移、`.eslintrc.js` 启用 `react-hooks`；`fs:move`/`fs:copy` 补目的端校验、`importExternal` 的 `cp` 补 `force:false`；indexer 根 ENOENT 记为 `unreadable`；sidecar 跨目录改「先写目标、内容未变才删源」；shell 模板改主进程一次性授权；依赖补丁 + JSON-RPC batch 32 上限 + 15 个 i18n key + 去掉未声明的 `glob` 依赖。评估不改：smart-tags 的裸 4/6 位数字（见 [docs/03 §12](./03-tagging.md)）。

### P1-24. P2 数据正确性批 ✅
`index:build`/`fulltext:build` 按 root 串行、遍历用 `lstat`（符号链接目录不下降，避免 Windows junction 回环把 `complete` 永久锁死）；watcher 500 条/批由「截断丢弃」改为「下一 tick 续 drain」+ 5s 最大等待；清空失败写显式空文档、legacy `rm` 失败改改名 `.migrated-<stamp>`；修订改 `Buffer` + `atomicWriteBytes`（utf8 读 GBK 会写回 U+FFFD）；协议加类型白名单、heic wasm 15s 超时、drop-xml 双重转义、drawio 并发串行、html-viewer 剥 `@import`/`url()`；`insertFulltext` 同事务先删后插（FTS5 无 UNIQUE）。

### P1-25. 门禁硬化 ✅
`strict` 从 112 错收到 0（先修 helper 的可空 ref，再按错误类型逐条收窄）；`scripts/**/*.ts` 纳入 tsc；lint 加 `--max-warnings 0`、清 29 条 `exhaustive-deps` 与 88 条针对已关闭规则的死抑制指令。`no-explicit-any` 仍关闭（现存 26 处 `as any` 留专项），`no-console` 由 P1-26 以「只允许 warn/error + 单一入口」启用。

### P1-26. 安全收尾：权限全拒 + 敏感文件 0600 + 日志单一入口 ✅
`configurePermissions()` 的请求/检查 handler 一律 `false`；`AtomicWriteOptions.mode` + MCP 配置与 crash.log 用 `0600`、`sanitizeErrorDetail` 把 home 前缀换成 `~`；新增 `log.ts`（唯一 `eslint-disable no-console`）承接 9 处 `console.log/info/debug`，`scripts/**` 用 override 关闭。复核后不改：目录缩略图/背景源图可在位置外（只读源、只写目标 `.whale/`）、CSP `img-src` 保留 `http(s)`（[docs/13 §12](./13-security.md)）。

### P1-27. 正确性、资源边界与发布门禁 ✅
拖拽在 drag-start 读当前选择；批量 move/delete 聚合并只刷新一次、只清成功项选择，Gallery 多目标走 `saveMany`；编辑器保存带 revision、readOnly 不再重灌旧内容；全文首建每 100 条批写、失败批回滚、PDF 全局 2 路且异常 destroy 有 1s 有界等待；权限收窄为主界面/json-viewer 剪贴板与 image-viewer fullscreen 白名单；新增 Windows CI 与手动 fresh packaged-smoke。

### P1-28. 资源边界、依赖一致性与 GUI 冒烟 ✅
PowerShell/zip/python3 统一 120s + SIGKILL + 1 MiB 输出，归档先写 staging 再 rename；目录背景的 sharp 读取/编码纳入 4 路信号量；`echarts-wordcloud` 与 ECharts 5.6 对齐；新增 `packaged-gui-smoke.js`（Add Location → Copy Path → Image fullscreen → Text Ctrl+S）；通用整读边界记 [docs/02 §6](./02-file-io.md)。

### P1-29. 依赖安全审计 ✅
直接依赖补丁 + 不带 `--force` 的 18 个传递包升级；完整 `npm audit` 49 → 27 项（0 critical / 17 high），`--omit=dev` 20 → 12。剩余节点只在 Excalidraw/Mermaid 固定传递链与 ECharts 5，理由记 [docs/13 §13](./13-security.md)。

### P1-30. 扩展关闭边界、Lightbox 清理与崩溃日志上界 ✅
扩展多标签在取消关闭/保存失败后恢复此前活动标签、只同步所属 location 的 readOnly、保存失败提示；`media-pan.ts` 返回幂等 disposer（旧 disposer 不能误删新手势）；crash.log 超 1 MiB 轮换为唯一 `crash.log.1`（Windows 先移除旧备份再 rename）；删掉无引用的 png-to-ico/png2icns。

### P1-31. 保存最终一致性与 Draw.io 离线闭环 ✅
ExtensionHost 单点通知写异常、动态 readOnly、15s 无响应、并发保存与 stale ack；Draw.io 只剔无引用资源（138 文件 / 3.0 MB）、patch `PreConfig.js` 修复 viewer/base 被重置为 null 后回退公网 CDN；smoke 清理异常不覆盖原错误，剪贴板只对空或单独 `text/plain` 执行 Copy Path。

### P1-32. 全文提取调度与同目录加载合并 ✅
`buildFulltextIndex` 的非 PDF 提取走 worker 级 `Semaphore(8)`，消除各目录 8 路 walk 的递归叠乘，PDF 仍走 2 路专用闸；thumbnail 以 target path 合并未 settle 的同目录加载，settle 后清 Map、失败传播给全部等待方且下次可重试。

### P1-33. 可复现性能基线与参数停止条件 ✅
新增 `bench-performance.js` / `bench-fulltext-phases.js` / `bench-fulltext-batches.js` / `bench-stats.js`（真实 utilityProcess + renderer→preload IPC）；1000×4KiB cold 1235.5ms / no-op 11.9ms / 1% 增量 21.7ms / 查询 0.57ms，24 目录缩略图 cold 152.7ms / warm 4.3ms；结果不支持扩大驻留，保留生产参数（[docs/15](./15-perf-audit.md)）。

### P1-34. 批量刷新去重与 Draw.io 保存验收 ✅
`IOActionOptions` 分离 `refresh` 与 `treeRefresh`：批量 move/delete 抑制逐项刷新，批后只对成功项的源 parentDir 与移动目标去重刷新；packaged smoke 点真实宿主 Save 后由 Node 轮询磁盘，验证新 label 存在、旧 label 消失、XML 改变且 mtime 不倒退。

### P1-35. 批量失败反馈与自动化可靠性 ✅
`composeBatchNotice` 统一全成功/部分失败/全失败文案（前 3 条 + 五语言 `andMoreFailures`），完整错误数组留给 `console.error`，批量删除带真实成功 count；`refreshTree` 改必填；benchmark 严格拒绝未知参数与缺值、失败也写带时间戳的报告；多目标 sidecar 写改 `allSettled` 后统一刷新并携带 `errors`。

### P1-36. Excalidraw/Mermaid 真实验收与依赖窄覆盖 ✅
新增 `packaged-excalidraw-smoke.js`（canvas 非空像素 → 绑定文本 → 宿主 Save 与磁盘 version/mtime 读回 → 最小 Mermaid flowchart 的 lazy preview 与二次 Save）；只为 chevrotain 的三条依赖边补 `lodash-es 4.18.1` 等最小覆盖，`npm audit` 27 → 21（production 12 → 6），残余风险记 [docs/13](./13-security.md)。

### P1-37. 第 37 轮：五个高收益修复 ✅
关窗 flush 补 `try/finally`（一次写盘失败不再等于每次关窗被 8s `closeFallback` 强杀）；新增 `addMonthsClamped` 修日历翻月跳月（`Date#setMonth` 溢出让 1/31「下个月」跳到 3/3）；Mapique 选区锚点由**下标**改**路径**（tray 重排后 `tray[i].path` 抛 TypeError 崩视图）；`indexStatus` 增 `exists`（db 文件存在即真）替代 `ready = count > 0` 作增量闸门，全文侧加 `meta.fulltext_initialized` 标记；`importExternal` 的 sidecar/缩略图同步空 catch 改 `console.warn`。

### P1-38. 修订恢复可回退 / 单实例锁 / 位置根守卫 ✅
`restoreRevision` 覆盖前先 `backupRevision`（失败即拒绝恢复），对话框加 `danger` 二次确认并显示所选版本时间；`app.requestSingleInstanceLock()` 拿不到锁即 `quit()` 且不注册 `bootstrap`，`second-instance` 只 `restore/show/focus`（否则第二个实例重复注册 IPC、并发写 index.db/wsd.json、抢 MCP 端口）；新增 `assertNotLocationRoot` 接入 delete/rename/move/copy 与 `sidecar:write`（根的 sidecar 会落到 `dirname(root)/.whale/`），`zipDirectory` 保留「打包根」豁免。

### P1-39. 位置只读下推主进程 ✅
`allowed-roots.ts` 增 `readOnlyRoots`/`setReadOnlyRoots`/`isReadOnlyPath`/`assertWritable`，`fs:setAllowedRoots` 收第二参（只接受已认可 root 的子集）；`assertWritable` 接入 fs-write（含 zipEntries、importExternal 目的目录）、meta、extensions、sidecar 的全部写入口，MCP 走同一批函数；`migrateLegacySidecars` 在只读位置直接返回 legacy 标签、不写盘也不改名——此前「只打开看一眼」就会触发迁移写盘。

### P1-40. P1-B 功能缺陷批次 ✅
DirectoryTree 的 `ctxMenu` 增 `isDirectory`（文件行不再出现「新建文件夹/新建文件/打包」，「打开」改走 `openEntryInTab`）；`ingestFiles` 接受 `{complete:false, unreadable}`，只冻结不可读子树、其余照删（此前一个永久 EPERM 目录让删除 pass 永远跳过）；`editState` 键改 `makeTabId(filePath, extensionId)`（同一文件两个扩展不再互清 dirty）；macOS 开终端等真实 `exit` 并带 stderr（Windows `/k` 仍只等 spawn）；新增 `app:update-set-auto-check` 下发；text-editor 同路径外部刷新也重建 undo 历史；html-viewer 关图时剥行内 `style` 的远程引用；FileList 加 `listRef`/`gridRef` 让键盘焦点自动滚动。复核为误报：Gantt 拖拽阈值双计数（两个监听器都按绝对位移、且状态互斥）。

### P1-41. P2 批次（24 条）✅
缩略图渲染层缓存加 `THUMB_CACHE_LIMIT = 800`、ffmpeg 加 10s SIGKILL、复用判据改 `{mtimeMs,size}`；生产构建隐藏 reload/DevTools、bootstrap 失败弹 `showErrorBox`；whale-file 改先 `await fsp.stat`；`shell:openTrash`/`drag:startFile` 错误不再吞；`whale_list_directory` 加 `limit`；`run-tests.cjs` 加 30 分钟上限；`recent` 按 `(path, locationId)` 去重且只记当前 location 下目录；`dateTagDayKey` 认 `week-YYYYMMDD`；扩展 `case 'error'` 走 `notifyApp` 并对 5 条消息补 payload 形状守卫；sidecar 读失败报 `unreadable` issue；新增 `TAG_COLOR_CLEARED` 修「清色被立刻重新染色」；全文索引路径校验绝对路径与重复；Mapique `FitBounds` 比对坐标集合。暂缓：win32 打包入口不走 `commonParentDir`。

### P1-42. P3 批次（6 条）✅
`atomic-write` 的并发键先 `realpath` 再折叠（符号链接/8.3 短名的两条队列会各自 rename 同一 inode）；`restoreRevision` 保留 POSIX `mode`（tmp+rename 会把 `0600` 悄悄放宽）；MCP 会话上限 32、新建前按 `lastSeen` 驱逐最久未用；`SortableHeader` 提到模块作用域（组件体内定义每帧产生新身份）；Mapique 用未过滤 tray 回查路径，被筛选隐藏的 marker 仍可点选；html-viewer 用户 CSS 按 `cssRules` 作用域到 `#content`（`html`/`body`/`:root` 映射，`@media`/`@supports` 递归）。

### P1-43. 无障碍、主题健壮性与选择计数（2026-11）✅
主题：新增 `theme/mode.ts` 的 `isThemeMode` 做唯一校验（只认 11 个自身键，`__proto__` / `constructor` 不算合法），`useResolvedTheme` 对损坏值回落 `{light, whale}`、`migrateAppearance` 归一成 `light` 且只在非法时分配；13 套预设的浅色主色与次要文字压暗到 WCAG AA（`primary` / `textSecondary` 对两个背景均 ≥4.5:1，focus outline 取 `primary` ≥3:1，`presets.test.ts` 逐变体断言）；`ThemeQuickToggle` 切回经典模式显式重置 `whale`。交互：选择计数拆成可见批量目标 + 被筛选隐藏（`SelectionSummary` + 五语言 `nSelectedHidden`，隐藏项永不进批量命令）；PropertiesTray 分隔条补 `role=separator` / `aria-value*` 与 `←`/`→` ±10 px 键盘拖宽；IME 组合期 Enter 语义统一由 `ime-guard.ts` 早退（7 处调用点）；设置页去掉恒显 "Enabled" 文案、快捷键搜索框补名字与主题色 focus ring；图标按钮补 `aria-label`，"新建图表 / 在文件管理器中显示"与重命名失败改走 notice 通道；`html lang` 与绝对日期跟随 `i18n.language`。

---

## 🟡 P2 — 类型逃逸

### P2-1. ECharts 回调集群 ✅
`folderviz.ts` 定义 `EChartsFolderVizNode` 并被三个 `toECharts*` 透传；FolderVizView 走该类型并顺带修掉 `echartsData.size`→`value` 的真 bug（`any` 下拿不到 rootSize）；TagCloudView 补 wordCloud/heatmap 两套 param 类型；CalendarView 用 formatter union。共消除约 26 处生产 `any`。

### P2-2. `DirectoryTree.tsx` 节点类型逃逸 ✅
定义 `TreeFolderNode`/`TreeFileNode`/`TreeNode` 判别联合，`nodes`/`renderFolder`/`renderFile` 全类型化、去掉 3 个 eslint-disable；仅 react-window v2 的 `rowProps` 保留一处 `as any`（库类型 `ExcludeForbiddenKeys` 反向要求 index/style）。

> **类型现状**：`src/shared`、`src/main/ipc`、`allowed-roots.ts`、`shell-quote.ts` 严密；主进程生产代码零 `: any`；`as unknown as` 只出现在 worker 消息与 canvas 互操作边界，范围窄且不暴露不可信输入。全仓零 `@ts-ignore` / `@ts-nocheck`。

---

## 🟡 P3 — 重复模板 & 超大组件（可维护性）

### P3-1. localStorage 读写模板 ✅
FolderVizView 复用 `perspective-prefs.ts` 的 `readPrefs`/`writePrefs`，key、白名单、默认值与「永不抛出」语义不变。

### P3-2. `clampFontSize` 双胞胎 ✅
md-editor 的副本随 0.4.9 删除，只剩 `text-editor/editor-stats.ts` 一份，不需要共享模块。

### P3-3. 超大组件低风险拆分 ✅
FileList 的 visible 标签过滤抽为 `file-list-filter.ts` 纯函数（6 条共置测试）；SettingsDialog 的 `ExtensionsSection` 机械移到独立文件。

### P3-4. extension viewer `getPref/setPref` 拷贝 ✅
`shared/viewer-prefs.ts` 的 `createViewerPrefs(prefix)` 统一 font-viewer / html-viewer 的偏好读写，key 与失败语义不变。

### P3-5. `drawio-editor` iframe 销毁 ✅
`drawio-bridge.ts` 统一清理 XML timer / pending requests / 主题与内部状态，销毁后拒绝新请求；`useWhaleBridge.ts` 提供幂等的 save-handler 注销；`app.tsx` 区分 effect 重跑与真实卸载（刷新不取消已开始的保存）。

### P3-6. 代码清理轮（死导出 / 重复实现）✅
- 删 20 个「声明即唯一出现」的死导出（`KNOWN_LANG_EXTENSIONS`、`WhaleExtApi`、`WORKFLOW_TAGS`、`TAG_OPEN/TAG_CLOSE`、`GanttDragState`、`CuratedThemeMode`、`ThumbWorkerResult`、`RunCommandResult`、`WhaleGlobal`、5 个 `*_STEP` 常量、3 个测试钩子等），`+27/−198`。
- `todayIsoLocal` 7 份组件本地拷贝 → `domain/calendar.ts` 单一实现（`ymd(new Date())`）；`formatBytes` 4 份扩展拷贝 → `extensions/shared/format-bytes.ts`（`RevisionHistoryDialog` 的舍入语义不同，保留）。
- 修 3 处指向已删 `docs/UI.md` 的源码注释指针（→ `docs/10-ui.md` §14）。
- 仍待处理（记录不修）：U+FFFD 破损注释 86 行/16 文件（需人工判断原文）、`MapiqueContextMenu` 自带的 `NoTransition/NoBackdrop` 与 `MenuNoTransition` 重复、`pad2/ymd/addDays` 在 `shared/smart-tags.ts` 与 `domain/calendar.ts` 各一份、6 个死 preload API、未用 locale key、`CalendarView/MapiqueView/FileList` 三个 2000+ 行组件。

---

## ✅ 已记录在 docs、不在本篇重复

| 项 | 出处 |
|---|---|
| 位置级 AES-256-GCM 加密 / 安全审计日志未做；扩展能力「全有或全无」；postMessage `targetOrigin:'*'` 收窄 | [docs/13](./13-security.md) §1/§9/§10、[docs/07 §10](./07-extensions.md) |
| mac 代码签名硬阻塞；Linux DE fallback 链 / 图标 / 递归监听 | [docs/16](./16-cross-platform.md) B-1 / C-2~C-5 |
| `readSidecars` 每目录重读；`extractPdfText` 整 PDF 读内存；`loadFolderThumbnail` 无 LRU | [docs/15](./15-perf-audit.md) P2-1/P3-1 |
| macOS notarization 阻塞自动更新 | [docs/18](./18-auto-update.md) |
| Mapique 地名搜索已尝试并回退（勿照原样重试） | [docs/05 §9](./05-perspectives.md) |

---

## 已接受的取舍

| 项 | 出处 | 理由 |
|---|---|---|
| 抽 `execFileBuffer` / `onUtilityProcessError` 消除主进程 `as unknown as` | 本篇 P2-2（2026-07-28 评估） | 会牵连 ffmpeg 的 ~1s 超时 fallback 重试路径，风险 > 收益；helper 只能消 2 处 cast，ROI 低 |
