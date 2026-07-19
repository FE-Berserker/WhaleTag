← 返回 [plan.md](../plan.md)

# 04. 搜索与索引

> SQLite FTS5 即时搜索、目录索引、全文索引、高级查询、保存的搜索。

## 1. 索引层

每个 root 下生成 `<root>/.whale/index.db`(SQLite)。[src/main/index-db.ts](../src/main/index-db.ts):

- `files` 表:path / name / size / mtime / ext / isDir / sidecar 字段
- `files_fts`:FTS5 virtual table + trigram tokenizer(filename + tags 模糊匹配)
- `fulltext_fts`:FTS5 virtual table(全文 snippet)
- `exif_processed`:已抽 GPS 的文件缓存(防止 N 次扫描重抽)
- 触发器同步 `files` ↔ `files_fts`

**增量重建**:`buildFulltextIndex` 只 select `path + mtime`(**不把全文 content load 进内存**);mtime 未变的行原样留在表里(不重抽、不重插),改动 / 新增才抽 → `insertFulltext`,消失的 path → `deleteFulltextPaths`,见 [src/main/fulltext.ts](../src/main/fulltext.ts)。旧"DELETE-all + 重 INSERT-all"策略要把每个文件正文搬进内存再全量重写,大语料冻结数秒。

**分批提交**:`INGEST_BATCH = 1000`,批间 `setImmediate` yield —— 首次大目录索引不冻结主进程。`QUERY_LIMIT = 50` / `ADV_LIMIT = 300`。

## 2. 索引构建 / 重建

```ts
// 主进程入口 ipc
buildLocationIndex(rootPath)                // 全量重建(目录遍历 mapWithConcurrency 8 并发)
buildFulltextIndex(rootPath)                // 全文增量重建(遍历 + 抽取 mapWithConcurrency 8 并发)
ingestFiles(rootPath)                       // 增量
ingestFulltext(rootPath, records)           // 全文全量替换(测试 / 独立全量用)
insertFulltext / deleteFulltextPaths        // 增量 delta 的两半
markExifProcessed(rootPath, record)         // 单条标记已抽 GPS
markExifProcessedMany(rootPath, records[])  // 批量(一个事务 + fsync)—— Mapique 抽 GPS 用
loadExifProcessed(rootPath)                 // 查询
```

`TaskReminder` 启动时总是重 build 索引,确保子目录新打的 pending workflow tag 能被检索到。

## 3. 即时搜索(UI 行为)

- 顶部 SearchBar:输入关键字(文件名 + 标签)模糊匹配,**Enter 触发**(`SQLite FTS5 trigram`),非逐键
- 命中关键字高亮
- 结果行含文件类型图标 + 路径 + snippet

## 4. 全文搜索

- `fulltextSearch(rootPath, query)`:snippet 形式展示匹配上下文
- 大目录下流式返回,不爆内存

## 5. 高级查询

[src/renderer/components/AdvancedSearchDialog.tsx](../src/renderer/components/AdvancedSearchDialog.tsx) 按 **SearchQuery** 类型([src/shared/search-query.ts](../src/shared/search-query.ts))组合:

- 类型 / 扩展名 / 大小 / 日期 / 标签(含 / 排除)
- AND / ANY 逻辑
- 多个 condition 组合

`SearchQuery` 字段(`search-query.ts:17-35`):`text, tags, tagMatch, excludeTags, type, extensions, sizeMinBytes, sizeMaxBytes, modifiedAfter, modifiedBefore`(共 10 字段)。renderer 经 `-/services/search-filter` 薄 shim (`src/renderer/services/search-filter.ts`) 转发到 `src/shared/search-query.ts`,shim 不再加工。

结果在主进程拼 SQL → 返回带 snippet 的条目列表。

## 6. 保存的搜索

[src/renderer/reducers/savedsearches.ts](../src/renderer/reducers/savedsearches.ts):

- `savedSearches: SavedSearch[]` 走 redux-persist
- Save / 调用 / 列表管理 UI

## 7. 文本抽取

[src/main/fulltext.ts](../src/main/fulltext.ts) 覆盖:

- 纯文本 / Markdown / HTML / 代码类(直接读)
- PDF(`pdfjs-dist`,纯 JS 主进程抽取,经 `getPdfjs()` 惰性 load,见 [docs/01 §4](./01-architecture.md))
- **并发抽取**:`buildFulltextIndex` 的 walk + `extractText` 用 `mapWithConcurrency(8)` 并发(子目录递归 + 文件抽取重叠);共享的 `seen` / `count` / `upserts` 只在 `await` 之间同步变异,JS 单线程下无竞态。FTS5 的 `DELETE WHERE path = ?` 已实测可用,支持增量 upsert / delete

媒体(binary)不参与全文索引。

## 8. EXIF / GPS

[src/main/exif.ts](../src/main/exif.ts):

- `extractGps(buffer)` / `getExifSummary(buffer)`
- 已抽过 GPS 的文件写入 `exif_processed` 缓存,下次跳过;**Mapique 批量抽 GPS 时攒满 25 条或 batch 结束才 `markExifProcessedMany` 落盘**(一个事务 + 一次 fsync,以前每张图一个 fsync)
- Mapique 用 `geoByName` map(O(1) 查)渲染 marker

