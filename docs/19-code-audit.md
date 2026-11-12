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
| `strictNullChecks` 未开;`readSidecars` 每目录重读;`extractPdfText` 整 PDF 读内存;`loadFolderThumbnail` 无 LRU | [docs/09 §28](./09-known-issues.md)、[docs/15](./15-perf-audit.md) P2-1/P3-1 |
| macOS notarization 阻塞自动更新 | [docs/18](./18-auto-update.md) |
| Mapique 地名搜索已尝试并回退(勿照原样重试) | [docs/05 §10](./05-perspectives.md) |

---

## 已接受的取舍

| 项 | 出处 | 理由 |
|---|---|---|
| 抽 `execFileBuffer` / `onUtilityProcessError` 消除主进程 `as unknown as` | 本篇 P2-3(2026-07-28 评估) | 会牵连 ffmpeg 的 ~1s 超时 fallback 重试路径,风险 > 收益;helper 只能消 2 处 cast,ROI 低 |
