← 返回 [plan.md](../plan.md)

# 19 · 代码质量审计与改进清单

> **2026-07-28** 的代码质量审计追踪清单(plan.md §F「不做未来计划」的**经确认例外**,同 [docs/15](./15-perf-audit.md) / [docs/16](./16-cross-platform.md))。每项完成后压成 1–2 行 ✅(保留「做了什么 + 关键坑」);评估**不做**的移到文末「已接受的取舍」。
>
> **审计方法**:6 维度并行静态扫描 —— ① 已知问题汇总(避免重复 docs/09/15/16)② 代码异味 ③ 类型安全 ④ 测试覆盖缺口 ⑤ 错误处理/异步 ⑥ working tree diff 审查。生产路径几乎无 `TODO/FIXME/HACK` 标记。
>
> **范围与边界**:本篇聚焦**正确性 bug + 测试缺口 + 类型/可维护性**;**不重复** [docs/09](./09-known-issues.md)(已知坑主档)、[docs/13](./13-security.md)(安全模型/不在范围)、[docs/15](./15-perf-audit.md)(性能)、[docs/16](./16-cross-platform.md)(跨平台)。
>
> **归档**:0.4.9 瘦身移除的 md-editor / AI 助手 / archive 模块,其专属审计项(路径大小写归一、`maxTurns` clamp、`secretStore` 加密往返、Zip Slip 防线)已随代码删除,仅在本节保留一句结论。

---

## 🔴 P0 — 真实正确性 bug

### P0-1. redux-persist 落盘跳过 `datasync` ✅
[persist-storage.ts](../src/main/persist-storage.ts) 的 `persistWrite` 曾手写 `fsp.writeFile(tmp) + fsp.rename`,既无 `fd.datasync()` 也无 [atomic-write.ts](../src/main/atomic-write.ts) 的 `pid+counter` 唯一 tmp 名 —— 同仓 sidecar/index/thumbnail 都走 `atomicWriteJson/Bytes`,唯独这条最敏感的 settings 写是半成品。**已修**:改调共享 `atomicWriteText`(同款 datasync + 唯一 tmp),顺手删 dead `tmpPathForKey`。故障类背景见 [docs/02 §8](./02-file-io.md)。

> ✅ md-editor `computeOrphanImages` 路径大小写归一(Windows/macOS 误删已引用图片)、AI `maxTurns` clamp 错位 + 两处 `buildSnapshot` 重复 —— 均已于 2026-07-28 修复,随后**随模块删除归档**。

---

## 🟠 P1 — 安全 / 数据模块零测试(回归保险)

审计时整个 `src/main/ipc` 仅 1 个源文件有测试;下列各项现已补齐测试或确认已有覆盖。

### P1-1. `fs-write.ts` — 数据丢失 + 路径遍历 ✅
[fs-write.ts](../src/main/ipc/fs-write.ts) 文件头契约「失败必 reject,绝不让 renderer 把失败的 IO 当成功」。现用 [ipc.test.ts](../src/main/ipc.test.ts) 的 IPC rig 覆盖写侧:rename 的源/目标越界拒绝、目标已存在不静默覆盖、源缺失时必 reject(不假成功)、mkdir 越界+正常;读侧越界在同文件 `read-side allowedRoots guards`,`assertWithinAllowedRoot` 本身在 [allowed-roots.test.ts](../src/main/allowed-roots.test.ts)。

### P1-2. `migrate-date-tags.ts` — 一次性全库迁移 ✅
[migrate-date-tags.ts](../src/main/migrate-date-tags.ts) + [migrate-date-tags.test.ts](../src/main/migrate-date-tags.test.ts) 覆盖纯函数变换、备份/幂等、wsm、损坏 JSON 不覆写与 startup once-guard；`migrateIfPresent` 只把 ENOENT 视为不存在，其它 access 错误进入 `errors` 与 `totalErrors`，两个 migrator 继续各自捕获并上报 IO/JSON 错误，不再被外层 `.catch(() => null)` 静默吞掉。

### P1-3. `dir-lock.ts` — 并发互斥锁 ✅
[dir-lock.ts](../src/main/dir-lock.ts) + [dir-lock.test.ts](../src/main/dir-lock.test.ts):同 key 串行(并发高水位 = 1)、不同 key 并行、**拒绝隔离**(reject 任务不污染后续队列)、返回值/拒绝传播、长链保序、drain 后再 lock 仍工作。`chains` Map 的有界性是内部不变性(未 export),靠行为测试兜底。

### P1-4. `shell-quote.test.ts` — 注入唯一防线 ✅
[shell-quote.test.ts](../src/main/shell-quote.test.ts) 的「adversarial inputs」describe:POSIX 下分号/与号/管道/$/反引号/圆括号/重定向等元字符在单引号内原样、CJK 路径、换行与控制符、NUL、单引号 close-reopen(中和 `';echo pwned`);Windows 下 `%VAR%` 加引号但 `%` 原样(锁定「真正的 % 防护在上游」契约)、各元字符触发引号、CJK+空格、换行。

> ✅ `ipc/extensions.ts` 的归档 Zip Slip 防线(`isSafeEntryPath` 的 `..` 深度检查)与 `secretStore` 加密往返测试 —— 均随 archive.ts / AI 助手模块于 0.4.9 删除归档。

### P1-5. 2026-11 可靠性批次 ✅
- 缩略图目录入口、六个索引/全文读入口与 `ext:listRevisions` 均补 allowedRoots 校验；修订清理拒绝非有限或负天数。原生选择器的外部 source 仍可读取，但目录封面/背景只写目标 `.whale/`，并复用图片、SVG、视频、PDF、字体现有编码后端；菜单失败统一提示且不清缓存。`ipc/boundary-guards.test.ts` 22 用例验证越界/非法输入在底层调用前拒绝，合法参数照常透传。
- 原子写 stale tmp 只匹配精确 `<pid>.<counter>.tmp` 后缀，不再误扫同名前缀目标；`createTextFile` 用 `flag:'wx'` 消除 TOCTOU。文件/全文索引重建期间的新变化以 dirty 标记再 debounce 一次；两个 worker host 捕获 child 并在 postMessage 失败时 reject + 清 pending。相关并发、watcher 与 worker race 回归全过。

### P1-6. sidecar 损坏显式恢复 ✅
detailed read 保留健康目录数据并报告 corrupt/unreadable；非法 JSON 与结构均可恢复，IO 错误不可恢复。仅在用户确认后按 SHA-256 指纹、allowedRoots 与目录锁执行：排他备份原字节、合并可读 legacy 标签后原子写有效聚合；冲突/非损坏/失败均不覆盖原件，legacy 文件不动。lat/lng 迁移使用锁内最新 map，空聚合删除失败上抛。Provider、FileList 持久 warning、确认/取消、只读限制、备份定位及五语言已接线并各有回归测试。

### P1-7. MCP 传输/配置/生命周期与自动更新零测试 ✅
本轮补的是 0.5.0 时代两块"新、无回归网、且直接决定安全与可用性"的代码：
- [mcp-http.ts](../src/main/mcp/mcp-http.ts)：端点由 `startsWith('/mcp')` 改为**精确** `/mcp`、`/mcp/`（前缀路径 404）；未知/过期会话从 400 改为 404（协议语义为重新 initialize）；请求体按 UTF-8 字节数限 4 MiB，超限回 413 并在响应后 drain，不再中途 `req.destroy()` 让客户端只看到连接重置；会话增加 `lastSeen` 与 `unref()` 的 idle sweeper（默认 30 min 回收，`sessionIdleMs=0` 关闭），initialize 失败清理刚注册的半成品，`close()` 统一关 transport+server。
- [mcp-server.ts](../src/main/mcp/mcp-server.ts)：监听成功后才发布 `core`/`httpServer`/`boundPort`，绑定失败不再泄漏半个 core；停止时先 `server.close()` 再在同一 Promise 内 `closeAllConnections()`，keep-alive 客户端无法再吊住设置开关或 `before-quit`；启动/停止异常只记日志，不 reject IPC。
- [mcp-config.ts](../src/main/mcp/mcp-config.ts)：`normalizeMcpConfig()` 对非对象 JSON（`null`/数组/标量，此前会在 bootstrap 抛 TypeError）、越界端口、坏 token 做归一；损坏文件带日志回退而非静默换 token；写入串行化，避免后发的设置被先发起的落盘覆盖。
- [auto-update.ts](../src/main/auto-update.ts)：`downloadUpdate()` 增加 in-flight 共享 Promise（双击不再把 electron-updater 的 "download already in progress" 冒成错误提示），`quitAndInstall()` 加 try/catch（下载未完成时该调用是**同步抛**，未捕获会逃出 IPC listener——主进程没有 `uncaughtException` 兜底）。
- 回归网：新增 [mcp-config.test.ts](../src/main/mcp/mcp-config.test.ts)（12 用例：归一化矩阵 + 读写往返 + 无 `.tmp` 残留）、[mcp-server.test.ts](../src/main/mcp/mcp-server.test.ts)（6 用例：启停、端口回退、只读开关、keep-alive 下 <3s 停止、并发开关串行化）、[auto-update.test.ts](../src/main/auto-update.test.ts)（18 用例：feed 接线、release notes 归一、并发 check/download 去重、事件隔离、quit 守卫、dev-mode 短路、启动探测）；[mcp-http.test.ts](../src/main/mcp/mcp-http.test.ts) 扩到 22 用例（前缀/未知会话 404、413、闲置回收）。

### P1-8. MCP 工具面守卫与并发写原子性 ✅
传输/生命周期就位后，审计转向工具面本身——这里每一条都直接落在用户数据上：
- **静默覆盖（真 bug）**：[fs-write.ts](../src/main/ipc/fs-write.ts) 的 `renameEntry`/`moveEntry`/`copyEntry` 原本是 `existsSync(dest)` 通过后再 `rename`/`cp`；MCP 只在**单次调用内**串行 items，跨调用（客户端并行发 `whale_move_files`）两个请求都能通过检查，落败者被静默替换——与工具描述"Never overwrites"矛盾。现以目标目录为键 `withLock` 包住「检查 + 写入」，并把 `cp` 改成 `force:false + errorOnExist`（`force` 默认 true 时 Node 会忽略 `errorOnExist`，EXDEV 回退此前正因此失效）；sidecar/缩略图同步留在锁外，避免嵌套锁。
- **root 不是条目**：[allowed-roots.ts](../src/main/allowed-roots.ts) 新增 `isConfiguredRoot()`；[mcp-tools.ts](../src/main/mcp/mcp-tools.ts) 用 `assertNotLocationRoot()` 拒绝把配置的 root 本身作为打标 / 写描述 / move / copy / delete 目标。审计确认：对 root 打标会让 `.whale/` 落到边界**上一层目录**（`updateFileTags`/`mutateSidecar` 用 `dirname(filePath)`），而对 root 删除只值一个泛化审批对话框。
- **只读是两道闸**：`whale_build_fulltext` 会写正文索引，补 `ensureWritable()`；`approve()` 在最长 60s 的审批等待返回后**再查一次**只读（等待期间打开只读，已点过的"允许"不能放行）；`applyMcpConfigChange('readOnly', true)` 立即 `denyAllPending()`，无效对话框不再挂 60s。
- **不骗客户端**：`whale_read_text` 先 `stat()`，非文件或 >16 MiB 直接报错并指向有 2 MB/200 KB 上限的 `whale_extract_text`（原本整文件 `readFile` 再切片，多 GB 日志可打爆主进程）；批量工具整批全失败时结果带 `isError`（`batchResult`），不再"成功外壳 + errors 数组"；`whale_roots` 的索引 worker 失败改为返回 `error` 字段而非伪造成空位置；`whale_create_text_file` 的 `bytes` 改用 `Buffer.byteLength(..., 'utf8')`（`content.length` 数的是 UTF-16 码元）。
- 回归网：[mcp-http.test.ts](../src/main/mcp/mcp-http.test.ts) 新增 "tool guards" 组，用**真实配置的 root** 端到端覆盖只读拒绝、root 守卫（含父目录无 `.whale` 断言）、root 内正常打标、目录拒绝读；[allowed-roots.test.ts](../src/main/allowed-roots.test.ts) 补 `isConfiguredRoot` 的归一化匹配；[fs-write.test.ts](../src/main/ipc/fs-write.test.ts) 用两个并发 copy/move 抢同一目标名，证明只有一个成功且既有目标字节不变。

