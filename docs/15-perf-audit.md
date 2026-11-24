← 返回 [plan.md](../plan.md)

# 15 · 性能审计与待办清单

> 2026-07-12 全量性能审计的追踪清单(plan.md §D「文档维护约定」第 4 条的**例外**)。每项完成后压成 1–2 行 ✅(保留「做了什么 + 关键坑」,细节在 git/code);评估不做的移到文末「已接受的取舍」。

**审计方法**:`src/main` + `src/renderer` 代码扫描 + docs(01/04/06/08/09)遗留提取。代码内无 TODO/FIXME 标记——发现均来自代码本身。

> **归档**:0.4.9 瘦身移除的 office / CAD / 电子书 / 压缩包 / pdf-viewer / md-editor / AI 助手模块,其专属性能项(soffice·ebook·dwg2dxf 异步探测、office→PDF 字节桥、office-viewer 冷转码占位与滚动同步、LibreOffice UNO 常驻进程、pdf-viewer 字节桥、AI 流式去重)已随代码一并删除,不再追踪,通用教训保留在文末「可复用范式」。

> **2026-11-23 GUI 审核 P2 视图性能修复**:稳定 `columnLabels`/`commandsDeps`/`cellData` 引用以恢复 memo,目录树缓存原始列表、把隐藏过滤下沉到行构建,MediaLightbox 键盘监听不再随缩放重绑,Mapique 删除多余 forceRender,Calendar 的 DayCell/常量数组 memo 化,KnowledgeGraph 的 prefs 写入只在切位置/卸载各一次,四视图的新增/删除/拖拽统一走 `lookupEntry`/`lookupEntryIndex` 的 O(1) 查找;GridCell/PropertiesTray 与 Row 统一 `listDateFormat`。实现细节见对应组件注释。

---

## 🔴 Tier 0 — 最大收益

### P0-1. files 索引增量 ✅
[index-db.ts](../src/main/index-db.ts) `ingestFiles` 增量:`filesPrior(rootPath)` + 签名 `mtime|size|tags` 命中即跳过 upsert(不碰 `files_au` FTS 触发器),删除 = `prior` 里不在 `seen` 的逐条删。**tags 必须进签名**——sidecar 改标签不改 mtime,漏了标签编辑就不重索引。

### P0-2. 索引进 utilityProcess 沙箱 ✅
[index-worker.ts](../src/main/index-worker.ts) + [index-worker-host.ts](../src/main/index-worker-host.ts)(惰性 spawn / 崩溃重 spawn / before-quit kill)+ [index-protocol.ts](../src/main/index-protocol.ts)(op 判别联合);`ipc.ts` handler 转 `request()` 转发,`assertWithinAllowedRoot` 留主进程。**打包三坑**:`utilityProcess.fork` 是 asar 原生(别做 asar→unpacked 重写);worker 用 `process.parentPort`(不是 `import { parentPort }`);entry 锚 `__dirname`(dev 的 `getAppPath` 是项目根)。详见 [docs/04 §9](./04-search-index.md) / [docs/09 §23](./09-known-issues.md)。

### P0-3. Mapique marker 不重建 ✅
[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx) 抽 `React.memo <GeoMarker>`,传原始 `state` 字面量(非整 `selected` Set)。**真 spoiler**:`selectRow` 闭包捕获 `visibleTrayEntries`,`distance` 排序下每次 `moveend` 都换身份 → 废掉所有 marker memo;改 ref(`visibleTrayEntriesRef` + `trayIndexByPathRef`,顺带 O(n) `findIndex`→O(1))。

### P0-4. Kanban/Matrix/Gantt 卡片 memo + 虚拟化 ✅
① `EntryCard = memo(EntryCardBase)`,3 个 prop 全 ref-stable;`renderContextMenu` 各视图 `useCallback`(选择仍生效:`isSelected` 挂 `selectedTick`)。② 新增 [EntryCardStack.tsx](../src/renderer/components/EntryCardStack.tsx):react-window v2 `List` + `useDynamicRowHeight`,接 Kanban 列体 + Matrix 象限体。**坑**:row 不能 `memo`(v2 要函数);row 包 flex-column 让卡片 `mb:1` 算进测量高;横向 tray 不虚拟化。DnD 不受影响(drop target 是包裹 Box)。

