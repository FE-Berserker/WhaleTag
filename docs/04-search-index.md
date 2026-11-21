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

**增量重建**:`buildFulltextIndex` 只 select `path + mtime`(**不把全文 content load 进内存**);mtime 未变的行原样留在表里(不重抽、不重插),改动 / 新增才抽 → `insertFulltext`,消失的 path → `deleteFulltextPaths`,见 [src/main/fulltext.ts](../src/main/fulltext.ts)。(取代旧的全量重写策略 —— 大语料下须把每个文件正文搬进内存,冻结数秒。) **读取失败 ≠ 文件被删**:遍历中打不开的目录 / 条目、以及超过 128 MiB 的 PDF 记入 `skipped`,它们既有的行**保留**(仍然可搜索,等下一次构建成功再刷新),绝不算进 removed —— 瞬时权限错误不会把已索引内容清空。读取失败与"空文件"在 `extractText` 内部用 `unreadable` 标志区分。

**分批提交**:文件名索引 `INGEST_BATCH = 1000`,批间 `setImmediate` yield;全文新增 / 改动另按 `FULLTEXT_UPSERT_BATCH = 100` 批写,避免首建把所有抽取正文同时驻留内存。每批在一个事务里先 delete 本批路径再 insert;只有完整 walk 且末批成功后才删除消失路径。中途失败时当前批回滚,已成功的前批保留,`upsertFailure` 阻止残余抽取 worker 继续提交;下一次增量重建按 prior mtime 重试未落盘项,不伪造完整构建。`QUERY_LIMIT = 50` / `ADV_LIMIT = 300`。

## 2. 索引构建 / 重建

```ts
// 主进程入口 ipc
buildLocationIndex(rootPath)                // 全量重建(目录遍历 mapWithConcurrency 8 并发)
buildFulltextIndex(rootPath)                // 全文增量重建(遍历 + 抽取,100 条批写)
ingestFiles(rootPath)                       // 增量
ingestFulltext(rootPath, records)           // 全文全量替换(测试 / 独立全量用)
insertFulltext / deleteFulltextPaths        // 增量 delta 的两半
markExifProcessed(rootPath, record)         // 单条标记已抽 GPS
markExifProcessedMany(rootPath, records[])  // 批量(一个事务 + fsync)—— Mapique 抽 GPS 用
loadExifProcessed(rootPath)                 // 查询
```

`TaskReminder` 启动时总是重 build 索引,确保子目录新打的 pending workflow tag 能被检索到。

**侧车读失败不擦标签**:遍历时若某个目录的 `wsd.json` 读不出(损坏 / 权限),`buildIndex` 仍会返回该目录的文件,但每条带 `tagsUnreadable: true`——此时 `tags` 只有文件名里解析出的标签。`ingestFiles` 对带该标记的行**保留数据库里已有的 tags**(`ON CONFLICT ... tags=CASE WHEN @keep_tags THEN files.tags ELSE excluded.tags END`),并且不做"签名未变就跳过"的优化(partial 视图永远算不上未变)。这样一次瞬时读失败不会把位置里的标签从搜索/标签过滤里抹掉;下次读取成功时仍以侧车为准(清空标签会真正清空)。