### P1-9. 读-改-写把「读失败」当空 → 静默清空元数据 ✅
第三轮针对错误处理的审计发现：最危险的数据丢失不在删除路径，而在**读-改-写**——宽松读取把损坏/不可读当成"空"，下一次单字段合并就把整份文件重写成只剩那一个字段。
- **folder-meta / tag-library（真 bug，最高风险）**：[folder-meta.ts](../src/main/folder-meta.ts) 的 `writeFolderMeta` 与 [tag-library.ts](../src/main/tag-library.ts) 的两个 setter 原本用 `readFolderMeta` / `readTagLibrary` 取合并基底；这两个函数对缺失、损坏、IO 错误一律返回 `{}`。于是一次改颜色会把该目录的 tags / description / perspective / entrySize 全部抹掉，一次改 tag 描述会丢掉其余所有 tag 描述。现写入路径改用 [merge-read.ts](../src/main/merge-read.ts) 的 `readJsonForMerge`：缺失 → `null` 从空开始；损坏或外形不符 → 把原文件**隔离**为同目录 `<name>.corrupt-<时间戳>`（字节原样保留、日志 warning）后再从空开始；非 ENOENT 的 IO 错误直接上抛。展示读取保持宽松（只读不写）。
- **legacy 迁移（真 bug，一次性不可逆）**：[sidecar.ts](../src/main/sidecar.ts) 的 `readLegacySidecars` 原本对非法 JSON `continue` 跳过，`migrateLegacySidecars` 却 `rm` 掉**所有** `legacy.paths`——坏文件里的标签永久丢失且源文件被删。现快照拆成 `{files, paths, corrupt}`：只删确实解析成功的路径，坏文件重命名为 `<name>.json.corrupt-<时间戳>`（改名后不再匹配 `.json` 扫描，迁移不会重跑），重命名失败则保留原地并告警。
- **purge 不能假成功**：[persist-storage.ts](../src/main/persist-storage.ts) 的 `persistDelete` 原先把非 ENOENT 错误记录后 resolve，redux-persist 以为清除成功，旧状态下次启动复活。现只把 `ENOENT` 当正常，其余记录后**重新抛出**。
- **索引失败要自愈**：[dir-watcher.ts](../src/main/dir-watcher.ts) 的 `reindexIfBuilt` / `reindexFulltextIfBuilt` 原本 catch 后丢弃，注释称"下次变更重试"，但 dirty 只在重建期间来事件时才置位——空闲目录一次失败后索引会一直陈旧。现失败时置 dirty，并按 1.5s 起、逐次翻倍、上限 60s 退避自动重试；成功或索引不存在时清零计数（fulltext 同规则，per-root 计数）。
- 回归网：新增 [merge-read.test.ts](../src/main/merge-read.test.ts)（5 例：缺失/正常/坏 JSON/外形不符/IO 错误上抛与字节保留）、[tag-library.test.ts](../src/main/tag-library.test.ts)（3 例：往返/合并不丢/损坏隔离）、[persist-storage.test.ts](../src/main/persist-storage.test.ts)（2 例：往返与 ENOENT、不可删除时 reject）；[folder-meta.test.ts](../src/main/folder-meta.test.ts) 补损坏隔离用例；[sidecar.test.ts](../src/main/sidecar.test.ts) 补"坏 legacy 永不删除"用例；[dir-watcher.test.ts](../src/main/dir-watcher.test.ts) 补"静默 root 失败后退避重试一次"用例。
- **后续（已收口）**：渲染层 15 处失败不可见、`mcp-config` 持久化失败只记录不报（已改为向 IPC 调用方上抛）不再是遗留项——渲染层部分见下一条 P1-10。

### P1-10. 渲染层 15 处「失败不可见」 ✅
第四轮针对错误展示的审计：这些不是数据丢失，而是**同一种谎**——把失败渲染成"空/没变化/成功"，用户既不知道发生了错误，也没有重试入口。约定：变更类失败 → 组件自己的 Snackbar/Alert（带真实 message）；后台维护失败 → 带 tag 的 `console.warn`（不可操作、不该弹 toast）；列表类失败 → 清掉旧数据 + 错误态 + Retry，**绝不保留上一次的结果冒充本次**。
- **新增两个共享件**：[errors.ts](../src/renderer/services/errors.ts) 的 `errorMessage(unknown)`（Error / string / 其他值统一取值）；[app-notice.ts](../src/renderer/services/app-notice.ts) + [AppNoticeHost.tsx](../src/renderer/components/AppNoticeHost.tsx)（挂在 Root，仅供没有本地 Snackbar 的 sidebar action bar / 启动维护等用；listener 抛错被隔离，避免把已处理的 IPC 失败重新变成 unhandled rejection）。
- **打标是最常走的写路径**：[PropertiesTray.tsx](../src/renderer/components/PropertiesTray.tsx) 的 `useTagActions` 新增 `onError`，`applyToTargets` 包 try/catch——快捷打标行仍是 `void tagActions.x()`，但失败不再变成未处理 rejection；[EntryContextMenu.tsx](../src/renderer/components/EntryContextMenu.tsx) 的周期标签保存、单条/批量移除标签全部接 `showError`（FileList 传入它的 snackbar）；`FileList` 的回收站打开与"定位备份文件"也不再 `.catch(() => undefined)`。
- **搜索失败绝不保留旧结果**：[SearchBar.tsx](../src/renderer/components/SearchBar.tsx) 的 `runSearch` 在内容/索引两种模式下都先清空结果再记错误，popover 显示错误 Alert + Retry；[AdvancedSearchDialog.tsx](../src/renderer/components/AdvancedSearchDialog.tsx) 失败时 `results=null`（原先保留上一查询的行），同样给错误条与 Retry。
- **目录加载失败不再显示成空目录**：[DirectoryTree.tsx](../src/renderer/components/DirectoryTree.tsx) 的 `loadChildren` 失败改为按路径记入 `childrenError`（旧代码缓存 `[]`，既像空目录又永不重试），`buildTreeRows` 在展开节点下补一行错误行（caption `folderLoadFailed`、tooltip 真实错误、Retry 调 `reloadChildren`）。行展开规则抽到 [directory-tree-rows.ts](../src/renderer/domain/directory-tree-rows.ts)，不用挂载虚拟列表即可单测。
- **其余点位**：[McpSection.tsx](../src/renderer/components/McpSection.tsx)（开关失败不再静默回弹，Alert 显示原因）、[RevisionHistoryDialog.tsx](../src/renderer/components/RevisionHistoryDialog.tsx)（列表失败不再显示"没有历史版本"、删除失败不再 `// ignore`、restore 的阻塞 `alert()` 一并换掉）、[AddLocationDialog.tsx](../src/renderer/components/AddLocationDialog.tsx)（原生选择器失败不再等同于"用户取消"）、[SettingsDialog.tsx](../src/renderer/components/SettingsDialog.tsx)（`hasFulltextIndex` 探测失败显示 error 行而不是 unbuilt）、[ExtensionContextProvider.tsx](../src/renderer/hooks/ExtensionContextProvider.tsx)（外部改动重载失败带 tag 记录）、[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx)（reveal 失败进既有 notice）、[TitleBar.tsx](../src/renderer/components/TitleBar.tsx)（窗口状态探测/窗口命令失败带 tag 记录）、[Sidebar.tsx](../src/renderer/components/Sidebar.tsx) 与 [Root.tsx](../src/renderer/containers/Root.tsx)（回收站打开、fulltext 路径同步、启动清理，分别走 AppNotice / 带 tag 日志）。
- 回归网：新增 [directory-tree-rows.test.ts](../src/renderer/domain/directory-tree-rows.test.ts)（5 例：折叠/展开/纯失败无缓存/失败但有缓存时错误行追加/隐藏文件仍保留错误行）、[app-notice.test.ts](../src/renderer/services/app-notice.test.ts)（4 例：默认 severity、显式 severity 与递增 id、退订、listener 抛错隔离）、[errors.test.ts](../src/renderer/services/errors.test.ts)（4 例）。

### P1-11. 审计遗留项收尾（审批队列 / 退出等待 / 跨目录打包）✅
第五轮把前两轮审计里"记录在案但未做"的条目清掉：
- **审批一次只弹一条**：[mcp-approval.ts](../src/main/mcp/mcp-approval.ts) 改为 FIFO 队列，只有队首被广播并开始 60s 计时；队首结算后才提升下一条并给它盖 `expiresAt`。旧实现第二条请求在看不见的队列里烧完超时，用户从未见过的对话框被自动拒绝；`denyAllPending()` 直接清空队列（退出时不会趁机弹出下一条），`pendingApprovals()` 只返回队首，队列上限 `MAX_PENDING_APPROVALS = 8` 超出立即 fail-closed，广播抛错（窗口已销毁）也 fail-closed。
- **退出等待 MCP 关闭**：[main.ts](../src/main/main.ts) 的 `before-quit` 现在 `await` `shutdownMcpServer()`（上限 2s，失败只记录）再 `app.quit()`——否则端口仍可接受工具调用，而窗口已经关闭。
- **跨目录打包**：[fs-write.ts](../src/main/ipc/fs-write.ts) 新增 `commonParentDir`，POSIX 的 `zip -r` 从所有源的最近公共父目录执行；旧实现固定 `cwd: dirname(sources[0])` 且每个源只传 basename，多选跨目录时其余源被静默丢弃/重复。Windows 分支同时改用 `path.resolve` 后的归档路径。
- **删除后的元数据清理与修订清理不再静默**：`deletePath` 的 sidecar / thumbnail / scan-cache 清理失败、[revisions.ts](../src/main/revisions.ts) 的目录不可读 / 删过期修订失败都改为带 tag 的 `console.warn`（删除本身已成功，不能因此回滚；但残留 sidecar 会让已删路径的标签在下次扫描时"复活"）。
- 回归网：[mcp-approval.test.ts](../src/main/mcp/mcp-approval.test.ts) 扩到 9 例（新增只广播队首、队首结算后提升、排队不烧超时、队列满立即拒绝、退出不提升下一条）；[fs-write.test.ts](../src/main/ipc/fs-write.test.ts) 新增 `commonParentDir` 4 例（兄弟目录、跨目录、单源与相对路径、空选择）。

### P1-12. 全文索引：读取失败不再删行 + PDF 内存上限 ✅
第六轮补上最后一条零测试的 main 数据路径（[fulltext.ts](../src/main/fulltext.ts)，11.5KB，此前无测试）：
- **瞬时读取失败不该清空搜索内容**：旧 `buildFulltextIndex` 把"这次没看到"一律当成"文件已删除"，遍历中打不开的目录、stat 失败的条目、读文件失败的文本都会让既有行进入 `removed` 并被 `deleteFulltextPaths` 删掉——一次权限抖动就把整棵子树的全文索引清空，直到下一次成功重建。现在遍历把不可读的目录 / 条目、超过 `MAX_PDF_BYTES` 的 PDF 记入 `skipped`，删除集合改由纯函数 `selectRemoved(prior, seen, skipped)` 计算：跳过路径按路径边界豁免（`a/b` 覆盖 `a/b/c`，不覆盖 `a/bc`；`''` = 根目录不可读 → 一条都不删），旧行保持"陈旧但可搜索"。
- **读失败与空文件分离**：`readCapped` 曾把 stream error 也 resolve 成 `''`，无法区分"空文件"（确实无内容，应删行）与"读失败"（学到了零信息，应留行）。改为 `readCappedText(): { ok, text }` + `extractTextDetailed(): { text, unreadable }`，`extractText` 保留 `string|null` 公共签名（MCP 工具不受影响）。
- **PDF 内存上限**：`extractPdfText` 用 `fsp.readFile` 整读，`docs/15` P3-1 把它列为"已接受的取舍"。现在 `MAX_PDF_BYTES = 128 MiB`，超限在读取前返回 `unreadable`（保留旧行 + 警告），`whale_extract_text` 对超限 PDF 返回明确错误而不是"no extractable text"；`docs/15` 的 Tier 3 由此全部闭环。
- 回归网：新增 [fulltext.test.ts](../src/main/fulltext.test.ts) 10 例——文本/HTML 抽取（空白折叠、实体、标签剥离）、超限 PDF 在读之前被拒（1 字节文件 + 伪造的 size 证明没走 `readFile`）、缺失 PDF 报 `unreadable` 而不是抛出、空文件与读失败分离（`unreadable` 标志）、构建只索引支持的扩展名、改动/删除文件的增量 delta、无变化重建保留行，以及 `selectRemoved` 的前缀边界 / 根不可读 / 豁免三种情况。
- 评估未做：把 `walk` 的"每目录 8 并发"改成全局信号量。当前实现每层最多 8 个并发任务，深/宽目录树的理论放大没有实测证据，改动会打乱进度语义且收益不明确，先记录不执行。

### P1-13. Linux 无递归监听 → per-dir 递归兜底 ✅
第七轮关掉 [docs/16](./16-cross-platform.md) C-5：Linux 的 `fs.watch` 不支持 `recursive: true`，此前该 root 直接回落手动刷新，外部改动既不会出现在文件区、也不会进索引。现在 recursive 创建失败即切 per-dir（[dir-watcher.ts](../src/main/dir-watcher.ts)）：
- 启动遍历目录树、每个文件夹挂一个 `fs.watch`；`rename` 事件上 `stat` 目标——新目录 `attachDirTree` 补挂（含同一调用里建出的嵌套子目录），消失的目录 `detachTree` 释放其下全部 watcher（否则每删一个目录泄漏一个 watcher）。
- 事件路径 = 被监听目录 + filename 再换算回 root 相对路径；Windows 在删除被监听目录时会回调**绝对路径**（含 `\\?\C:\...` 扩展前缀），必须按绝对路径处理，直接 `path.join(dir, filename)` 会产生 `a/b/?/C:/...` 这种垃圾路径（实际测试先失败在这里）。
- `.whale` 不下降（自写回声），`node_modules` / `.git` 也不下降（inotify 默认 watch 预算是每用户 ~8k）；总 watcher 数上限 `MAX_DIR_WATCHERS = 4096`，到顶只警告一次，深层目录退化为手动刷新。
- 平台无回归：Windows/macOS 仍走 single recursive watcher；测试通过 `_startWatchForcedPerDirForTest` 在任意平台强制 per-dir 路径——[dir-watcher.test.ts](../src/main/dir-watcher.test.ts) 新增 1 例（嵌套目录、新建子树补挂、删除子树释放、排除树零事件），其余 9 例继续覆盖广播/抑制/退避/fulltext。

### P1-14. Linux 桌面 fallback：终端 / reveal / 打包 ✅
第八轮收掉 [docs/16](./16-cross-platform.md) C-2 的三项欠账。共同点不是崩溃，而是**在真实桌面上悄悄什么都不发生**，且都长期被写成「已知限制」：
- **终端**：[shell-command.ts](../src/main/shell-command.ts) 之前只 `spawn('xterm')` 且把 spawn 失败吞掉，GNOME / KDE / Cinnamon 默认没有 xterm，右键「用户命令」等于点了没反应。新增 [desktop-linux.ts](../src/main/desktop-linux.ts) 的 `linuxTerminalCandidates`（`$TERMINAL` → `x-terminal-emulator` → gnome-terminal / konsole / xfce4-terminal / tilix / kitty / alacritty → xterm，各自的 argv 形状不同），`launchLinuxTerminal` 必须等到 `spawn` 事件才算成功——ENOENT 是异步事件，看 `spawn()` 返回值会把失败当成功；全失败才抛错，渲染层现有 catch 会显示真实原因。
- **reveal**：[shell.ts](../src/main/ipc/shell.ts) 的 Linux 分支改为按 `linuxRevealSteps` 顺序尝试：D-Bus `org.freedesktop.FileManager1.ShowItems`（让运行中的文件管理器选中，路径转 file URI）→ `nautilus --select` → `dolphin --select` → `xdg-open` 父目录。缺失/非零退出一律跳过并记录，只有全失败才报错。
- **打包**：[fs-write.ts](../src/main/ipc/fs-write.ts) 的 POSIX `runOsZip` 在 `zip` 报 ENOENT 时退回 `python3` + 内置 `zipfile` 脚本；`pythonZipPairs` 沿用 `commonParentDir` 的相对布局（跨目录选择不会塌成 basename），唯一差异是空目录不入包。
- 回归网：[desktop-linux.test.ts](../src/main/desktop-linux.test.ts) 8 例——候选顺序/argv 形状、缺 `$TERMINAL` 时的首位、逐个跳过 ENOENT 并返回第一个真正起来的终端、全失败错误清单、D-Bus URI 编码与父目录步骤、跨目录相对路径映射。桌面相关知识与执行分离后，这些用例在 Windows CI 上也能跑。