---

## 🟠 Tier 1 — 高收益小改

### P1-1. 异步二进制探测 ✅
外部转换二进制探测改异步 `execFile` + `_inflight` 去重、返 `Promise<string|null>` 的历史改造已随 office/CAD/电子书转换栈删除;同一模式现在只剩 HEIC wasm 读取(`requestHeicWasm` → `forwardRpc`)与主进程内联能力,`execFile` 的 callback 化原则仍适用于任何新增外部二进制。

### P1-2. persist 删 console.log ✅
[persist-storage.ts](../src/main/persist-storage.ts) 删 3 条 debug `console.log` + 多余 eslint-disable,保留 catch 分支的 `console.error`(真 IO 失败诊断)。见 [docs/02 §8](./02-file-io.md)。

### P1-3. viewDepth>1 递归聚合缓存 ✅
[recursive-cache.ts](../src/main/recursive-cache.ts):按 `<dir>/.whale/index-recursive/d<depth>.json` 缓存 scan 结果;**双守卫失效**(`dirPath` 挡文件夹移动 + `folderMtime` 挡子项增删),`invalidateRecursiveScan` 清祖先 ≤5 层,挂 6 个 fs-op 钩(含原先无钩的 mkdir)。sidecar 读更便宜,故未纳入。

### P1-4. GanttRow memo 解锁 ✅
GanttView→GanttTimeline 的 6 个内联闭包稳定为纯转发 / `useCallback`。**真 spoiler**:GanttTimeline 的 per-row `onCommit` adapter 每行新函数 → 把 entry-binding 下沉进 GanttRow(同 `onClick` 模式),Timeline 直传。

### P1-5. 文件夹缩略图并发上限 ✅
[concurrency.ts](../src/main/concurrency.ts) 加 `thumbnailSemaphore = Semaphore(4)`,`doGenerateThumbnail` 只把 encode+write 包进 `run`(便宜的 kind/stat/reuse 短路留 permit 外)。所有调用方自动覆盖。

---

## 🟡 Tier 2 — 中等收益

### P2-1. 缩略图内存缓存 ✅
[thumbnail.ts](../src/main/thumbnail.ts) `loadThumbnail` 加进程内 LRU(`Map<path,{mtimeMs,dataUrl}>`,cap 500);失效信号 = thumb 文件 `mtimeMs`(重生成必换 mtime → 自动 miss),`fsp.stat` 兼存在检查。**未做**:`loadFolderThumbnail` 同形但频率低;`whale-file://` 直传是更彻底退路。

### P2-2. count(*) 轮询 → O(1) ✅
[index-db.ts](../src/main/index-db.ts) 加 `meta(key,value)` 表,`files_count` 每次 ingest 末尾写 `seen.size`(自愈);老库回退一次 `count(*)`;`hasFulltext` 改 `SELECT 1 ... LIMIT 1`。

### P2-3. prepared statement 缓存 ✅
`prepareCached(db, sql)` + `WeakMap<DB, Map<sql, Statement>>`(按 DB 实例 key,关连接自动回收),只缓存热路径(文件查询 / 高级查询 / distinctTags / 全文查询)。

### P2-4. selector 稳定化 ✅
[Sidebar.tsx](../src/renderer/components/Sidebar.tsx) 整 slice → 窄字段。新建 [constants.ts](../src/renderer/constants.ts) 的 `EMPTY_OBJ`/`EMPTY_ARR`(`never` 通配),harden TagGroups/TagLibrary/TaskReminder/AdvancedSearchDialog 的 `?? {}`/`?? []` —— reducer 其实早已初始化这些字段,属 defense-in-depth。

### P2-5. EntryTagChips/ThumbIcon memo ✅
各包 `memo(Base)`;调用点把内联 `containerSx` hoist 成模块常量、tagless `?? []` → `EMPTY_ARR`(否则 memo 永不命中)。ThumbIcon 的 props 全 primitive/稳定 Map,调用点直接生效。

### P2-6. KanbanView bucketEntries memo ✅
`stageValues`/`buckets`/`columnKeys` 全 `useMemo`;`stageValues` 来自 `stages.map`,必须先 memo 否则 buckets 永不命中。

