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

**增量索引**:mtime 未变复用旧 entry,见 [src/main/fulltext.ts](../src/main/fulltext.ts)。

**分批提交**:`INGEST_BATCH = 1000`,批间 `setImmediate` yield —— 首次大目录索引不冻结主进程。`QUERY_LIMIT = 50` / `ADV_LIMIT = 300`。

## 2. 索引构建 / 重建

```ts
// 主进程入口 ipc
buildLocationIndex(rootPath: string)        // 全量重建
ingestFiles(rootPath: string)               // 增量
ingestFulltext(rootPath: string, paths)     // 全文批量
markExifProcessed(rootPath, path)           // 标记已抽 GPS
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
- PDF(`pdfjs-dist`,纯 JS 主进程抽取)

媒体(binary)不参与全文索引。

## 8. EXIF / GPS

[src/main/exif.ts](../src/main/exif.ts):

- `extractGps(buffer)` / `getExifSummary(buffer)`
- 已抽过 GPS 的文件写入 `exif_processed` 缓存,下次跳过
- Mapique 用 `geoByName` map(O(1) 查)渲染 marker

## 9. 已知坑

- 首次索引大目录(数 GB / 数十万文件)虽已分批 yield,但仍耗时 —— UI 用 loading + spinner 反馈
- 索引丢失单事务原子性(可接受,缓存可重建)
- 主进程 SQLite 阻塞由分批提交缓解;**真阻塞场景已移到下一阶段**:考虑 `utilityProcess` 沙箱跑