### P1-15. 崩溃不可恢复：渲染进程白屏 / 主进程静默退出 ✅
第九轮处理两类「应用死了但用户不知道为什么」的路径。此前全仓没有 `render-process-gone` 监听、也没有 `process.on('uncaughtException')`（只有 `unhandledRejection` 日志），策略抽到 [crash-guard.ts](../src/main/crash-guard.ts) 便于无 Electron 环境单测：
- **渲染进程崩溃不再永久白屏**：[main.ts](../src/main/main.ts) 的 `attachRendererCrashGuard` 监听 `webContents.on('render-process-gone')`。`clean-exit`（正常关窗/退出）不动作；其余原因按 `planReload` 在 60 秒窗口内自动 reload 最多 2 次，超窗重置预算（避免「崩一次就永远弹窗」）。预算用尽弹 `Restart interface / Quit` 原生框，Restart 重置预算并 reload，Quit 退出；窗口已销毁或弹框抛错时直接退出，不 reload 一个不存在的窗口（否则会陷进 crash/reload 循环）。
- **主进程致命异常有痕迹、有退出**：`uncaughtException` → `handleFatalError`：`console.error` → 尽力追加 `<userData>/crash.log` → `dialog.showErrorBox` → `app.exit(1)`。三步各自 try/catch：用户目录不可用或窗口服务器已消失时仍必须退出，否则半死进程占着单实例锁，用户重开也起不来。
- **崩溃日志**：`formatCrashEntry` 生成 `[ISO] renderer|main crash: <详情>`，main 侧带完整 stack；`appendCrashLog` 首次写入自动建目录、只追加。写日志失败只吞掉——处理崩溃的路径自己再抛异常，会把一次崩溃变成无响应进程。
- 回归网：[crash-guard.test.ts](../src/main/crash-guard.test.ts) 11 例——reload 预算递增、恰好 60 秒仍在窗口内、超窗重置、`clean-exit` 不动状态、日志 ISO 格式与追加不截断、致命路径调用顺序（`log → append → box → exit`）、日志与弹窗同时失败仍 `exit(1)`、非 `Error` 抛出值。
- 评估未做：`indexer.ts` 的「sidecar 读失败仍写入无标签行」保持原样——文件仍可搜索（只是暂时没有标签），改成跳过会让它在索引里消失，是更差的结果；`index-worker-host` 崩溃已有 pending 拒绝 + 懒重启，`LocationIndexContextProvider` 轮询能恢复，无需再包一层。

### P1-16. 渲染层启动失败 / 全局错误：白屏且无痕迹 ✅
第十轮补上第九轮没覆盖的一半：崩溃进程有策略了，但**渲染层自身的致命错误**——`Root` 渲染期抛错、`PersistGate` 卡在 rehydrate、React 之外的异步错误——仍然只会留一个白窗口和 DevTools 里一行字。错误边界（`ErrorBoundary`）只包住 root 之下的渲染错误，而且它的 `componentDidCatch` 只 `console.error`，`crash.log` 里什么也没有。
- **全局监听 + 启动看门狗**：新增 [boot-guard.ts](../src/renderer/services/boot-guard.ts)，在 [index.tsx](../src/renderer/index.tsx) 的 `createRoot` 之前安装 `window` 的 `error` / `unhandledrejection` 监听；`BootReady` 组件挂载后调用 `markReady()`。`markReady` 之前出错、或 15 秒（`BOOT_WATCHDOG_MS`）仍未就绪，就盖一层**纯 DOM** 的恢复界面（inline style，不碰 React/MUI/i18n/theme——出错的可能正是它们），给原因和 `Reload / 重载`；就绪之后的错误只上报，不再遮界面。
- **同一份 crash.log**：新增 preload API `reportRendererError` → IPC `app:report-renderer-error`；主进程用 `sanitizeErrorDetail` 归一（任意 IPC 载荷转字符串、去控制字符、保留换行以留 stack、上限 4000 字符）后写入 `<userData>/crash.log`。首屏白屏的用户报告从此有可诊断的落点。
- **限流**：滑窗每分钟最多 20 条（`MAX_REPORTS_PER_MINUTE`），渲染进程进入错误循环时不会把日志刷爆；`reportRendererError` 自身失败只吞掉（诊断路径不允许制造新的未捕获异常）。
- **错误边界也走这条通道**：`ErrorBoundary.componentDidCatch` 除 `console.error` 外，把 `error.stack + componentStack` 上报；`window.whale` 缺失（preload 已拆）时静默跳过。
- 回归网：[boot-guard.test.ts](../src/renderer/services/boot-guard.test.ts) 18 例（jsdom）——错误详情归一、限流与窗口回填、覆盖层内容 / Reload / 幂等 / 移除、就绪前后两种上报行为、看门狗触发与 `markReady` 取消、`dispose`；[crash-guard.test.ts](../src/main/crash-guard.test.ts) 新增 4 例覆盖 `sanitizeErrorDetail`。
- 评估未做：把恢复界面做成带「Open crash log / Quit」的完整面板（需要主进程暴露日志路径与新 IPC，收益不如直接 reload 明确）；把 `window.onerror` 的 report 也写进 redux 便于设置页展示（会依赖可能已损坏的 store）。

### P1-17. MCP bearer token 明文落盘 ✅
本地 MCP 服务器只监听 `127.0.0.1`，但 token 本身此前是 `mcp-config.json` 里的明文——任何能读该文件的进程（或一次备份、一次同步目录外泄）都能完整冒充客户端：读工具（`whale_search` / `whale_read_text` / `whale_extract_text` / `whale_roots`）不需要审批，等于拿到全部已授权位置的读取权。
- **加密落盘**：[mcp-config.ts](../src/main/mcp/mcp-config.ts) 的持久化文档新增 `tokenStorage` 与 `tokenEncrypted` 两个字段；有可用密钥库时用 Electron `safeStorage.encryptString` 加密后 base64 落盘，文件里不再出现明文 `token`。
- **回退链**：加密不可用（无密钥库）→ 写明文并标 `tokenStorage: "plain"`；密文读不出来（换机、密钥库重置、后端切换）→ 先退回同一文件里的明文 token，两者都没有才开始新 token 并在日志里说明（此时旧客户端会 401）；旧版明文配置在下一次写入时自动迁移为加密形态。
- **边界**：Linux 无 keyring 时 Electron 走 `basic_text` 后端，`isEncryptionAvailable()` 仍为真——那里的"加密"只有混淆强度，不是真正的密钥保护；`safeStorage` 只能在 app ready 之后用，`loadMcpConfig()` 由 `initMcpServer()` 在 `bootstrap()` 内调用，顺序满足。
- 回归网：[mcp-config.test.ts](../src/main/mcp/mcp-config.test.ts) 16 例，新增 5 例覆盖「旧明文自动迁移并加解密往返」「无密钥库回退明文」「密文损坏时退回同文件明文」「密文与明文都不可用时重新生成」「纯函数 `normalizeMcpConfig(doc, cipher)` 解密路径」；测试用注入的 `TokenCipher`（`__setTokenCipherForTest` / `__resetMcpConfigForTest`），不依赖真实平台密钥库。

### P1-18. MCP 审批弹窗：作答未经确认就消失，失败等于工具被静默挂起 ✅
审批闸本身是 fail-closed 的，但弹窗这一侧此前是**乐观移除**：[McpApprovalDialog.tsx](../src/renderer/components/McpApprovalDialog.tsx) 在点击"允许/拒绝"的瞬间就把请求从列表里删掉，然后 `mcpResolveApproval(...).catch(() => undefined)` 吞掉失败。IPC 一旦失败，用户以为已经答复、界面也消失了，而主进程的队列里请求还在——外部 AI 客户端的工具调用要一直等到 60 秒超时才被自动拒绝，期间既没有弹窗也没有任何提示。
- **作答要等主进程确认**：`mcpResolveApproval` 的返回值从 `{ ok: true }` 扩成 `{ ok: true, settled: boolean }`（主进程 `resolveApproval` 现在返回"是否真的结算了"）。`settled: true` 才关闭弹窗；`settled: false` 说明请求已经超时或被清空，关闭并提示"已超时"。
- **失败不吞**：IPC 失败时弹窗**保留**（客户端确实还在被阻塞），弹出错误提示，并重新拉取一次 `mcpPendingApprovals()` 与主进程对齐；挂载时的补拉失败也从 `.catch(() => undefined)` 改成提示。
- **防重复提交**：作答在途时两个按钮都禁用（双击/连点不再触发第二次 IPC）。
- **剩余时间可见**：弹窗每秒刷新并显示"剩余 N 秒"，与主进程 60 秒自动拒绝的时钟对齐（时钟在请求被展示时才开始走，见 docs/21 §5）。
- 回归网：[McpApprovalDialog.test.tsx](../src/renderer/components/McpApprovalDialog.test.tsx) 6 例（推送出现 / 挂载补拉 / 结算后才关闭 / IPC 失败保留并提示 / 提前超时提示 / 在途禁用按钮），配合 `mcp-approval.test.ts` 的 9 例队列语义。

### P1-19. 目录枚举越界：`fs:listDirectory` / `folderMeta:read` 不校验 root ✅
docs/13 一直写着"读取入口也遵守同一位置边界"，但三个只读通道没走 `assertWithinAllowedRoot`：`fs:listDirectory`、`fs:listDirectoryRecursive`（除枚举外还会把扫描缓存写进 `<dir>/.whale/index-recursive/`）、`folderMeta:read`（返回目录的标签 / 颜色 / 描述）。另外还有一个渲染层从未调用的 `fs:pathExists`（裸 `existsSync`）。这组接口让被注入的主窗口（扩展 iframe 已隔离，但主窗口的预览内容同属一个信任域）可以枚举任意目录、在任意目录落 `.whale` 缓存。
- **同一把尺子**：三个通道补上 `assertWithinAllowedRoot`，与写通道、文件读取一致；fail-closed——未注册任何 root 时一律 `Refused`。
- **死 API 删除**：`fs:pathExists` 从 handler、preload 与 `WhaleApi` 声明中移除（全仓无调用方）。暴露面只减不增。
- **启动顺序**：React 子 effect 早于 Root 的 `setAllowedRoots`，收紧后首次挂载会撞上 fail-closed。[allowed-roots.ts](../src/renderer/services/allowed-roots.ts) 的 `waitForAllowedRoots()` 在无 in-flight 注册时先让出一个 microtask（同一轮 commit 的父 effect 随后才执行），[DirectoryTree.tsx](../src/renderer/components/DirectoryTree.tsx) 与 [DirectoryContentContextProvider.tsx](../src/renderer/hooks/DirectoryContentContextProvider.tsx) 在列目录前 `await` 它。
- **保留的例外**：`sidecar:readMany*` 仍不校验 root——它只返回调用方已给出文件名对应的元数据，无法枚举目录；收紧会把"按路径读元数据"变成另一条启动竞态。
- 回归网：[ipc.test.ts](../src/main/ipc.test.ts) 的 read-side guards 新增 5 例：listDirectory 内部可用 / 外部拒绝、listDirectoryRecursive 外部拒绝、folderMeta:read 内部可用 / 外部拒绝、`fs:pathExists` 通道不存在、无 root 时三通道全部拒绝。

### P1-20. 位置边界可以被渲染层自己「登记」绕过 ✅
[allowed-roots.ts](../src/main/allowed-roots.ts) 的注释声称这是"软纵深防御，被注入的渲染层也动不了位置外的文件"，但 `fs:setAllowedRoots` 直接信任渲染层发来的数组——被注入的渲染层 push 一个 `['/']`，整条边界立刻失效，`fs:writeFile` / `fs:readFile` / 删除全部放行。边界实际上只防住了"路径写错"，没防住"渲染层被控制"。
- **主进程记录位置来历**：新增 [known-roots.ts](../src/main/known-roots.ts)。`dialog:openDirectory` 处理器在把路径交回渲染层之前调用 `rememberPickedRoot`，持久化到 `<userData>/known-roots.json`（在位置边界之外，渲染层即使被注入也写不到）。
- **推送过滤**：`fs:setAllowedRoots` 只放行记录里的目录；未知目录 `console.warn` 后丢弃（既不注册、也不进 watcher / 索引）。索引键、`lastSyncedRoots` diff 都按过滤后的集合走。
- **升级兼容**：老用户的位置只存在于渲染层持久化状态里。第一次推送（记录文件不存在）做一次性种子并落盘，之后以记录为准；**首次推送即使是空的也关闭 seed 窗口**，否则首装（无位置）时被注入的渲染层还能在之后以 `/` 完成 seed；记录损坏或不可读时按"未 seed"重来，路径被目录占用时先把目录改名为 `known-roots.json.corrupt-<时间戳>` 再记录（否则后续每次写入都会失败）。代价是首装/升级那一次推送仍属 TOFU——已在 docs/13 §2 明示。
- **改名语义**：位置目录改名后旧路径不再算已知目录，重新用对话框添加即可（原来同样会因路径失效而打不开）。
- 回归网：[known-roots.test.ts](../src/main/known-roots.test.ts) 8 例（首推 seed 并持久化、未知目录拒绝、重启后记录仍在、对话框记录、相对路径忽略、损坏重 seed、不可读重 seed、原子写无 `.tmp` 残留）+ [ipc.test.ts](../src/main/ipc.test.ts) 的 location provenance 3 例（首推 seed、已 seed 后拒绝未选目录、对话框选过即注册）。