## 9. 已知坑

- 首次索引大目录(数 GB / 数十万文件)虽已分批 yield,但仍耗时 —— UI 用 loading + spinner 反馈
- 索引丢失单事务原子性(可接受,缓存可重建)
- 主进程 SQLite 阻塞**已解决**:索引 / 全文 / EXIF 管线迁入 `utilityProcess` 子进程(`serviceName: 'whale-index'`,入口 `src/main/index-worker.ts`,宿主 `index-worker-host.ts`)。better-sqlite3 的 `openDbs` 缓存现在 scoped 到该子进程,主进程事件循环不再被同步 DB 调用阻塞。批让步(`INGEST_BATCH=1000` / `setImmediate` / `mapWithConcurrency`)在子进程内沿用。设计 / 排坑见 [docs/15 P0-2](./15-perf-audit.md);`assertWithinAllowedRoot` 仍在主进程校验,不信任 renderer、不下游重复。

## 10. 架构审阅遗留(2026-07-18)

- **DB 连接生命周期**:~~`closeDb` 生产零调用~~ ✅ 已接入(2026-07-18):新 op `index:close`([index-protocol.ts](../src/main/index-protocol.ts) → [index-worker.ts](../src/main/index-worker.ts) → [host `closeIndexDb`](../src/main/index-worker-host.ts),worker 未运行则跳过不白 spawn);`fs:setAllowedRoots` 处理器对**上一次推送的 raw roots** 做 diff,消失的 root = 被移除的 location → fire-and-forget 关连接(index-db 的 `openDbs` 以渲染层原始路径为 key,不能用 `getAllowedRoots()` 的 fold 后形式 diff)。~~退出 SIGKILL 无 WAL checkpoint~~ ✅ 已修(同日):新 op `index:shutdown` → `closeAllDbs()`(WAL 随干净 close checkpoint 回主库,无 `-wal` 残留);`before-quit` 改两段式 —— `preventDefault` 先跑 `shutdownIndexWorker()`(1s 超时兜底,卡死也不挂退出),再 kill 四个子进程并 `app.quit()` 真正退出。
- ~~无失效机制~~ ✅ 已接(2026-07-18):[dir-watcher.ts](../src/main/dir-watcher.ts) 每个 location root 一个 `fs.watch {recursive:true}` —— 500ms 尾沿去抖 + 路径归并(500 条/批上限)+ `.whale/**` 自写回声过滤 → 广播 `fs:dirChanged`;`DirectoryContentContextProvider` 命中当前目录(或溢出时空包)即 300ms 去抖重载。索引同步:**仅当 `index:status` ready(索引已存在)才触发增量 `index:build`**(1.5s 去抖,per-root in-flight 守卫)—— 从不为未索引 root 建 `.whale/index.db`,只读位置因此零写入。fulltext 索引同规则(2026-07-18 二段):渲染层推送 `settings.fulltextPaths`(Root.tsx → `fulltext:syncPaths` → `setFulltextRoots`;fulltext 根必在某 location 下,location watcher 已覆盖事件),flush 匹配「变更落在哪个 fulltext 根内」→ 去抖增量 `fulltext:build`(**仅当 `fulltext:has` 为真**,同样不白建、只读零写);`index:build`/`fulltext:build` 的进度经既有 `index:progress` 通道自然回流。目录树侧栏同规则(2026-07-18 三段):DirectoryTree 订阅 `onDirChanged`,变更路径 → 父目录 ∩ 已加载目录([directory-tree-refresh.ts](../src/renderer/components/directory-tree-refresh.ts) 纯函数,未加载目录跳过——展开时本就懒加载;watch 缓冲溢出降级为全量已加载重刷),300ms 去抖逐父 `reloadChildren`。**平台**:recursive 支持 Windows/macOS;Linux 抛 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` → 该 root 回落手动刷新(跨平台项,见 [docs/16](./16-cross-platform.md))。**未接(明确留后)**:Linux per-dir 递归监听。测试:[dir-watcher.test.ts](../src/main/dir-watcher.test.ts)(谓词单测 + 真实 fs.watch 集成:广播/`.whale` 抑制/ready 才重建/移除即关/fulltext 内触发·外不触发·has=false 不建)+ [directory-tree-refresh.test.ts](../src/renderer/components/directory-tree-refresh.test.ts) 7 例。
- ~~进度推送未接~~ ✅ 已接(2026-07-18):`index:build` 报 `scan`(indexer 逐目录)/ `ingest`(index-db 逐 1000 批,含总数)两段,`fulltext:build` 报 `extract`(逐文件,无总数);worker 侧 100ms 节流 poster + 完成时发 `done: true` 终止事件(响应前);main.ts `subscribe` 广播 `index:progress` → preload `onIndexProgress`(返回退订);SearchBar 在构建时显示「索引中… N / N/M」,Settings → 全文 构建按钮旁显示实时计数。**顺带修了一个存量 bug**:worker 的 `fulltext:build` 旧代码 `const count = await buildFulltextIndex()`(返回 `{count}` 对象)再 `result: {count}` —— 结果双重嵌套 `{count:{count}}`,设置里「已索引 N 个文件」实际显示 `[object Object]`(P0-2 引入,类型被 `result: unknown` 掩盖);本次解构修正。