### P2-7. 重型原生依赖惰性加载 ✅
[lazy-native.ts](../src/main/lazy-native.ts):`getSharp`/`getCanvas`/`getExifr`/`getChardet`/`getIconv`(`createRequire(__filename)` + 缓存),thumbnail/exif/ipc/font-thumb 去静态 import,webpack externals 加 exifr/jschardet/iconv-lite。**sharp 类型坑**:`typeof import('sharp')['default']`(namespace 不可调用)。冒烟:4 个模块不再进 bundle 依赖图。

> `drawio-thumb.ts` / `excalidraw-thumb.ts` 原列本项,后核实为**未接入主流程**的死代码(缩略图走品牌图标,没有 drawio/excalidraw kind 分支),已于 2026-07 删除,详见 [docs/06 §3](./06-thumbnails.md)。

### P2-8. 文件协议真实背压 ✅
[protocol-range.ts](../src/main/protocol-range.ts) 用 Web Stream `pull()` 驱动暂停/恢复 Node stream;每 chunk 入队即 pause,cancel/error/destroy 均清理。保留 Range/headers,慢消费者下仅 Node highWaterMark + 单 chunk 的有界预读。

### P2-9. 扩展嵌图 base64 移到 Main ✅
`fs:readFileBase64` 过 allowedRoots 后用 `Buffer.toString('base64')`;ExtensionHost 删除逐字节十六进制拼装/btoa,保留 MIME 与失败回退。

### P2-10. 拖动设置不再逐 mousemove 持久化 ✅
FileListHeader 列宽、PropertiesTray 宽度改本地预览 + pointer capture,pointerup 只提交一次最终值;cancel/lost capture/unmount 清理,不改 redux-persist flush/原子写。

### P2-11. FolderViz 消除重复递归扫描 ✅
FolderVizView 复用 DirectoryContentProvider 的 `entries/loading/error/refresh`,以 `useMemo` 建树;filterMode 只改纯前端投影,不再重复 `listDirectoryRecursive`。

### P2-12. 日期标签按需订阅分钟 ticker ✅
TagMetaProvider 仅在存在日期族标签时订阅共享 now store;普通/评分/period 标签不再每分钟重算 allTags/自动配色/context,日期进入/退出会正确订阅/退订。

### P2-13. Gantt 泳道查找预索引 ✅
GanttTimeline 预计算 `scheduledByPath`(保留每 path 首项,等同 Array.find),displayRows 与 hiddenLaneCount 两处查找由 O(N·T) 降为 O(N+T);chooseLane 与折叠语义不变。

### P2-14. PropertiesTray 移除闲置订阅/重复投影 ✅
日期输入仅在 addTag 动作时取 `new Date()`,不再为输入框常驻订阅分钟 ticker;workflow `stageValues` 改 useMemo,避免每次 render 新建数组。

### P2-15. 递归隐藏路径按祖先剪枝 ✅
`filterRecursiveEntries` 过滤隐藏目录的全部后代,Provider 的 entries 与 sidecar 读取使用同一可见集;修复 FolderViz 幽灵节点和 FileList 深度>1的隐藏子项泄漏。列宽拖动预览与提交共享 LIST_COLUMN_BOUNDS;嵌图补齐 avif/tiff/ico MIME。

---

## 🟢 Tier 3 — 较小 / 长期

### P3-1. 零碎项
- ~~`firstThumbnailableFile`~~ — **评估不做**:find-first + 早返回,首候选即中(1 stat),并发反而过度取数。
- ~~`distinctTags` 计数表~~ — **评估不做**:非热点(高级搜索才开一次),多对多 trigger 复杂易漂移。
- ✅ `importExternal` 串行 cp → `mapWithConcurrency(4)`(name dedup 无竞态:同步在首 await 前)。
- ✅ [atomic-write.ts](../src/main/atomic-write.ts) 每写扫残留 temp → per-target `sweptTargets: Set`;同 target 串行、跨 target 并行,失败写不毒化队列(详见 [docs/02 §7](./02-file-io.md))。
- ✅ `readHeicWasm` 缓存源 Buffer(仍返新拷贝)。
- ✅ `extractPdfText` 内存上限:单文件超过 `MAX_PDF_BYTES = 128 MiB` 直接跳过(保留既有索引行 + 警告),不再整文件读进 worker;N 个超大 PDF 并发也不会叠加成 OOM。
- ✅ renderer:[FileToolbar](../src/renderer/components/FileToolbar.tsx) `recents` memo + RO 守卫;[GanttTimeline](../src/renderer/components/gantt/GanttTimeline.tsx) 删 no-op RO;[GalleryView](../src/renderer/components/GalleryView.tsx) RO 守卫。