### P1-21. MCP 工具面：审批「放行」路径与 9 个工具零端到端覆盖 ✅
审批闸的测试此前只有「拒绝」一侧：`mcp-http.test.ts` 的 deny 用例在未注册 root 时运行，`assertWithinAllowedRoot` 先于审批触发，所以即使把审批闸整体删掉，该用例依旧会通过。"用户点了允许之后到底发生了什么"完全没有断言——包括那句最贵的承诺：`approve()` 只在用户放行后才执行真实写入。
- **新增 tool surface 组**（[mcp-http.test.ts](../src/main/mcp/mcp-http.test.ts)）：用 `bindApprovalTransport` 注入一个自动放行的传输层（`broadcast` 里 `resolveApproval(reqId, true)`），再走真实审批队列，逐工具断言副作用：`whale_list_directory`、`whale_get_meta`（打标后回读）、`whale_write_description`（覆盖描述且保留既有标签）、`whale_extract_text`、`whale_create_folder`、`whale_create_text_file`（字节数按 UTF-8 计、二次调用拒绝覆盖且原内容不变）、`whale_copy_files`（源保留、目标字节一致）、`whale_move_files`（源消失）、`whale_delete_files`（走 `shell.trashItem`，测试用 rm 模拟）、`whale_zip_files`（归档存在且非空）。
- **harness 变化**：electron stub 的 `shell` 从空对象改为带 `trashItem`（测试内 rm 模拟回收站），否则删除工具在测试环境里必然抛 `undefined is not a function`，反而测不到审批后的真实路径。
- 未覆盖并记录在案：依赖索引 worker 的 `whale_search` / `whale_advanced_search` / `whale_fulltext_search` / `whale_list_tags` / `whale_build_fulltext` 仍只有只读拒绝用例——`utilityProcess` 在测试里不可用，端到端需要先造一个索引替身，留作后续。

### P1-22. 侧车读失败 → 索引把标签整批擦掉（与全文那轮同类） ✅
[indexer.ts](../src/main/indexer.ts) 在某个目录的 `wsd.json` 读取失败时只 `console.warn`，然后照常发条目，`tags` 仅剩文件名解析出的部分。`ingestFiles` 随后按"当前这次遍历看到的状态"覆盖数据库——于是一次瞬时权限/损坏错误，就把该目录所有文件的标签从搜索与标签过滤里抹掉，直到下一次成功重建。侧车本身可能完好无损，这属于"读失败被当成删除"的同一类错误。
- **标记 partial 视图**：`IndexEntry` 新增可选 `tagsUnreadable`；`buildIndex` 在读侧车失败时给该目录下每个文件条目置位（目录条目不涉及标签）。
- **保留已存标签**：`ingestFiles` 的上游 SQL 改为 `tags=CASE WHEN @keep_tags THEN files.tags ELSE excluded.tags END`；带该标记的行不做"签名未变就跳过"的优化（partial 视图永远不等于完整签名），其余字段照常更新。
- **读取成功仍以侧车为准**：下一轮读取成功时走正常分支，清空标签会真正清空（回归用例覆盖）。
- 回归网：[index-db.test.ts](../src/main/index-db.test.ts) 新增"侧车读失败保留已存标签"用例（写入 `keep-me` → 带标记重建 → FTS 仍命中、`filesPrior` 仍含标签 → 正常重建后清空生效）；[indexer.test.ts](../src/main/indexer.test.ts) 的降级用例补断言：坏目录条目 `tagsUnreadable === true`、好目录不带该标记。

### P1-23. 2026-11 全仓复核（六通道）✅
在既有 P0~P3 全部 ✅ 的基线上，新一轮全仓审核（门禁 / 机械 / 安全 / main / 渲染层 / 扩展+shared+scripts+i18n 六个通道）又抓到两类 P0 与一批 P1，本轮已修：
- **条件式 hook（P0）**：[CalendarView.tsx](../src/renderer/components/CalendarView.tsx)（YearView 热力图分支返回后才调 2 个 `useMemo`）、[DirectoryTree.tsx](../src/renderer/components/DirectoryTree.tsx)（`!currentLocation` 早退后调 `useMemo`）、[GalleryCell.tsx](../src/renderer/components/GalleryCell.tsx)（`!entry` 早退后调 3 个 hook）——hook 数量随分支变化，运行时报 "Rendered more hooks than during the previous render"。修法：hook 上移到早退之前，早退只保留渲染分支；[.eslintrc.js](../.eslintrc.js) 补 `plugin:react-hooks/recommended`——此前只注册了插件、从未启用规则，所以门禁一直是绿的。
- **写逃逸（P0）**：`fs:move` / `fs:copy` 只校验源路径、不校验目的地，注入的渲染层可把任意内容搬进 Startup / `~/.ssh`；现两端都过 `assertWithinAllowedRoot`（[fs-write.ts](../src/main/ipc/fs-write.ts)），同轮 `fs:importExternal` 的 `cp` 补 `force:false`（默认 true 会静默覆盖）。
- **数据丢失（P1）**：索引根目录 ENOENT 被当成"真的没了"→ 删除 pass 清空整个 location 且不自愈（[indexer.ts](../src/main/indexer.ts)：根不可读也算 `unreadable` → `complete=false`）；跨目录移动先删源 sidecar 再写目标，写失败时标签永久丢失且调用方 `catch {}` 静默（[sidecar.ts](../src/main/sidecar.ts) 改为先写目标、再按内容未变才删源）。
- **其余（P1）**：shell 模板由渲染层自报 → 主进程一次性对话框授权（`COMMAND_NOT_APPROVED` + `<userData>/approved-command-templates.json`）；dompurify 3.4.16→3.4.17、MCP SDK 1.30.0→1.32.2、zod 4.6.5→4.6.7，并给 JSON-RPC batch 加 32 元素上限；Mapique DivIcon 的 `data-entry-path` 转义；切换目录清空选中集（`selectAllState` 改按可见项计数）；MediaLightbox 预读加取消守卫（卸载后才创建的 blob 会永久泄漏）；text-editor 跨文件复用 view 时重置 undo 历史（顺带修掉"先赋值后比较"导致语言切换永不执行）；15 个 i18n key 补五语言 + [check-locales.test.ts](../scripts/check-locales.test.ts) 新增"字面量 `t()` key 必须存在于 en"扫描；[run-tests.cjs](../scripts/run-tests.cjs) 去掉未声明的 `glob` 依赖，改 `fs` 递归遍历。
- **评估后不改**：smart-tags 的裸 4/6 位数字（`2019`）既是 year/month 的规范存储形式（迁移会重写成裸串），也可能撞上用户自建编码标签；收紧会破坏迁移后的年月互斥（4 个既有用例立即失败），记录为取舍（[docs/03 §12](./03-tagging.md)）。
- **后续独立议题**：门禁硬化（`scripts/` 进 tsc、`strict`、`--max-warnings`、死抑制指令）已由下方 P1-25 完成；`no-console` 与 `no-explicit-any` 仍关闭（见 P1-25 的理由）；`taglibrary.renameGroup` 缺 UI 入口仍待产品决策。P2 级的数据正确性项已由下方 P1-24 清理。
- 回归：`npm run type-check` 0 错、`npm run lint` 0 error（30 条 exhaustive-deps warning，门禁只统计 error）、`npm test` 1827/1827 全绿。

### P1-24. 2026-11 P2 批次（数据正确性优先）✅
在 P1-23 之外的 P2 清单里，挑"会丢数据 / 会让状态永久卡住、且可独立验证"的一批修复：
- **构建并发与符号链接**：[index-worker.ts](../src/main/index-worker.ts) 的 `index:build` / `fulltext:build` 走 per-root promise 链串行——两者都是"读 prior → 写入 → 按 prior 删除"，重叠执行会让先读的 prior 删掉后一次刚插入的行（FTS5 无唯一约束，重复行还会累积）；`index:close` 先等该 root 的链清空再关连接。[indexer.ts](../src/main/indexer.ts) / [fulltext.ts](../src/main/fulltext.ts) 改用 `lstat`：符号链接文件仍跟随（安全），符号链接**目录**不下降——Windows junction 指回上层会让遍历无限递归（ENAMETOOLONG）并把 `complete` 锁成 false，进而永久停掉删除 pass。
- **watcher 突发**：[dir-watcher.ts](../src/main/dir-watcher.ts) 的 500 条/批上限从"截断丢弃"改为"下一 tick 继续 drain"，并新增 5s 最大等待——纯尾沿去抖在解压 / `git checkout` / rsync 期间永不 flush，索引会整段时间陈旧。
- **清空失败导致"复活"**：[folder-meta.ts](../src/main/folder-meta.ts) / [tag-library.ts](../src/main/tag-library.ts) 清除最后一个字段时若删文件失败（Windows EBUSY、只读盘），旧代码静默吞掉，文件留着 → 下次读取把刚清掉的标签/元数据又读回来；现在失败时写显式空文档并 warn。[sidecar.ts](../src/main/sidecar.ts) 的 legacy 迁移同理：`rm` 失败改为重命名到 `.migrated-<stamp>`（防止下次 load 再次导入旧标签）；`migrateLatLngInPlace` 二次读为 null 时返回已迁移快照而不是 `{}`（否则整个目录看起来没有文件）。
- **修订快照字节级**：[revisions.ts](../src/main/revisions.ts) 备份 / 恢复改读写 `Buffer` + `atomicWriteBytes`——按 utf8 读 GBK / 二进制文件会把非法序列替换成 U+FFFD，恢复即写回损坏内容；清理遍历的根 / 子目录失败只 warn，不再让一个坏目录 reject 整批。
- **渲染层**：[DirectoryContentContextProvider.tsx](../src/renderer/hooks/DirectoryContentContextProvider.tsx) 空路径分支复位 `loading`、旧请求的 sidecar catch 补 `isCurrent` 守卫（否则永久骨架屏 / 旧健康状态覆盖新目录）；[SearchBar.tsx](../src/renderer/components/SearchBar.tsx) 清空查询或模式切换时复位 `contentBusy`（旧查询的 finally 被 seq 跳过会永久转圈）；[ThumbIcon.tsx](../src/renderer/components/ThumbIcon.tsx) 缓存快路径无条件 `setState`（复用单元格时两条目命中同一缓存 URL 会一直空白）；[CalendarView.tsx](../src/renderer/components/CalendarView.tsx) `containIntrinsicSize` 40px→28px（实际行高 24 + 上下 4）。
- **扩展协议**：[extension-types.ts](../src/shared/extension-types.ts) 的 `isValidEnvelope` 加消息类型白名单 + `message` 形状校验（此前只要非 `undefined` 就放行）；[ExtensionHost.tsx](../src/renderer/components/ExtensionHost.tsx) 的 message effect 补 `onRequestFile` 依赖（旧闭包拿着过期 `entries`，兄弟文件导航静默失效）；[heic-viewer/index.ts](../src/extensions/heic-viewer/index.ts) 的 wasm 请求加 15s 超时（宿主无响应时 promise 永久挂起、libheif 永不重试）。
- **工程**：`@types/leaflet*` 从 `dependencies` 移到 `devDependencies`；[build-extensions.js](../scripts/build-extensions.js) 真正支持 `--watch`（此前 `watch:extensions` 传了 flag 但脚本忽略，dist 一直陈旧；webpack 失败改为抛出，watch 循环可继续）。
- **扩展协议 / 编辑器（第二轮）**：[drawio-editor/drop-xml.ts](../src/extensions/drawio-editor/drop-xml.ts) 的非图片 drop label 在 `html=1` 下按 HTML 渲染，改为先 HTML 转义再 XML 转义（此前只做 XML 转义，文件名 `<img src=x onerror=…>` 会解码回标记）；[drawio-bridge.ts](../src/extensions/drawio-editor/drawio-bridge.ts) 并发插入从"in-flight 静默丢弃"改为 promise 链串行（第二个拖入的文件不再无声消失）；[html-viewer/index.ts](../src/extensions/html-viewer/index.ts) 关闭远程图片时，用户 `<style>` 的 `@import` 与非 `data:` 的 `url()` 一并剥掉（DOMPurify 管不到 `<style>` 文本，`background:url(https://…)` 仍会发请求）；[extension-types.ts](../src/shared/extension-types.ts) 把 `DirectoryDialogResultMessage` 补进 `HostMessage` 联合（此前可用但类型不完整）；[index-db.ts](../src/main/index-db.ts) 的 `insertFulltext` 改为同事务内先按 path 删除再插入——FTS5 虚拟表没有 UNIQUE 约束，漏删一步就会累积重复行。
- 回归：受影响的 main 测试 63/63、dir-watcher 13/13、drop-xml + index-db 76/76 通过；全量三件套：type-check 0 错、lint 0 error（29 条 exhaustive-deps warning）、`npm test` 1829/1829 全绿。

