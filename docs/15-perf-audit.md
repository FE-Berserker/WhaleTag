
← 返回 [plan.md](../plan.md)

# 15 · 性能审计与待办清单

> 2026-07-12 全量性能审计的追踪清单(plan.md §F「不做未来计划」的**例外**)。每项完成后压成 1–2 行 ✅(保留「做了什么 + 关键坑」,细节在 git/code);评估不做的移到文末「已接受的取舍」。

**审计方法**:`src/main` + `src/renderer` 代码扫描 + docs(09/01/04/06/08)遗留提取。代码内无 TODO/FIXME 标记——发现均来自代码本身。

---

## 🔴 Tier 0 — 最大收益

### P0-1. files 索引增量 ✅
[index-db.ts](../src/main/index-db.ts) `ingestFiles` 改签名增量:`filesPrior(rootPath)` + `filesSignature = mtime|size|tags`,签名匹配行跳过 upsert(不碰 `files_au` FTS 触发器),删除走 `prior.keys 不在 seen` 逐条删。**tags 强制进签名**(sidecar 改标签不改 mtime,漏了标签编辑就不重索引)。

### P0-2. 索引进 utilityProcess 沙箱 ✅
[index-worker.ts](../src/main/index-worker.ts)(utilityProcess)+ [host](../src/main/index-worker-host.ts)(惰性 spawn / 崩溃重 spawn / before-quit kill)+ [protocol](../src/main/index-protocol.ts)(11 op 判别联合)+ spawn(锚 `__dirname`)。`ipc.ts` 11 handler 转 `request()` 转发,`assertWithinAllowedRoot` 留主进程;`index-db.ts` 加 `!process.parentPort` 守卫防管线回主进程。**打包坑**:`utilityProcess.fork` 是 asar 原生(别做 asar→unpacked 重写,否则 ENOENT);worker 用 `process.parentPort` 不是 `import {parentPort}`(Electron 42 后者 undefined);entry 锚 `__dirname`(dev getAppPath 是项目根)。详见 [docs/04 §9](./04-search-index.md) / [docs/09 §25](./09-known-issues.md)。

### P0-3. Mapique marker 不重建 ✅
[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx) 抽 `React.memo <GeoMarker>`,传原始 `state` 字面量(非整 `selected` Set)→ 仅状态真变的 marker 重渲;icon/position/eventHandlers 各 `useMemo`。**关键 spoiler**:`selectRow` 原闭包捕获 `visibleTrayEntries`,`distance` 排序下 `moveend` 每次平移让它换身份 → 废掉所有 marker memo;改 ref(`visibleTrayEntriesRef` + `trayIndexByPathRef`,顺带 O(n) findIndex→O(1))。

### P0-4. Kanban/Matrix/Gantt 卡片 memo + 虚拟化 ✅
① `EntryCard = memo(EntryCardBase)`,3 prop 全 ref-stable;`renderContextMenu` 各视图 `useCallback`(选择仍生效——`isSelected` 挂 `selectedTick`、是 `cellData` dep)。② 新增 [EntryCardStack.tsx](../src/renderer/components/EntryCardStack.tsx):react-window v2 `List` + `useDynamicRowHeight`,接 Kanban 列体 + Matrix 象限体。**坑**:row 不能 `memo`(react-window v2 要函数);row 包 flex-column 让卡 `mb:1` 算进测量高;横向 tray(UntaggedTray/Gantt Triage)不虚拟化。DnD 不受影响(drop target 是包裹 Box)。

---

## 🟠 Tier 1 — 高收益小改

### P1-1. 异步二进制探测 ✅
`sofficeBinary`/`ebookConvertBinary`/`dwg2dxfBinary` 改异步 `execFile`(callback)+ `_inflight` 去重,返 `Promise<string|null>`;所有 caller `await`。

### P1-2. persist 删 console.log ✅
[persist-storage.ts](../src/main/persist-storage.ts) 删 3 条 debug `console.log` + 多余 eslint-disable;保留 catch 分支 `console.error`(真 IO 失败诊断)。见 [docs/02 §8](./02-file-io.md)。