---

## ✅ 已接受的取舍(决定不做,勿重复提)

| 项 | 出处 | 理由 |
|---|---|---|
| depth-5 node_modules 200–500ms | [docs/08](./08-data-depth.md) §9 | 有截断 + loading 反馈;P1-3 缓存是退路 |
| PDF 缩略图 CJK `notdef` | [docs/06](./06-thumbnails.md) §7 | canvas 缺 CJK 字表,内嵌字体代价过高;读者可用系统阅读器 |
| 缩略图无大文件保护 | [docs/06](./06-thumbnails.md) §7 | 仅 video 有首帧捷径;非 video 大文件全解码 |
| per-folder depth override | [docs/08](./08-data-depth.md) §11 | 「不做,真需要再补」 |
| 首次索引大语料慢 | [docs/04](./04-search-index.md) §9 | loading spinner 缓解;P0-2 已消除主进程阻塞 |
| index.db 无单事务原子性 | [docs/04](./04-search-index.md) §9 | 缓存可重建,correctness 取舍 |
| `whale-file://` handler 走 `statSync` | [protocol-range.ts](../src/main/protocol-range.ts) | `<video>` range 热路径,异步化会伤 seek |
| buildIndex 每目录重读 wsd.json | [sidecar.ts](../src/main/sidecar.ts) `readSidecars` | 标签不改 mtime,mtime 缓存会错 |

---

## 🔧 可复用范式

- **缓存形状**:mtime 失效 + 原子 `.tmp`+rename + `inflight: Map<key,Promise>` 去重 + fs-op 钩([recursive-cache.ts](../src/main/recursive-cache.ts) 是现存范本)。
- **惰性原生 require**:`createRequire(__filename)`(`getSharp`/`getPdfjs`/...);注意 [docs/09 §19](./09-known-issues.md) CommonJS 硬约束。
- **批量让步**:`INGEST_BATCH=1000` + `setImmediate`、`mapWithConcurrency(8)`。
- **长任务不占主线程**:重 CPU/重 IO 一律进 utilityProcess 或 worker,主进程只留路由与校验(P0-2 的教训)。
- **memo 先修 spoiler**:先查闭包/内联对象身份,再谈 `memo` —— P0-3 / P1-4 都是 spoiler 先死、memo 才生效。

---

## 剩余

无 Tier 0–3 未完成项(2026-07-12 ~ 07-18 全部闭环)。P3-1 最后一项 `extractPdfText` 整读内存已于 2026-11 关闭:超过 `MAX_PDF_BYTES = 128 MiB` 的 PDF 在读取前跳过并保留旧索引行。