### P1-25. 2026-11 门禁硬化：strict + scripts 纳入 tsc + warning 即失败 ✅
P1-23 复核把三项「门禁看起来绿、实际拦不住」的缺陷记为后续议题：[tsconfig.json](../tsconfig.json) 未开 `strict`、`scripts/` 不在 `tsc` 的 include 里、lint 没有 warning 上限（且 `react-hooks` 规则长期只注册插件、从未启用）。本轮全部处理：
- **strict**：`npx tsc --noEmit --strict` 基线 112 错，其中 [useGanttTagFilter.test.tsx](../src/renderer/components/gantt/useGanttTagFilter.test.tsx) 的 `mountProbe` 返回可空 ref 独占 50 条（TS18047）。先让该 helper 返回非空句柄（`handleRef` + 一次性 `assert.ok`）把 112 降到 62；生产代码按错误类型逐条收窄：[fs-write.ts](../src/main/ipc/fs-write.ts) 的 import outcome 用 `typeof destPath === 'string'` 代替 `in`、[sidecar.ts](../src/main/sidecar.ts) 的损坏备份写 `Uint8Array` 视图、[CalendarView.tsx](../src/renderer/components/CalendarView.tsx) 的菜单回调改可选并在调用点 `?.`、[FileList.tsx](../src/renderer/components/FileList.tsx) 的列宽表用 `keyof` 收窄、[FileListHeader.tsx](../src/renderer/components/FileListHeader.tsx) / [PropertiesTray.tsx](../src/renderer/components/PropertiesTray.tsx) 的 `NonNullable<typeof ref.current>` 在 strict 下塌成 `never`，改用显式拖拽类型、[GalleryView.tsx](../src/renderer/components/GalleryView.tsx) 用 `useRef<GridImperativeAPI | null>` + 空表单例稳定 cell props、[configureStore.ts](../src/renderer/store/configureStore.ts) 的 `migrate` 返回 `Promise<Record<string, unknown>>`、[KnowledgeGraphView.tsx](../src/renderer/components/KnowledgeGraphView.tsx) 的 MiniMap 回退色、[folderviz.ts](../src/renderer/domain/folderviz.ts) 给 `child` 显式注解打断推断环、[reducers/extensions.ts](../src/renderer/reducers/extensions.ts) 的 `prior` 展开。测试侧统一：`as NodeJS.Module` 走 `unknown`、GanttEntryMenu 用 `{ value }` 盒子避开「回调内赋值不被流分析跟踪」、GanttView 先 `assert.ok` 收窄、[auto-update.ts](../src/main/auto-update.ts) 的 `subscribe` 按 channel 重载消掉 7 处隐式 any、`piexifjs` 补最小 `.d.ts`。最终 strict 0 错。
- **scripts 进 tsc**：`tsconfig.json` 的 include 增加 `scripts/**/*.ts`，随即暴露 [verify-settings-persist.ts](../scripts/verify-settings-persist.ts) 5 处（`ProcessEnv` 注解、Buffer 回调、可空 exit code），修完后 `npm run type-check` 同时覆盖 `src/` 与 `scripts/`。
- **lint 零容忍**：先清 29 条 `react-hooks/exhaustive-deps`（选择修订号 `selectedTick` 用 `void selectedTick` 说明「它只用于失效、不参与计算」；[FileList.tsx](../src/renderer/components/FileList.tsx) 十处 handler 补 `showNotice`；[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx) 的 `recordPrev` 改 `useCallback`；[MediaLightbox.tsx](../src/renderer/components/MediaLightbox.tsx) 卸载清理先取 map 的局部引用；[DirectoryTree.tsx](../src/renderer/components/DirectoryTree.tsx) 用 path 局部量替代 `currentLocation` 对象依赖）。随后 lint 脚本加 `--max-warnings 0` 与 `--report-unused-disable-directives`，`eslint --fix` 移除 88 条针对已关闭规则（`no-console` / `no-explicit-any`）的死抑制指令——它们永远不会生效，却会在未来重启规则时假装「已评估」。
- **仍不启用**：`no-console`（主进程用带模块前缀的 `console.warn/error` 当结构化日志，正确治理是日志分区而非禁用；已在 P1-26 以 allow `warn`/`error` + 单一入口启用）；`@typescript-eslint/no-explicit-any` 仍 off（现存 26 处 `as any` 留待专项）；`taglibrary.renameGroup` 缺 UI 入口（产品决策）。
- 回归：`npm run type-check` 0 错（strict，覆盖 src + scripts）；`npm run lint` 0 error / 0 warning（warning 即失败）；`npm test` 1829/1829、419 suites 全绿。

### P1-26. 2026-11 安全收尾：权限一律拒绝 + 敏感文件 0600 + 日志单一入口 ✅
P1-23 的安全通道留下四条 P2 记录（进程无 permission handler、`crash.log` 默认 0644、MCP 配置 0644、`no-console` 未启用）。逐条处理；另两条记录项复核后确认属「已接受取舍」：
- **权限一律拒绝**：[main.ts](../src/main/main.ts) 新增 `configurePermissions()`，`setPermissionRequestHandler` 一律 `callback(false)`、`setPermissionCheckHandler` 一律 `false`。离线文件管理器不需要摄像头 / 麦克风 / 定位 / 通知 / MIDI，被注入的渲染层或扩展 iframe 也无法借原生弹窗骗取设备权限。
- **敏感文件 0600**：[atomic-write.ts](../src/main/atomic-write.ts) 新增 `AtomicWriteOptions.mode`（`fsp.open(tmp,'w',mode)`，rename 前再 `chmod`），[mcp-config.ts](../src/main/mcp/mcp-config.ts) 以 `0o600` 写含 token 的文档；[crash-guard.ts](../src/main/crash-guard.ts) 的 `appendCrashLog` 走 `mode: 0o600` 并 chmod 修正历史文件，`sanitizeErrorDetail` 把 home 前缀替换成 `~`——崩溃报告常被贴进 issue，绝对路径会带出账号名。
- **日志单一入口**：新增 [log.ts](../src/main/log.ts)（唯一 `eslint-disable no-console` 的文件），9 处 `console.log/info/debug` 改为 `logInfo` / `logDebug`；[.eslintrc.js](../.eslintrc.js) 启用 `no-console: ['error', { allow: ['warn', 'error'] }]`，`scripts/**` 用 override 关闭（CLI 构建 / 校验脚本本来就要打印 stdout）。
- **复核后不改**：① 目录缩略图 / 背景的 source 图片可位于位置外——来自原生选择框，服务只读源、只写目标 `.whale/`，[boundary-guards.test.ts](../src/main/ipc/boundary-guards.test.ts) 明确断言这一行为；② CSP `img-src` 保留 `http(s)`——Mapique 地图瓦片从 OSM / 用户自建瓦片服务器加载。两条取舍写入 [docs/13 §12](./13-security.md)。
- 回归：`npm run type-check` 0 错（strict）；`npm run lint` 0 error / 0 warning（`no-console` 生效）；`npm test` 1835 tests / 1834 pass / 0 fail / 1 skipped（POSIX 0600 用例在 Windows 上 skip）、420 suites 全绿。

### P1-27. 2026-11 后续审计：正确性、资源边界与发布门禁 ✅
- ✅ **选择 / 批量 IO / Lightbox**：拖拽在 react-dnd drag-start 读取当前选择；批量 move/delete 只 refresh 一次、聚合并报告真实失败且只清成功项选择，Gallery 多目标走 `saveMany`；playlist memo 化，胶片条窗口化但保留远程翻页（[docs/10 §13](./10-ui.md)）。
- ✅ **编辑器保存协议**：text / drawio / Excalidraw 保存带 revision，stale ack 不清后续编辑；readOnly 不再触发旧 `fileContent` 重灌，drawio 只读禁输入；Excalidraw 旧回执先推进实际写盘 baseline 再重算当前 dirty（[docs/07 §6](./07-extensions.md)）。
- ✅ **全文 / watcher**：首建每 100 条批写，失败批回滚、成功批保留下轮可恢复；PDF 全局 2 路、超时停止页循环、异常 destroy 1 秒有界等待避免许可永久泄漏、精确视图免二次复制；watcher `['']` 对所有相关全文根保守重建（[docs/04](./04-search-index.md)）。
- ✅ **权限 / 崩溃日志**：P1-26 的全拒策略收窄为主界面/json-viewer 剪贴板写与 image-viewer fullscreen 的精确白名单，其余仍拒绝；主进程崩溃堆栈也脱敏并覆盖正反斜杠 home，POSIX 在追加前按 fd 强化 0600；atomic-write 的 mode chmod 失败上抛且不发布 tmp（[docs/13](./13-security.md)、[docs/02 §7](./02-file-io.md)）。
- ✅ **工程门禁**：扩展 manifest 占位符未命中即失败；新增 Windows lint/type-check/test CI 与手动 fresh unpacked packaged-smoke workflow，冒烟隔离 userData 并覆盖真实全文 worker（[docs/14](./14-packaging.md)）。
- 回归：`npm run lint`、`npm run type-check` 通过；137 个测试文件、1889 tests / 1887 pass / 0 fail / 2 skipped（POSIX mode 用例在 Windows 预期跳过）；当前源码 fresh unpacked 构建与 `node scripts/packaged-smoke.js` 通过。

### P1-28. 2026-11 后续资源边界、依赖一致性与 GUI 发布冒烟 ✅
- ✅ **ZIP 子进程 / 原子发布**：[fs-write.ts](../src/main/ipc/fs-write.ts) 为 PowerShell / zip / python3 统一 120 秒、SIGKILL 与 1 MiB 输出边界；归档先写唯一 staging，成功才 rename，失败清理半成品；timeout / maxBuffer 映射为不回显源路径的简洁错误。python fallback 与 POSIX 相对布局不变（[docs/02 §5](./02-file-io.md)）。
- ✅ **目录背景并发**：[thumbnail.ts](../src/main/thumbnail.ts) 的 sharp 读取、变换与 JPEG 编码纳入共享 4 路 `thumbnailSemaphore`，异常释放许可；目录创建和原子写不持锁（[docs/06](./06-thumbnails.md)）。
- ✅ **依赖一致性**：`echarts-wordcloud@2.1.0` 的 peer 仅支持 ECharts 5，应用由 6.1.0 对齐到 `echarts@^5.6.0`；`npm ls echarts --all` 与 `npm ci --dry-run --ignore-scripts` 通过，不新增 overrides。
- ✅ **真实 GUI 冒烟**：新增 `scripts/packaged-gui-smoke.js`，在隔离一次性应用实例中走真实 Add Location → Copy Path 剪贴板 → Image Viewer fullscreen → Text Editor Ctrl+S 落盘链路；只在测试主进程替换原生目录选择器返回，不改生产桥接或权限边界。手动 packaged workflow 同时运行主进程/worker 与 GUI 两条冒烟（[docs/14 §3](./14-packaging.md)）。
- ✅ **通用读取边界复核**：readFile/readTextFile/readFileBase64 的无上限整读服务于合法大 TIFF、图片与扩展二进制，不引入破坏兼容的小阈值；该边界已写入 [docs/02 §6](./02-file-io.md)。
- 回归：`npm run lint`、`npm run type-check` 通过；137 个测试文件、1897 tests / 1895 pass / 0 fail / 2 skipped（POSIX mode 用例在 Windows 预期跳过）；ZIP 定向 15/15、目录背景定向 26/26。当前源码 fresh unpacked 构建、主进程/全文 worker smoke 与真实 GUI smoke 均通过（[docs/14 §3](./14-packaging.md)）。

### P1-29. 2026-11 依赖安全审计与最小兼容升级 ✅
- ✅ **直接与传递补丁**：`electron@42.11.18`、`electron-builder@26.18.0`、`concurrently@9.2.5`、`rimraf@6.1.4`、`webpack-dev-server@5.2.7` 修复直接 pinned 版本告示；不带 `--force` 的 `npm audit fix` 再更新 18 个兼容传递包，消除 critical proxy-addr、shell-quote 与 high body-parser 等节点。
- ✅ **量化结果**：完整 `npm audit` 从 49 项（3 critical / 31 high）降为 27 项（0 critical / 17 high），`--omit=dev` 从 20 项（1 critical / 10 high）降为 12 项（0 critical / 8 high）。`npm ci --dry-run --ignore-scripts` 与直接依赖 `npm ls` 通过，Electron 本地二进制已核对为 42.11.18。
- ✅ **不以强制升级掩盖残余**：剩余运行时节点仅是 Excalidraw/Mermaid 固定传递链和 ECharts 5；前者当前 Excalidraw 已为上游最新，后者所有 HTML tooltip 的用户名称已有 `escapeHtml` sink 与测试，不能为审计计数破坏 wordcloud 兼容。开发/构建面残余及接受理由记录在 [docs/13 §13](./13-security.md)。
- ✅ **新安装排坑**：Electron 42.11 npm 包可能按需下载二进制；文档补充 install.js 校验与一次性镜像方法，不把 npm 包版本号误当作 `electron/dist` 已更新（[docs/14 §2](./14-packaging.md)）。
- 回归：`npm run lint`、`npm run type-check` 通过；137 个测试文件、1897 tests / 1895 pass / 0 fail / 2 skipped（POSIX mode 用例在 Windows 预期跳过）。当前源码以 Electron 42.11.18 / electron-builder 26.18.0 fresh unpacked 构建成功，主进程/全文 worker 与真实 GUI 两条 smoke 均通过；未覆盖 NSIS 安装包与 GitHub Actions 远端运行。

### P1-30. 2026-11 扩展关闭边界、Lightbox 清理与崩溃日志上界 ✅
- ✅ **扩展多标签状态**：[ExtensionContextProvider.tsx](../src/renderer/hooks/ExtensionContextProvider.tsx) 在取消关闭或保存失败后恢复此前活动标签；标签记录所属 location，只同步该位置的 readOnly 变化。保存失败不再静默，readOnly 拒写显示对应位置名称；路径刷新优先精确匹配，仅在归一化结果唯一时兼容 watcher 的大小写/分隔符差异（[extension-tabs.ts](../src/renderer/hooks/extension-tabs.ts)、[docs/07](./07-extensions.md)）。
- ✅ **Lightbox 全局监听**：[media-pan.ts](../src/renderer/components/media-pan.ts) 返回幂等 disposer；新拖拽、关闭、Esc、当前媒体变化及 unmount 都清理 window mousemove/mouseup，旧 disposer 不能误删新手势监听（[docs/10 §13](./10-ui.md)）。
- ✅ **崩溃日志上界**：[crash-guard.ts](../src/main/crash-guard.ts) 在追加前按 UTF-8 字节将 1 MiB 上限之外的旧日志轮换为唯一 crash.log.1；Windows 先移除退役备份再 rename，轮换失败告警并仍保留当前完整记录，POSIX fd 写前 0600 与主/渲染脱敏不变（[docs/01 §9](./01-architecture.md)、[docs/13 §6](./13-security.md)）。
- ✅ **依赖与真实 GUI 验收**：删除无源码/构建脚本引用的 png-to-ico、png2icns，共减少 10 个安装包；不把它与尚未完成的 mac .icns 混为一谈。packaged GUI 新增后台脏标签关闭确认期间的焦点断言、取消后恢复、再次保存；剪贴板对可安全恢复格式单次结构化写入并读回校验，无法安全恢复时在任何写入前拒绝，MUI modal 的 aria-hidden 背景用 CSS role 定位，不放宽断言（[docs/14 §3](./14-packaging.md)、[docs/16 C-3](./16-cross-platform.md)）。
- 回归：`npm run lint`、`npm run type-check` 通过；138 个测试文件、1911 tests / 1909 pass / 0 fail / 2 skipped（POSIX mode 用例在 Windows 预期跳过）。当前源码以 Electron 42.11.18 / electron-builder 26.18.0 fresh unpacked 构建成功，主进程/全文 worker 与真实 GUI 两条 smoke 均通过；真实 GUI 额外覆盖后台脏标签取消关闭和焦点恢复，未覆盖 NSIS 安装包与 GitHub Actions 远端运行。