### P1-3. viewDepth>1 递归聚合缓存 ✅
[recursive-cache.ts](../src/main/recursive-cache.ts)(镜像 office-cache):缓存 `<dir>/.whale/index-recursive/d<depth>.json` 的 scan(`DirEntry[]`);**双守卫失效**(`dirPath` 挡文件夹移动 + `folderMtime` 挡子项增删);`invalidateRecursiveScan` 清祖先 ≤5 层,挂 6 个 fs-op 钩(含原先无钩的 mkdir)。sidecar 读更便宜且耦合 `wsd.json`,留后续。

### P1-4. office→PDF bytes IPC 双拷贝 ✅
端到端改 `Uint8Array`:[ipc.ts](../src/main/ipc.ts) `ext:convertOfficeToPdf` 直返 Buffer 删拷贝;types + viewer 直传。净省 1 次 memcpy/文档。**同类已照改(2026-07-18)**:`convertDwgToDxf` / `convertEbookToEpub` 两 handler 同形改完(handler 直返 Buffer;ipc-types / extension-types / ipc-api 链 `ArrayBuffer`→`Uint8Array`;cad-viewer 去 `new Uint8Array` 包裹、ebook-viewer `loadEpub(data)` 直传)。**`convertAudio` 不适用**:走 `whale-audio://` 协议流式(无 IPC bytes 往返),其 stdout chunk 的 `ArrayBuffer.slice` 是 load-bearing(Node 池化 buffer 防 `'data'` 覆盖),不能删。

### P1-5. GanttRow memo 解锁 ✅
GanttView→GanttTimeline 6 个内联闭包稳定(纯转发直传 `data.*`,其余 `useCallback`);**真正 spoiler**:GanttTimeline per-row `onCommit` adapter 每行新函数——把 entry-binding 下沉到 GanttRow 内部(同 `onClick` 模式),GanttTimeline 直传。

### P1-6. 文件夹缩略图并发上限 ✅
[concurrency.ts](../src/main/concurrency.ts) 加 `thumbnailSemaphore = Semaphore(4)`;`doGenerateThumbnail` 把 encode+write 包进 `run`(便宜 kind/stat/reuse 短路留 permit 外)。所有调用方(file IPC / folder thumb / setFolder)自动覆盖。

### P1-7. pdf-viewer 大文件字节桥(去 base64 整文件)✅
打开大 PDF 卡顿根因:host 把整份文件 base64 后跨 IPC→postMessage 进 iframe([ExtensionContextProvider.tsx](../src/renderer/hooks/ExtensionContextProvider.tsx) 逐字节 O(n²) 拼接 + 33% 膨胀 + iframe 再解码,峰值 ~3× 内存、主线程长阻塞)。**原计划复刻 media-player 走 `whale-file://` 流式 URL + pdfjs Range,实测被挡**:pdfjs `getDocument({url})` 内部 fetch 触发 CORS,Chromium 协议级硬限制「跨源 fetch 仅限 http/https/data/chrome」,自定义协议 `whale-file://` 从 `whale-extension://` origin 被拒(`net::ERR_FAILED`);`<video>` 能用 whale-file 是因 media 管线不经 fetch CORS。**改走字节桥**(学 office-viewer `officePdfContent`):host 经 `requestFileBytes`/`fileBytes`([extension-types](../src/shared/extension-types.ts))读文件回传 `Uint8Array`,postMessage 结构化克隆(一次 memcpy,无 base64、无 O(n²) 解码)→ `session.renderPdfBytes`。[shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts) 抽 `runRender` 共享循环,`renderPdfBytes` 入参不变(office-viewer 回归零改);`renderPdfUrl` 接口保留并标注 CORS 未用。meta CSP 加 `worker-src whale-extension://*`;`build-extensions.js` 复制 `pdf.worker.mjs`。**真 worker 默认关**(`USE_PDFJS_WORKER=false`):字节桥已消除主因;真 worker 依赖 `new Worker()` 接受 `whale-extension://` 特权协议(repo 内无 Electron 先例),实测确认 spawn 后改一行开启。

---

## 🟡 Tier 2 — 中等收益

### P2-1. 缩略图内存缓存 ✅
[thumbnail.ts](../src/main/thumbnail.ts) `loadThumbnail` 加进程内 LRU(`Map<path,{mtimeMs,dataUrl}>`,cap 500),失效信号 = thumb 文件 mtimeMs(重生成必换 mtime → 自动 miss);`fsp.stat` 兼存在检查 + 失效。**未做**:`loadFolderThumbnail` 同形但频率低;`whale-file://` 直传是更彻底退路。

