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
- 主进程 SQLite 阻塞由分批提交缓解;**真阻塞场景已移到下一阶段**:考虑 `utilityProcess` 沙箱跑