### P1-31. 2026-11 扩展保存最终一致性与 Draw.io 离线资源闭环 ✅
- ✅ **保存一致性**：ExtensionHost 单点通知写异常、初始/动态 readOnly、15 秒无响应、concurrent saving 和 stale ack；stale 不清 dirty 或向关闭方返回成功，保存后仍 dirty 会取消关闭并恢复先前焦点。普通/后台关闭成功也恢复此前活动标签。工具栏 Save 与 close 请求的极窄交叠仍可能保守取消并提示，但不会误报已保存。
- ✅ **Draw.io 离线资源**：构建只保守剔除无引用资源（共 138 文件 / 3,050,820 bytes），恢复 `open.html`，manifest 用函数替换；同时 patch `index.html` 与 `PreConfig.js`，修复 vendor 将 viewer/base 重置 null 后回退公网 CDN 的离线路径。真实包断言 viewer/base/lightbox 同源、bundle 可加载及 init/render/label edit。
- ✅ **冒烟清理可靠性**：两个 packaged smoke 的清理异常不覆盖原错误；GUI 剪贴板只对空或单独 `text/plain` 执行 Copy Path，单次结构化恢复 + 有界严格 read-back；遇格式化文本、图片、FileNameW、URI 等不触碰剪贴板并明确跳过该项，干净 CI 仍执行完整 clipboard 断言。
- 回归：`npm run lint`、`npm run type-check`、`npm test` 通过（139 文件，1927 tests / 1925 pass / 0 fail / 2 skipped，POSIX mode 用例在 Windows 预期跳过）；当前源码 fresh unpacked 的主进程/worker、真实 GUI（含 Copy Path）和 Draw.io viewer/Lightbox 三条冒烟全部通过。第八轮随后补齐 Draw.io 宿主 Save 与磁盘读回；HTML-embed 正式 bundle 是上游缺口，未覆盖 NSIS 安装包与 GitHub Actions 远端运行。

### P1-32. 2026-11 全文提取调度与目录加载在飞行合并 ✅
- ✅ **全文提取不再按目录叠乘**：[fulltext.ts](../src/main/fulltext.ts) 的 `buildFulltextIndex` 对非 PDF 实际提取使用 worker 级 `Semaphore(8)`，各目录原有 8 路 walk 不再造成递归并发乘积；PDF 不占通用许可，只走原有 2 路专用闸门，避免 PDF 队列饿死文本，直接 MCP 路径不变。4 个嵌套目录 × 4 文件验证全局 `maxActive=8` 且 16 行全部可搜索；另一回归强制文本目录等 8 个 PDF 全部进入队列后才运行，确定性证明文本仍能前进。
- ✅ **同目录加载只算一次**：[thumbnail.ts](../src/main/thumbnail.ts) 以 thumbnail/background 各自 target path 为 key，只合并未 settle 的同目录加载；同目录 8 路 thumbnail 只做一次 copy/read、6 路 background 只做一次 read，不同目录互不影响。Promise settle 后必清 Map，失败传播给全部等待方且下次可重试，不持久缓存结果或 `null`，因此不会用旧空目录遮蔽新增文件；既有 generate in-flight、mtime、4 路 background 编码限制与 IPC 不变（[docs/04](./04-search-index.md)、[docs/06](./06-thumbnails.md)）。
- 回归：`npm run lint`、`npm run type-check` 通过；139 个测试文件、1933 tests / 1931 pass / 0 fail / 2 skipped（POSIX mode 用例在 Windows 预期跳过），fulltext 定向 17/17、thumbnail 定向 30/30。包含最终 PDF/文本隔离修正的当前源码 fresh unpacked 构建成功，主进程/持久化/全文 worker、真实 GUI（含 Copy Path）与 Draw.io viewer/Lightbox 三条冒烟全部通过；未覆盖 NSIS 安装包与 GitHub Actions 远端运行。

### P1-33. 2026-11 可复现性能基线与参数停止条件 ✅
- ✅ **隔离基准工具**：新增 [bench-performance.js](../scripts/bench-performance.js)，全文使用真实 app.asar utilityProcess，目录缩略图使用真实 renderer `window.whale.loadFolderThumbnail` → preload IPC → packaged main；3 轮中位数并校验索引命中/陈旧清理、JPEG 产物与同目录结果一致性。测量前排空真实 per-root 索引队列并断言所有缩略图不存在，报告 `coldVerified`；内存明确为 phase 后 resident 与共享 worker 累计 peak，不吞缺失值。新增 [bench-fulltext-phases.js](../scripts/bench-fulltext-phases.js) 与 [bench-fulltext-batches.js](../scripts/bench-fulltext-batches.js) 分离读取归因和真实 `insertFulltext` 事务批次；[bench-stats.js](../scripts/bench-stats.js) 统一统计，加载主进程源码的脚本显式 `NODE_ENV=test`，清理失败隔离且报告 `tempRootRemoved`。核心 fulltext/thumbnail/cold validator 与统计共 6/6 测试通过，临时 fixture 全部清理。
- ✅ **按证据停止而非盲调**：最终自检版的 1000×4KiB 文本基线为 cold 1235.507ms、no-op 11.882ms、1% 增量 21.727ms、查询 0.567ms；24 目录缩略图 cold 152.7ms、warm 4.3ms、8 路同目录 burst 11.8ms（只证明结果一致，单次生成由单元测试证明）。阶段探针断言 synthetic 每轮真实执行 1000 次，并按每轮配对差报告归因；事务探针按 10 组各 100 行证明全部 1000 行写入。最新批次对照波动大且无稳定排序，不支持为微小/不稳定差异扩大大文本驻留，因此保留生产参数。合成小样本、现有 unpacked、未清 OS page cache 与 phase 后内存快照均不作普遍性能或泄漏结论；跨 harness 的绝对耗时不直接比较（[docs/15](./15-perf-audit.md)）。
- 回归：`npm run lint`、`npm run type-check`、`npm test` 全通过；140 个测试文件，1939 tests / 1937 pass / 0 fail / 2 skipped；当前源码 fresh unpacked 构建及主进程/worker、真实 GUI、Draw.io viewer/Lightbox 三条冒烟通过。本轮无产品行为参数变更，仅新增基准工具与文档。

### P1-34. 2026-11 批量目录树刷新与 Draw.io 保存验收 ✅
- ✅ **批量刷新去重**：IOActionOptions 将 `refresh` 与 `treeRefresh` 分离；批量移动/删除抑制逐项刷新，批后只对成功项的源 parentDir 和移动目标目录去重刷新，再做一次 listing。失败项不刷新其目录且保留选择；单文件及旧 `{refresh:false}` 语义不变。真实 Provider 始终提供稳定 `refreshTree`，FileList 复用 IOActions context。定向 22/22 通过。
- ✅ **Draw.io 保存读回**：packaged smoke 点击当前 iframe 所属宿主 toolbar 的真实 Save，再由 Node 轮询磁盘，验证新 label 存在、旧 label 消失、XML 改变且 mtime 不倒退；既有离线 viewer/base/lightbox、Lightbox 文档和 init/render/edit 断言保留。
- ✅ **基准与清理收尾**：batches 的 `--output` 缺值报错并创建父目录，phases 不再误称 byte-for-byte，performance 在强制 kill 后有界等待进程退出。GUI 只对空或单独 `text/plain` 剪贴板执行 Copy Path，其余格式保持原样并明确跳过，避免 Windows 组合格式恢复风险。
- 回归：`npm run lint`、`npm run type-check`、`npm test` 全通过；140 个测试文件，1941 tests / 1939 pass / 0 fail / 2 skipped。包含本轮产品改动的当前源码 fresh unpacked 构建成功；最终主进程/worker、真实 GUI（实际执行 Copy Path）与 Draw.io 三条 smoke 全部通过，Draw.io 包含宿主 Save 和磁盘读回。未覆盖 NSIS 安装包与 GitHub Actions 远端运行。

### P1-35. 2026-11 批量失败反馈与自动化可靠性收尾 ✅
- ✅ **批量错误与目录树依赖**：批量通知只显示前 3 条错误并以五语言 `andMoreFailures` 汇总剩余数量，完整错误数组通过 console.error 保留；成功/部分失败/全失败、refresh 错误、失败项选择和 treeRefresh 去重不变。`IOActionsContextValue.refreshTree` 改必填，FileList 删除 no-op 兜底，Kanban 测试替身显式补齐；聚焦 36/36、locale/type-check/scoped lint 通过。
- ✅ **自动化诊断与报告**：Draw.io watchdog 提至 300 秒并在错误中携带当前阶段，真实 Save 与磁盘读回保留。phase/batch benchmark 严格拒绝未知参数和缺值、限制 rounds，成功/失败报告带 generatedAt/completedAt，指定 --output 时失败覆盖旧报告；CLI/报告及核心统计契约聚焦 9/9，一轮与异常参数实测通过。
- ✅ **复审收口**：`composeBatchNotice` 统一全成功/部分成功/全失败文案与级别，部分失败由五语言 `partialFailure` 单模板组合，批量删除通过 `trashedItems` / `deletedItems` 带真实成功 count；移除无用 saveMany 表达式。phase/batch 导出 `runCli(argv)` 并测试真实失败报告链，严格十进制 rounds；清理失败使报告 `ok:false`、带 `cleanupError` 且不覆盖原错误，Drawio Save 图标取首个匹配并验证 mtime 严格前进。聚焦通知/locale 25/25、benchmark 10/10 通过。
- ✅ **最后两项 minor 闭环**：多目标 sidecar 写入改为 allSettled 后统一刷新，失败仍 reject 并携带真实 `updatedCount` 与完整 `errors`，多选打标复用统一通知；聚焦 provider/hook 19/19。phase/batch 将测量异常与清理汇入同一报告，双失败也保留原错误、cleanupError、tempRootRemoved 和时间戳；聚焦 CLI/报告 10/10。TagMetaSaveManyError.message 统一限制为前三条加省略号，完整 errors 数组不变，避免其他 saveMany 调用点出现超长 Snackbar。
- 回归：diff/LF、`npm run lint`、`npm run type-check`、`npm test` 全通过；140 个测试文件，1954 tests / 1952 pass / 0 fail / 2 skipped。当前源码 fresh unpacked 与主进程/worker、GUI、Draw.io 三条 smoke 通过；本次本机 GUI 因已有 text/plain+text/html 按安全策略明确跳过 Copy Path，未触碰该剪贴板，干净 CI 仍执行完整 clipboard 断言。未做人为 300 秒超时/清理故障注入以外的生产故障演练，双失败基准报告路径已由受控 hook 实测；未覆盖 NSIS 与远端 Actions。

### P1-36. 2026-11 Excalidraw/Mermaid 真实验收与传递依赖窄覆盖 ✅
- ✅ **真实 Excalidraw/Mermaid 链路**：新增 [packaged-excalidraw-smoke.js](../scripts/packaged-excalidraw-smoke.js) 并接入手动 workflow；真实 Add Location、canvas 非空像素、绑定文本编辑、宿主 Save 与磁盘 version/mtime 读回后，再验证最小 Mermaid flowchart 的 lazy preview、原生 Insert、第二次 Save 的 A/B 节点、连线和元素数。Save 前后等真实宿主 tab dirty/clean；Mermaid 只在隔离 iframe origin 的编辑器 localStorage 预置同一个最小 A→B 定义，并断言 textarea 初始值，因此初始或后续 preview 都不会混入默认示例。dialog 提前关闭立即失败，canvas 非空像素、conversion error 和两次磁盘读回断言保留。加强后的脚本在 fresh 包连续两次通过，最终 7 个未删除元素。
- ✅ **最小依赖覆盖**：只为三个 chevrotain 依赖边声明 lodash-es 4.18.1、Excalidraw 直接 nanoid 3.3.20，并显式保留 mte nanoid 4.0.2 major；先在隔离 lockfile/完整 npm ci 验证，再由主仓库 npm ls、ESM 加载与真实扩展验收复核。npm 析取后的 4.18.1 也由 chevrotain-allstar 与 dagre-d3-es 共享，这些实际消费者均纳入危险 sink 导入检查，文档没有把声明范围误写成完整影响面。
- ✅ **量化与边界**：本机完整 audit 27→21（0 critical），production 12→6（1 high / 3 moderate / 2 low）；剩余 mte nanoid、KaTeX、ECharts 5 保留兼容与可达性说明，不把 audit 下降宣称为已证明远程利用链消失。AGENTS.md、docs/13、docs/14 与 CHANGELOG 已同步四类冒烟和残余风险。
- 回归：diff/LF、`npm run lint`、`npm run type-check`、`npm test` 全通过；140 个测试文件，1954 tests / 1952 pass / 0 fail / 2 skipped。包含依赖覆盖的当前源码 fresh unpacked 构建成功，主进程/worker、真实 GUI、Draw.io 与 Excalidraw/Mermaid 四条 smoke 全部通过；本次 GUI 因组合剪贴板按策略跳过 Copy Path 且保持原数据。未覆盖 NSIS 安装包与 GitHub Actions 远端运行。