### P2-2. count(*) 轮询 → O(1) ✅
[index-db.ts](../src/main/index-db.ts) 加 `meta(key,value)` 表,`files_count` 每次 ingest 末尾写 `seen.size`(自愈);老库回退一次 `count(*)` 并缓存;`hasFulltext` 改 `SELECT 1 ... LIMIT 1`。

### P2-3. prepared statement 缓存 ✅
`prepareCached(db, sql)` + `WeakMap<DB, Map<sql, Statement>>`(按 DB 实例 key,关连接自动回收)。只缓存查询热路径(queryFiles/advancedQuery/distinctTags/queryFulltext)。

### P2-4. selector 稳定化 ✅
[Sidebar.tsx](../src/renderer/components/Sidebar.tsx) `s.locations`/`s.settings` 整 slice → 窄字段(`s.locations.items`/`s.settings.defaultLocationId`)。新建 [constants.ts](../src/renderer/constants.ts) 的 `EMPTY_OBJ`/`EMPTY_ARR`(`never` 通配),harden TagGroups/TagLibrary/TaskReminder/AdvancedSearchDialog 的 `?? {}`/`?? []`——其实 reducer 早初始化了这些字段,`??` 永不命中,这是 defense-in-depth。

### P2-5. EntryTagChips/ThumbIcon memo ✅
各包 `memo(Base)`。调用点 hoist 内联 `containerSx` 成模块常量 + tagless `?? []` → `EMPTY_ARR`(否则 memo 永不命中)。ThumbIcon props 全 primitive/稳定 Map,所有调用点直接生效。

### P2-6. KanbanView bucketEntries memo ✅
`stageValues`/`buckets`/`columnKeys` 全 `useMemo`(`stageValues` 来自 `stages.map`,必须先 memo 否则 buckets memo 不命中)。

### P2-7. 重型原生依赖惰性加载 ✅
[lazy-native.ts](../src/main/lazy-native.ts):`getSharp`/`getCanvas`/`getExifr`/`getChardet`/`getIconv`(`createRequire(__filename)` + 缓存)。改 thumbnail/exif/ipc/font-thumb 去静态 import;webpack externals 加 exifr/jschardet/iconv-lite。**sharp 类型坑**:`typeof import('sharp')['default']`(namespace 不可调用)。冒烟:4 模块不再在 bundle 依赖图。

> `drawio-thumb.ts` / `excalidraw-thumb.ts` 原列本项,后核实为**未接入主流程**的死代码(thumbnail.ts 没有 drawio/excalidraw kind 分支,缩略图走品牌图标),已于 2026-07 删除,详见 [docs/06-thumbnails.md §3](./06-thumbnails.md) 与 `docs/01-architecture.md` 死代码条目。

---

## 🟢 Tier 3 — 较小 / 长期

### P3-1. office-viewer 冷转码缩略图占位 ✅
office-viewer `openOfficeFile` 并行 fire `requestThumbnail` + `requestOfficeConvert`,缩略图到达即 `showThumbnailPlaceholder`,`renderPdf` 清占位。新增 `requestThumbnail`/`thumbnailContent` 消息对 + host 桥。**未做 crossfade**(直接清占位,可后续加 CSS transition)。

### P3-2. office-viewer scroll-sync ✅
给 session 加 `onAfterPageRender` 盖 `data-page-num` + rAF scroll handler(「top ≤ 视口 25% 且最接近」),`pageInfoEl` 从静态 `N/N` 改 `cur/total`。**resize 半边 N/A**:office 画布固定 px 宽,无 fit-mode,resize 不重栅格化。

### P3-3. UNO/soffice 常驻后台进程 ✅
保活一个 LibreOffice UNO listener,后续 office→PDF 转换复用已初始化进程(~200–500ms),冷启动只一次。Node 无原生 UNO 客户端,故 bundle 一个 Python worker(借用 LO 自带 `python`+`pythonuno`)做桥接,worker 起不来时带 cooldown 自动回退现有 `execFile`(**零 regression**)。详见 [docs/17](./17-office-worker.md)。顺带把 `convertOfficeToPdf` 与 `encodeOfficeThumb` 两处重复的 spawn body 合并成共享 `convertOfficeToPdfVia`(worker 优先 + execFile 兜底,`sofficeSemaphore` 包两路)。