**根目录不可读 ≠ 全部删除**:删除 pass 只在 `complete` 时运行,而 `complete` 曾把根目录自身的 ENOENT 也当成"子目录真的没了"——网络盘/外接盘未挂载时启动,该位置在索引里的全部行会被删掉,且 `ready = count > 0` 变 false 后 watcher 不再重建,盘回来也不自愈。现在根目录读取失败与子目录一样进 `unreadable`(`dir === rootPath || !isVanished(error)`),`complete=false` 时不执行删除。

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
- PDF(`pdfjs-dist`,在索引 worker 内抽取,经 `getPdfjs()` 惰性 load,见 [docs/01 §4](./01-architecture.md));单文件超过 `MAX_PDF_BYTES = 128 MiB` **直接跳过并保留旧索引行**——pdfjs 必须把整个文件读进内存,不设上限时一个多 GB 的 PDF 会打爆索引 worker;MCP 的 `whale_extract_text` 对超限 PDF 返回明确错误。`readFile` 的 Buffer 以精确 `byteOffset / byteLength` 视图交给 pdfjs:大文件复用原 ArrayBuffer、不再复制第二份 128 MiB,也不直接传 pdfjs 会拒绝的 Node Buffer 或暴露共享 pool 的底层整块内存。
- **并发抽取**:`buildFulltextIndex` 的目录 walk 仍用各目录的 `mapWithConcurrency(8)` 让子目录递归与文件抽取重叠,但非 PDF `extractTextDetailed` 统一经过模块级 `Semaphore(8)`,嵌套目录及同 worker 的并发构建不再叠乘提取压力;PDF 不占非 PDF 许可,只走原有 PDF 2 路专用闸门,避免 PDF 排队饿死文本,直接 MCP 抽取路径不变。PDF 从 readFile 到 `loadingTask.destroy()` 另受模块级 `Semaphore(2)` 约束,覆盖首建 / 增量 / 直接 `extractText`,防止多层目录并发与大 Buffer 叠加。10s PDF 超时结算后页循环在 `getPage` / `getTextContent` 前后检查并停止后续抽取；异常路径的 `loadingTask.destroy()` 最多等待 1 秒，即使 pdfjs 销毁 Promise 永不 settle 也会结算调用并释放许可，正常完成仍等待销毁以回收 worker 与解析缓冲。共享的 `seen` / `count` / 100 条 batch queue 只在 `await` 之间同步变异,JS 单线程下无竞态。FTS5 的 `DELETE WHERE path = ?` 已实测可用,支持增量 upsert / delete。删除集合由纯函数 `selectRemoved(prior, seen, skipped)` 计算:跳过路径按**路径边界**豁免(`a/b` 覆盖 `a/b/c`,不覆盖 `a/bc`;`''` 表示根目录本身不可读 → 一条都不删)

媒体(binary)不参与全文索引。

## 8. EXIF / GPS

[src/main/exif.ts](../src/main/exif.ts):

- `extractGps(buffer)` / `getExifSummary(buffer)`
- 已抽过 GPS 的文件写入 `exif_processed` 缓存,下次跳过;**Mapique 批量抽 GPS 时攒满 25 条或 batch 结束才 `markExifProcessedMany` 落盘**(一个事务 + 一次 fsync,以前每张图一个 fsync)
- Mapique 用 `geoByName` map(O(1) 查)渲染 marker

## 9. 已知坑

- 首次索引大目录(数 GB / 数十万文件)虽已分批 yield,但仍耗时 —— UI 用 loading + spinner 反馈
- 索引丢失单事务原子性(可接受,缓存可重建)
- 主进程 SQLite 阻塞**已解决**:索引 / 全文 / EXIF 管线迁入 `utilityProcess` 子进程(`serviceName: 'whale-index'`,入口 `src/main/index-worker.ts`,宿主 `index-worker-host.ts`)。better-sqlite3 的 `openDbs` 缓存 scoped 到该子进程,主进程事件循环不再被同步 DB 调用阻塞;批让步(`INGEST_BATCH=1000` / `setImmediate` / `mapWithConcurrency`)在子进程内沿用。设计 / 排坑见 [docs/15 P0-2](./15-perf-audit.md);`assertWithinAllowedRoot` 仍在主进程校验,不信任 renderer、不下游重复。

## 10. 架构审阅遗留(2026-07-18,已闭环)

> 本节只留"当前形态下仍会踩的坑";实现细节见 §1 / §2 / §3,逐轮证据见 [docs/19](./19-code-audit.md)。

- **DB 连接生命周期**：`index:close` 关连接、`index:shutdown` 干净 close（WAL checkpoint）;`before-quit` 两段式先 `shutdownIndexWorker()`（1s 超时兜底）。
- **变更 → 重建**：仅当 `index:status.exists` 为真才增量 `index:build`（1.5s 去抖、per-root in-flight、dirty 补跑、失败按 1.5s 起翻倍到 60s 退避）;fulltext 仅当 `fulltext:has` 为真;`.whale/**` 回声过滤;Linux 无 recursive 时 per-dir 监听（上限 4096）。
- **静默失效防线**：worker 请求看门狗（`WorkerRequestTimeout`，60s / 30s / 5s）、watcher 自愈退避、走查不完整只冻结不可读子树。
- **并发与遍历边界**：`index:build` / `fulltext:build` 按 root 串行;符号链接文件跟随、目录不下降;500 条/批突发改「下一 tick 续 drain」+ 5s 强制 flush。