### P1-37. 2026-11 第 37 轮审核：五个高收益修复 ✅
- ✅ **关窗 flush 不再卡 8 s**:[configureStore.ts](../src/renderer/store/configureStore.ts) 的 `onBeforeUnloadFlush` 加 `try/catch/finally`,`persistor.flush()` 或扩展编辑器 flush 拒绝时仍 `flushComplete()`,并 `console.error` 上报——此前一次写盘失败就等于每次关窗都被主进程 `closeFallback` 强杀,错误完全不可见。
- ✅ **日历翻月不再跳月**:[calendar.ts](../src/renderer/domain/calendar.ts) 新增 `addMonthsClamped`(先落到目标月 1 号再 `Math.min(day, daysInMonth)`,保留本地时分秒),[CalendarView.tsx](../src/renderer/components/CalendarView.tsx) 的 prev/next 与月选择面板全部改走它——`addMonths` 的 `Date#setMonth` 溢出曾让 1/31 点"下个月"直接跳到 3/3(2 月整月被跳过),闰日年视图同样漂移;`addMonths` 保留给普通日历算术。
- ✅ **Mapique shift 连选不再崩溃**:[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx) 的选区锚点从**下标**改为**路径**,shift 时用 `tray.findIndex` 换算(锚点已不在 tray 就退化成普通单选),遍历时按下标存在性判空;`trayFilter` / `nameQuery` 变更时一并清锚点。此前锚点下标在 tray 重排/缩短后越界,`tray[i].path` 抛 TypeError 崩掉整个视图。
- ✅ **空索引恢复增量重建**:[index-db.ts](../src/main/index-db.ts) 的 `indexStatus` 增加 `exists`(db 文件存在,与行数无关),`ready` 保持"有内容"的 UI 语义;[dir-watcher.ts](../src/main/dir-watcher.ts) 的增重建闸门改用 `exists`——原先 `ready = count > 0`,一个"索引已建但文件全被删"的 root 会被当成从未索引,之后新增的文件永远进不了索引。fulltext 侧同型:[index-db.ts](../src/main/index-db.ts) 新增 `meta.fulltext_initialized` 标记(`buildFulltextIndex` / `ingestFulltext` 成功后写入),`hasFulltext` 改为"标记存在或任一行",空全文索引不再被 `fulltext:has` 判定为未建。`index-protocol.ts` / `ipc-types.ts` 同步类型,MCP `whale_roots` 的错误兜底也补 `exists: false`。
- ✅ **importExternal 静默失败补日志**:[fs-write.ts](../src/main/ipc/fs-write.ts) 的 sidecar/缩略图同步 catch 从空块改为 `console.warn`(与本文件 rename/move/copy 三处对齐),导入成功但标签没跟过来不再无声无息。
- 回归:新增 `addMonthsClamped` 共置用例(index-db 的 `exists`/空索引 + `hasFulltext` 空建标记、dir-watcher 的空索引仍重建);`npm run lint`、`npm run type-check`、`npm test` 全通过。
- 遗留(本轮审核已记录、尚未修):位置只读仅在渲染层(主进程 + MCP 不认)、Revision restore 无确认/无备份、缺 `requestSingleInstanceLock`、IPC 写入口不拒位置根、legacy sidecar 迁移会在位置外写盘、html-viewer `style` 属性未剥远程引用等 P1-A/P1-B 项。**（除 html-viewer 外均已由 P1-38 / P1-39 / P1-40 修掉）**

### P1-38. 2026-11 第 37 轮审核续：修订恢复可回退 / 单实例锁 / 位置根守卫 ✅
- ✅ **恢复修订前先自动备份**:[revisions.ts](../src/main/revisions.ts) 的 `restoreRevision` 在覆盖前先 `backupRevision(filePath)`,把**当前**内容写进同一修订列表(失败则拒绝恢复并上抛)——此前恢复是一次不可逆覆盖:修订列表只存旧版本,误点一次「恢复」就永久丢掉最新改动,对话框随即关闭,错误只能事后在磁盘上发现。同时 [RevisionHistoryDialog.tsx](../src/renderer/components/RevisionHistoryDialog.tsx) 的恢复按钮加 `useConfirmOptional` 二次确认(`danger`,提示会覆盖当前文件、当前内容已先备份,并显示所选版本时间),不再一键落盘。新增 5 语言 `revisionRestoreConfirm` 文案。
- ✅ **单实例锁**:[main.ts](../src/main/main.ts) 在 `pinUserDataToProductName()` 之后调用 `app.requestSingleInstanceLock()`,拿不到锁即 `app.quit()` 且**不注册** `whenReady().then(bootstrap)`(否则第二个实例会重复注册 IPC handler、并发写 index.db/wsd.json、抢 MCP 端口);`bootstrap()` 里新增 `app.on('second-instance')` 把已有窗口 `restore/show/focus`(窗口已销毁则重建),二次启动不再"点了没反应"。
- ✅ **IPC 写入口拒绝位置根本身**:[allowed-roots.ts](../src/main/allowed-roots.ts) 新增 `assertNotLocationRoot`,与 MCP 共用同一检查(MCP 本地副本删除,守卫上移);[fs-write.ts](../src/main/ipc/fs-write.ts) 的 `deletePath` / `renameEntry` / `moveEntry` / `copyEntry` 与 [meta.ts](../src/main/ipc/meta.ts) 的 `sidecar:write` 全部补齐——此前只有 MCP 拒绝根,渲染层 IPC 仍可对整个位置做删除/移动/改名,而根的 sidecar 会写到 `dirname(root)/.whale/`(边界外)。`zipDirectory` 保持既有文档化豁免(归档落在根的兄弟目录属于「打包根」的正常语义,见 [fs-write.ts](../src/main/ipc/fs-write.ts) 注释)。
- 回归:新增 `revisions.test.ts`「恢复前自动备份当前内容」(恢复后列表 2 条、内容分别为 v1/v2)、`allowed-roots.test.ts` 的 `assertNotLocationRoot` 三例、`main.test.ts` 的「拿不到锁就退出、不 bootstrap」用例(electron stub 补 `requestSingleInstanceLock`);`npm run lint`、`npm run type-check`、`npm test` 全通过。

### P1-39. 2026-11 第 38 轮审核：位置只读下推主进程 ✅
- ✅ **只读位置不再只是渲染层约定**:[allowed-roots.ts](../src/main/allowed-roots.ts) 新增 `readOnlyRoots` / `setReadOnlyRoots` / `isReadOnlyPath` / `assertWritable`(fold 前缀包含,根自身算命中);`fs:setAllowedRoots` 收起第二个参数 `readOnlyRoots`,由 [fs-roots.ts](../src/main/ipc/fs-roots.ts) 过滤为「已接受 root 的子集」后落地,[preload.ts](../src/main/preload.ts) 与 [ipc-types.ts](../src/shared/ipc-types.ts) 同步,[Root.tsx](../src/renderer/containers/Root.tsx) 推送 `locationItems.filter(l => l.isReadOnly)`。此前只读标记只在渲染层:6 个视图的"另存为/拖入/粘贴新建" 、被注入的渲染层、以及 MCP 变更工具都能把文件写进只读位置。
- ✅ **写入口逐个接入 `assertWritable`**:[fs-write.ts](../src/main/ipc/fs-write.ts)(createDirectory / createTextFile / writeBinaryFile / deletePath / renameEntry 两端 / moveEntry 两端 / copyEntry 目的端 / zipDirectory / zipEntries / importExternal 目的目录)、[meta.ts](../src/main/ipc/meta.ts)(sidecar:write、sidecar:recoverCorrupt、folderMeta:write、tagLibrary 两个 setter)、[extensions.ts](../src/main/ipc/extensions.ts)(修订备份/写入/恢复/删除;`ext:cleanupRevisions` 只清理非只读 root)、[sidecar.ts](../src/main/sidecar.ts)(`writeSidecar` / `mutateSidecar` / `updateFileTags` —— MCP 标签工具走同一批函数)。
- ✅ **legacy sidecar 迁移在只读位置不再写盘**:[sidecar.ts](../src/main/sidecar.ts) 的 `migrateLegacySidecars` 读到只读位置时直接返回 legacy 标签、既不 `persistWsd` 也不把旧 JSON 改名隔离——此前"只是打开一个只读位置看一眼"就会触发迁移写 `.whale/wsd.json` 并重命名用户目录里的 JSON。
- 回归:`allowed-roots.test.ts` 新增 `read-only locations` 三例(根与子树都拒、嵌套在可写 root 内的只读 root 仍拒、清空只读集合后放行);`fs-write.test.ts` 新增「只读位置拒绝 create / move-in / copy-in / delete,且源文件与既有文件保持原样」;`docs/02`、`docs/13`、`docs/21` 同步边界描述。

### P1-40. 2026-11 第 38 轮审核续：P1-B 功能缺陷批次 ✅
- ✅ **DirectoryTree 文件行不再复用文件夹菜单**:[DirectoryTree.tsx](../src/renderer/components/DirectoryTree.tsx) 的 `ctxMenu` 增加 `isDirectory`,文件行只给「打开(交给 `openEntryInTab`)/ 重命名 / 删除 / 在系统打开 / 复制路径」,「新建文件夹 / 新建文件 / 打包」仅对文件夹出现——此前在文件行右键「新建文件夹」会把文件当父目录、必失败,「打开」则把文件路径当地址导航。
- ✅ **不可读目录不再冻结索引删除**:[index-db.ts](../src/main/index-db.ts) 的 `ingestFiles` 接受 `{complete:false, unreadable:[]}`,只保留不可读子树下的行、其余照常删除并重算 `files_count`;[index-worker.ts](../src/main/index-worker.ts) 把 `report.unreadable` 一并传入。此前一个永久 EPERM 目录让删除 pass 永远跳过,别处删掉的文件一直留在索引里继续命中搜索(与 P1-39 同轮,文档见 [docs/04](./04-search-index.md))。
- ✅ **扩展脏状态按标签而非文件路径**:[extensions.ts](../src/renderer/reducers/extensions.ts) 的 `editState` 键改为 `makeTabId(filePath, extensionId)`(action payload 字段 `filePath` → `tabId`),[ExtensionHost.tsx](../src/renderer/components/ExtensionHost.tsx) / [ExtensionTabBar.tsx](../src/renderer/components/ExtensionTabBar.tsx) / [ExtensionContextProvider.tsx](../src/renderer/hooks/ExtensionContextProvider.tsx) 全部改取 `tab.id`——同一文件被两个扩展同时打开时,关闭其一曾把另一个的 dirty 清掉,关闭确认因此被跳过。
- ✅ **macOS 开终端等真实退出码**:[shell-command.ts](../src/main/shell-command.ts) 的 `osascript` 分支改为 `stdio:['ignore','ignore','pipe']` + 等 `exit`,`code !== 0` 时 reject 并附 stderr 末尾(≤4KB);Windows 的 `cmd /k` 窗口常驻,保持只等 `spawn`。此前 Automation 权限被拒也返回"已启动"。
- ✅ **autoUpdateCheck 真正下发主进程**:新增 `app:update-set-auto-check`([main.ts](../src/main/main.ts) → [auto-update.ts](../src/main/auto-update.ts) 的 `setAutoUpdateCheckEnabled`,启动检查改成可取消/可补装的延时器),[UpdateSection.tsx](../src/renderer/components/UpdateSection.tsx) 在挂载与开关变化时推送——此前该设置只改 UI,启动静默检查照发。
- ✅ **text-editor 外部刷新重置撤销历史**:[text-editor/index.ts](../src/extensions/text-editor/index.ts) 在同路径外部刷新(缓冲区干净、内容被替换)时也 `historyCompartment.reconfigure(history())`——此前 Ctrl+Z 能撤回重载前的旧文本,下一次保存把过期内容写回刚被外部修改的文件。
- ✅ **html-viewer 关闭远程图片后行内 style 也不再外发**:[html-viewer/index.ts](../src/extensions/html-viewer/index.ts) 在 `imagesEnabled === false` 时对渲染后的 `[style]` 元素套 `stripRemoteCssRefs`(`data:` 保留)——此前只清理用户样式表,正文 `style="background:url(https://tracker/…)"` 仍会发请求。
- ✅ **FileList 键盘导航自动滚动**:[FileList.tsx](../src/renderer/components/FileList.tsx) 加 `listRef` / `gridRef`,焦点变化时 `scrollToRow` / `scrollToCell`(`smart` 对齐)——`Row` 用 `preventScroll` 聚焦且 react-window 只挂可见行,此前方向键把焦点移出视口后既没有可见光标也不再滚动。
- 复核为误报(不改):Gantt 条形拖拽阈值"双计数"不成立——`useBarDrag.ts` 的两个 pointermove 监听器都按绝对位移 `clientX - downXRef` 计算,且分别在 `pending` / `dragging` 状态互斥生效,不会把 8px 阈值提前到 4px。
- 回归:`index-db.test.ts` 新增「不可读子树保留、其余照删」(`unreadable` 传绝对路径、库内存 root 相对路径);`ExtensionHost.test.ts` 的 editState mock 改按 `tab-1` 键;`npm run lint`、`npm run type-check`、`npm test` 全通过。