### P3-4. AI 流式 boolean 兜底 ⬜ 需诊断
per-uuid `streamedMsgs` 去重疑似 partial/complete uuid 不匹配,现用 per-turn boolean 兜底(能用,每轮多一次渲染)。删 boolean 需先记 uuid 流向日志确诊。见 [docs/09 §23](./09-known-issues.md)。

### P3-5. 零碎项
- ~~`firstThumbnailableFile`~~ — **评估不做**:find-first + 早返回,首候选即中(1 stat),并发反而过度取数。
- ~~`distinctTags`~~ — **评估不做**:非热点(advanced-search 开一次);trigger 维护多对多计数复杂易漂移。
- ✅ `importExternal` 串行 cp → `mapWithConcurrency(4)`(name dedup 无竞态:同步在首 await 前)。
- ✅ `atomicWrite` 每写扫残留 temp → per-target `sweptTargets: Set`。
- ✅ `odaConverterBinary` 加 memo。
- ✅ `getPdfAsset`/`readCadWasm`/`readHeicWasm` 缓存源 Buffer(仍返新拷贝)。
- ⬜ `extractPdfText` 整 PDF 读内存 — 罕见,可接受(见取舍表)。
- ✅ renderer:[FileToolbar](../src/renderer/components/FileToolbar.tsx) `recents` memo + RO 守卫;[GanttTimeline](../src/renderer/components/gantt/GanttTimeline.tsx) 删 no-op RO;[GalleryView](../src/renderer/components/GalleryView.tsx) RO 守卫。

---

## ✅ 已接受的取舍(决定不做,勿重复提)

| 项 | 出处 | 理由 |
|---|---|---|
| soffice 串行 cap 1 | [docs/06](./06-thumbnails.md) §3 | 并发争 profile-lock 损坏;P3-3 UNO 才是真解 |
| mediaConvertSemaphore cap 2 | [docs/06](./06-thumbnails.md) §3 | 用户发起的一次性转换 |
| depth-5 node_modules 200-500ms | [docs/08](./08-data-depth.md) §9 | 有截断 + loading 反馈;P1-3 缓存是退路 |
| PDF 缩略图 CJK `notdef` | [docs/06](./06-thumbnails.md) §7 | canvas 缺 CJK 字表;viewer 在 Chromium 内绕过 |
| 缩略图无大文件保护 | [docs/06](./06-thumbnails.md) §7 | 仅 video 有首帧捷径;非 video 大文件全解码 |
| per-folder depth override | [docs/08](./08-data-depth.md) §11 | 「不做,真需要再补」 |
| 首次索引大语料慢 | [docs/04](./04-search-index.md) §9 | loading spinner 缓解;P0-2 已移主进程阻塞 |
| index.db 无单事务原子性 | [docs/04](./04-search-index.md) §9 | 缓存可重建,correctness 取舍 |
| `whale-file://` handler `statSync` | 代码审计 | `<video>` range 热路径,异步加延迟伤 seek |
| readSidecars buildIndex 每目录重读 wsd.json | [indexer.ts](../src/main/indexer.ts) | 标签不改 mtime,mtime 缓存会错 |
| `extractPdfText` 整读内存 | 本文件 P3-5 | 病态大 PDF 罕见,可接受 |

---

## 🔧 可复用范式

- **缓存形状**:`transcode-cache` / `office-cache` = mtime 失效 + 原子 `.tmp`+rename + `inflight: Map<key,Promise>` 去重 + fs-op 钩。
- **惰性原生 require**:`createRequire(__filename)`(`getPdfjs`/`getSharp`/...);注意 [docs/09](./09-known-issues.md) §19 CommonJS 硬约束。
- **批量让步**:`INGEST_BATCH=1000` + `setImmediate`、`mapWithConcurrency(8)`。

---

## 剩余

仅 **P3-4**(AI 流式,需运行时诊断)未做。Tier 0–2 + P3-1/2/3/5 已全部完成(2026-07-12 ~ 07-18)。