### 2026-11 后续资源边界 ✅
- ✅ [fulltext.ts](../src/main/fulltext.ts) 首建按 100 条批写、PDF 全局 2 路、超时停止页循环且异常 destroy 有界等待不泄漏许可；[useListCommands.ts](../src/renderer/hooks/useListCommands.ts) 批量 IO 单次 refresh；[MediaLightbox.tsx](../src/renderer/components/MediaLightbox.tsx) playlist memo + 41-cell 可翻页胶片条。实现与恢复语义见 [docs/04](./04-search-index.md) / [docs/10](./10-ui.md)。
- ✅ [fs-write.ts](../src/main/ipc/fs-write.ts) 的 OS ZIP 进程统一 120 秒 / 1 MiB 输出边界，并用 staging→rename 避免失败半成品；[thumbnail.ts](../src/main/thumbnail.ts) 的目录背景 sharp 编码纳入共享 4 路信号量。通用 readFile/base64 的无上限整读经调用面复核保留为兼容边界，详见 [docs/02](./02-file-io.md)。
- ✅ [build-extensions.js](../scripts/build-extensions.js) 的 drawio copy-filter 只剔除 vendor node_modules、source map、未使用 viewer bundle 与孤儿 workbox；复制后的 index 与 `PreConfig.js` 将 HTML viewer/lightbox/base 固定到本地 viewer-static，base/lightbox 独立赋值为无尾斜杠目录 URL，避免 PreConfig 重置 null、赋值顺序与公网 CDN 回退；扩展协议只对 Draw.io assets 精确根路径映射 index，保留 math/stencils 与 OPEN_FORM 仍引用的 open.html。随包源数据减少 138 文件 / 3,050,820 bytes，真实包 init/render/edit、viewer 与 Lightbox 文档可服务性冒烟和资源保留测试通过（[docs/14 §3](./14-packaging.md)）。上游未随包提供 embed-static/embed.js 的 HTML-embed 缺口单独保留，未混入本项完成声明。
- ✅ 递归全文提取与目录加载在飞行边界：`buildFulltextIndex` 的非 PDF 实际提取共享 worker 级 `Semaphore(8)`，目录各自 8 路遍历不再叠乘压力；PDF 不占非 PDF 许可，只走原有 PDF 2 路专用闸门，避免 PDF 队列饿死文本，直接 MCP 路径不变。4 个嵌套目录 × 4 个真实文本的阻塞回归验证 `maxActive=8`、16 项全部写入并可搜索，另有 8 个 PDF 阻塞时兄弟目录文本仍能提取的回归。目录 thumbnail/background 以各自 target path 只合并尚未 settle 的同目录加载，同目录 8/6 路并发分别只做一次底层加载，不同目录隔离，失败传播后立即可重试；成功/失败都清 Map，不持久缓存结果或 `null`，避免陈旧空目录遮蔽新增文件。见 [docs/04](./04-search-index.md) 与 [docs/06](./06-thumbnails.md)。
- ✅ **可复现基准与停止条件**：[bench-performance.js](../scripts/bench-performance.js) 用隔离临时 fixture 测全文 cold/no-op/1% 增量/search 与目录缩略图 cold/warm/同目录 burst，至少 3 轮取中位数并校验命中、陈旧清理、JPEG 与内存快照；Add Location 后先排空真实 per-root 索引队列，测量前断言全部目录/文件缩略图不存在，报告 `coldVerified` 与 `tempRootRemoved`。最终自检版全文 median 为 cold 1235.507ms / no-op 11.882ms / incremental 21.727ms / search 0.567ms；目录为 cold 152.7ms / warm 4.3ms / same-dir burst 11.8ms。内存字段明确为 phase 后 resident 与共享 worker 累计 peak，不作泄漏结论；同目录只声称结果一致，单次生成由单元测试证明。核心 fulltext/thumbnail/cold validator 及两个全文 benchmark 的 CLI/失败报告也有隔离测试，统计、核心断言与报告契约共 11/11 通过。
- ✅ [bench-fulltext-phases.js](../scripts/bench-fulltext-phases.js) 用相同内容/树形对照真实读取与 no-read 估计，并断言 synthetic 分支每轮真实执行 1000 次；最新 real median 320.522ms、synthetic 285.057ms，每轮配对差的中位数 41.041ms（与“两个 median 相减”的 35.465ms 分开报告），仅为归因估计。[bench-fulltext-batches.js](../scripts/bench-fulltext-batches.js) 比较真实 `insertFulltext` 的 50/100/200/500/1000 条事务，并用 10 组各 100 行查询证明全部 1000 行写入；最新 median 分别 289.187/285.782/263.147/216.770/477.422ms，波动大且无稳定排序，不支持扩大大文本驻留，保留生产参数。[bench-stats.js](../scripts/bench-stats.js) 共享统计与非法样本拒绝，加载主进程模块的脚本显式设置 `NODE_ENV=test`；phase/batch 都拒绝未知参数与缺值、支持有界 `--rounds`，成功/失败报告带 generatedAt/completedAt，指定 --output 时失败会覆盖旧报告。合成小样本、现有 unpacked、未清 OS page cache 的测量不是普遍性能承诺，跨 harness 的绝对耗时也不直接比较。phase/batch 在测量/校验失败后先完成 closeAllDbs/rm，再统一写出保留原错误、cleanupError、tempRootRemoved 与 completedAt 的报告；真实 CLI 双失败路径已由受控 hook 覆盖。