### P1-41. 2026-11 第 39 轮审核：P2 批次(24 条)✅
- ✅ **缩略图内存缓存加上界**:[ThumbIcon.tsx](../src/renderer/components/ThumbIcon.tsx) 的 data-URL 缓存改为写入端淘汰(`THUMB_CACHE_LIMIT = 800`,Map 插入序)——此前只按目录切换清空,单目录翻 5000 张图可常驻 50–100MB。
- ✅ **ffmpeg 缩略图超时**:[thumbnail.ts](../src/main/thumbnail.ts) 的 `execFile` 加 `timeout: 10_000, killSignal: 'SIGKILL'`——损坏视频此前会挂住 worker 的队列位。
- ✅ **缩略图复用判据含大小**:同上文件记 `{mtimeMs, size}`(`generatedFrom`,上限 5000),同 mtime+size 才复用,内存未命中时退回旧 `target.mtimeMs >= srcMtime` 启发式——此前"savedN 秒内改内容"会复用旧图。
- ✅ **菜单在生产构建隐藏调试项**:[menu.ts](../src/main/menu.ts) 的 reload / forceReload / toggleDevTools 仅在 `!app.isPackaged` 时插入。
- ✅ **whale-file 协议不再同步 stat 主线程**:[main.ts](../src/main/main.ts) 改为先 `await fsp.stat`(不可达 SMB/设备文件不冻结),再把大小传给 [protocol-range.ts](../src/main/protocol-range.ts) 的 `knownSize` 参数(不再重复 `statSync`)。
- ✅ **错误不再被吞**:`shell:openTrash` 的 exec 错误改为 reject 带原因;[ipc/window.ts](../src/main/ipc/window.ts) 的 `drag:startFile` 先过 `assertWithinAllowedRoot` 并把拒绝写进 `console.warn`;`app.whenReady().then(bootstrap)` 加 `.catch`(`dialog.showErrorBox` + `app.exit(1)`),此前启动失败是静默黑窗。
- ✅ **审批模板原子写 + 唯一名**:[ipc/shell.ts](../src/main/ipc/shell.ts) 的 `persistApprovals` 改 `atomicWriteJson`(临时名带 pid+计数器),不再原地写。
- ✅ **MCP `whale_list_directory` 可截断**:[mcp-tools.ts](../src/main/mcp/mcp-tools.ts) 的 schema 加 `limit`(默认 1000,上限 5000),返回 `{count, truncated, entries}`——此前裸 `readdir` 结果全量回给模型。
- ✅ **测试 runner 加超时**:[scripts/run-tests.cjs](../scripts/run-tests.cjs) 的 `spawnSync` 加 30 分钟上限(ETIMEDOUT 单独报错),不再无限挂住 CI。
- ✅ **最近目录去重带 location**:[recent.ts](../src/renderer/reducers/recent.ts) 按 `(path, locationId)` 去重,[CurrentLocationContextProvider.tsx](../src/renderer/hooks/CurrentLocationContextProvider.tsx) 只记录属于当前 location 的目录——切位置时"旧目录 + 新 locationId"曾被持久化,点开必然越界并白占一个槽。
- ✅ **`week-YYYYMMDD` 进入日历**:[calendar.ts](../src/renderer/domain/calendar.ts) 的 `dateTagDayKey` 识别周标签(取该 ISO 周的周一)——此前 `nextWeek` 打的文件在日历中凭空消失。
- ✅ **font-viewer 抽屉不显示旧字形**:[font-viewer/index.ts](../src/extensions/font-viewer/index.ts) 把 `glyphGridRendered = false` 移到抽屉重绘之前。
- ✅ **扩展运行错误可见**:[ExtensionHost.tsx](../src/renderer/components/ExtensionHost.tsx) 的 `case 'error'` 除 `console.error` 外走 `notifyApp`(新键 `extensionRuntimeError`),并对 `parentSaveDocument` / `requestFileEmbed` / `requestFile` / `contentChangedInEditor` / `openLinkExternally` 补 payload 形状守卫——此前空白 iframe 只在 devtools 里留一行。
- ✅ **Lightbox Esc 语义**:[MediaLightbox.tsx](../src/renderer/components/MediaLightbox.tsx) 在捕获阶段接管 Escape 并 `stopPropagation`,先退缩放、再关闭——MUI Dialog 自己也会响应 Esc,导致"第一次按 Esc 直接关窗"。
- ✅ **sidecar 读失败不再伪装成"没有标签"**:[DirectoryContentContextProvider.tsx](../src/renderer/hooks/DirectoryContentContextProvider.tsx) 记录一条 `unreadable` issue 并 `notifyApp`(新键 `sidecarReadFailed`)——此前整目录静默渲染成无标签,用户会误以为元数据丢了。
- ✅ **Tag 清色不再被自动配色覆盖**:新增 `TAG_COLOR_CLEARED`(`''` 标记,[tag-colors.ts](../src/renderer/domain/tag-colors.ts)),[appearance.ts](../src/renderer/reducers/settings/appearance.ts) 的清色改存标记,两处自动配色与展示端(TagMetaContextProvider / TagGroups / PropertiesTray / TagMetaDialog)按 `in` 判定——此前清色后立刻被重新染色。
- ✅ **扩展双开去重**:[ExtensionContextProvider.tsx](../src/renderer/hooks/ExtensionContextProvider.tsx) 的 `openWithExtension` 加在飞集合 + `setTabs` 按 id 去重——双击会让同一文件开出两个标签、各自独立编辑态。
- ✅ **全文索引加路径前校验**:[SettingsDialog.tsx](../src/renderer/components/SettingsDialog.tsx) 拒绝非绝对路径与重复项(新键 `fulltextPathInvalid` / `fulltextPathDuplicate`)——此前错字会被持久化,永远停在 error 行。
- ✅ **Mapique 视野随标记集合刷新**:[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx) 的 `FitBounds` 改比对 `lat,lng` 集合而非数量增减——旧判据在首屏就有标记时永不 `fitBounds`,过滤/改标签后也不重取。
- 复核为误报(不改):Gantt 边缘拖拽的 clamp 已在 `periodWithResize` / `dayKeyFromOffset` 内做(可视窗口自动滚动属功能请求,不是缺陷)。
- 暂缓:`ipc/fs-write.ts` 的 win32 打包入口不走 `commonParentDir`——改归档层级语义无法在 Windows 上安全验证,风险大于不一致本身,记入本篇遗留。
- 暂缓:`html-viewer` 的用户 `<style>` 仍注入 `document.head`(见 `injectUserStyle`)——它作用于整个扩展页面,`body { … }` 这类规则会同时改工具栏样式。作用域化需要重写选择器(或换 shadow DOM),而该扩展自带样式与用户样式互相依赖,当前无自动化测试可兜底;影响限于该扩展自己的 iframe,不跨进程、不触网,故推迟到有截图回归后再做。
- 回归:新增 `recent.test.ts`(两条 location 同路径、15 条上限、REMOVE_LOCATION)、`settings.test.ts` 的清色标记用例、`calendar.test.ts` 的 `week-YYYYMMDD` 用例、`DirectoryContentContextProvider.test.tsx` 的"sidecar 读失败报 issue 且条目仍在";`npm run lint`、`npm run type-check`、`npm test` 全通过。

### P1-42. 2026-11 第 40 轮审核：P3 批次(6 条)✅

- ✅ **原子写并发键按 realpath 归一**:[atomic-write.ts](../src/main/atomic-write.ts) 的 `targetKey` 先真身解析再折叠——同一文件经符号链接 / 8.3 短名会有两个队列键,两条队列各自 `rename` 同一 inode(`EPERM` 或静默丢一次写)。
- ✅ **恢复修订保留权限位**:[revisions.ts](../src/main/revisions.ts) 的 `restoreRevision` 先读 `stat().mode & 0o777` 再传给 `atomicWriteBytes({ mode })`——否则 tmp+rename 会用默认 mode 把 `0600` 的文件悄悄放宽。
- ✅ **MCP 会话数上限**:[mcp-http.ts](../src/main/mcp/mcp-http.ts) 新增 `maxSessions`(默认 32),新建前按 `lastSeen` 驱逐最久未用会话而不是拒绝;不发 `DELETE` 的客户端不会把 MCP 卡死。
- ✅ **`SortableHeader` 提到模块作用域**:[FileListHeader.tsx](../src/renderer/components/FileListHeader.tsx) 原在组件体内定义,每帧产生新组件身份(焦点丢失、ripple 重启);顺带把 `RowColumnLabels` 的排序回调收进组件。
- ✅ **Mapique 被筛掉的 marker 仍可点选**:[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx) 的 `handleMarkerClick` 先用未过滤 `allTrayEntriesRef` 按路径回查——tray 过滤 / 名称搜索隐藏了行,地图上的 marker 仍在,此前点击被静默丢弃。
- ✅ **html-viewer 用户 CSS 作用域化**:[html-viewer/index.ts](../src/extensions/html-viewer/index.ts) 注入后按 `cssRules` 把选择器重写为 `#content …`(`html`/`body`/`:root` 映射为 `#content`),`@media`/`@supports` 递归;`body{display:none}` 不再能连带干掉工具栏。
- 回归:新增 `revisions.test.ts` 的「恢复保留 POSIX mode」、`mcp-http.test.ts` 的「会话上限驱逐 LRU」;`npm run lint`、`npm run type-check`、`npm test` 全通过。

---

## 🟡 P2 — 类型逃逸

### P2-1. ECharts 回调集群 ✅
[folderviz.ts](../src/renderer/domain/folderviz.ts) 定义 `EChartsFolderVizNode`,三个 `toECharts*` 返回它并透传 fileCount;[FolderVizView.tsx](../src/renderer/components/FolderVizView.tsx) 走该类型 + 本地 `FolderVizChartParam`,顺带修 `echartsData.size`→`value`(类型化暴露的真 bug:rootSize 在 `any` 下拿不到值);[TagCloudView.tsx](../src/renderer/components/TagCloudView.tsx) wordCloud + heatmap 两套 param 类型;[CalendarView.tsx](../src/renderer/components/CalendarView.tsx) formatter union + `echarts.graphic.LinearGradient`(echarts/core 已注册 GraphicComponent,去 `as any`)。共 ~26 处生产 `any` 消除。

### P2-2. `DirectoryTree.tsx` 节点类型逃逸 ✅
定义 `TreeFolderNode`/`TreeFileNode`/`TreeNode` 判别联合,TreeRow 的 `nodes`/`renderFolder`/`renderFile` 全类型化、去 3 个 eslint-disable,`node.kind` discriminant 自动 narrow。react-window v2 的 `rowProps` 处保留一处 `as any`(库类型 `ExcludeForbiddenKeys` 反向要求 index/style)。

> **类型现状**:`src/shared`、`src/main/ipc`、`allowed-roots.ts`、`shell-quote.ts` 严密;主进程生产代码零 `: any`;现存 `as unknown as` 只出现在 worker 消息 / canvas 互操作边界([thumbnail.ts](../src/main/thumbnail.ts) 的 `stdout as unknown as Buffer`、两个 worker host 的 `.on('error')`、[thumb-render.ts](../src/main/thumb-render.ts) 的 canvas context),范围窄且不暴露不可信输入。全仓零 `@ts-ignore` / `@ts-nocheck`。

---

## 🟡 P3 — 重复模板 & 超大组件(可维护性)

### P3-1. localStorage 读写模板 ✅
[FolderVizView.tsx](../src/renderer/components/FolderVizView.tsx) 已复用 [perspective-prefs.ts](../src/renderer/domain/perspective-prefs.ts) 的 `readPrefs/writePrefs`；key、四种视图白名单、默认值与永不抛出的读写语义不变，未新增第二套 helper。

### P3-2. `clampFontSize` 双胞胎 ✅
md-editor 的副本已随 0.4.9 删除,仅剩 [text-editor/editor-stats.ts](../src/extensions/text-editor/editor-stats.ts) 一份,不需要抽共享模块。

### P3-3. 超大组件低风险拆分 ✅
[FileList.tsx](../src/renderer/components/FileList.tsx) 的 visible 标签过滤已抽为 [file-list-filter.ts](../src/renderer/domain/file-list-filter.ts) 纯函数并补 6 条共置测试；[SettingsDialog.tsx](../src/renderer/components/SettingsDialog.tsx) 的 `ExtensionsSection` 已机械移至 [ExtensionsSection.tsx](../src/renderer/components/ExtensionsSection.tsx)。本轮不牵连 selection/commands、其它 section 或 UI 结构。

### P3-4. extension viewer `getPref/setPref` 拷贝 ✅
[viewer-prefs.ts](../src/extensions/shared/viewer-prefs.ts) 的 `createViewerPrefs(prefix)` 统一 [font-viewer](../src/extensions/font-viewer/index.ts) / [html-viewer](../src/extensions/html-viewer/index.ts) 偏好读写；prefix、key、默认值及读失败返 null/写失败静默的语义不变。

### P3-5. `drawio-editor` iframe 销毁 TODO ✅
[drawio-bridge.ts](../src/extensions/drawio-editor/drawio-bridge.ts) 统一清理 XML timer/pending requests/theme 与内部状态，销毁后拒绝新请求；[useWhaleBridge.ts](../src/extensions/drawio-editor/useWhaleBridge.ts) 提供独立幂等的 save-handler 注销，[app.tsx](../src/extensions/drawio-editor/app.tsx) 区分 effect 重跑与真实卸载：刷新不取消已开始的保存/图片插入，卸载后不再继续更新；文件切换时会中止旧文档尚未完成的图片插入。共置生命周期测试覆盖 listener、timer、pending reject、handler 身份、保存/插入中途刷新、文件切换及 export 与卸载同 tick 的竞态。

---

## ✅ 已记录在 docs、不在本篇重复

| 项 | 出处 |
|---|---|
| 位置级 AES-256-GCM 加密 / 安全审计日志未做;扩展能力「全有或全无」;postMessage `targetOrigin:'*'` 收窄 | [docs/13](./13-security.md) §1/§9/§10、[docs/07 §10](./07-extensions.md) |
| mac 代码签名硬阻塞;Linux DE fallback 链 / 图标 / 递归监听 | [docs/16](./16-cross-platform.md) B-1 / C-2~C-5 |
| `readSidecars` 每目录重读;`extractPdfText` 整 PDF 读内存;`loadFolderThumbnail` 无 LRU | [docs/15](./15-perf-audit.md) P2-1/P3-1 |
| macOS notarization 阻塞自动更新 | [docs/18](./18-auto-update.md) |
| Mapique 地名搜索已尝试并回退(勿照原样重试) | [docs/05 §10](./05-perspectives.md) |

---

## 已接受的取舍

| 项 | 出处 | 理由 |
|---|---|---|
| 抽 `execFileBuffer` / `onUtilityProcessError` 消除主进程 `as unknown as` | 本篇 P2-3(2026-07-28 评估) | 会牵连 ffmpeg 的 ~1s 超时 fallback 重试路径,风险 > 收益;helper 只能消 2 处 cast,ROI 低 |
