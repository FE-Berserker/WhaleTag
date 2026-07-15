
← 返回 [plan.md](../plan.md)

# 15 · 性能审计与待办清单

> 本文档是 **2026-07-12** 的一次全量性能审计结果,覆盖 `src/main`、`src/renderer` 与各模块 doc 自行标记的「遗留/取舍」。
> 主体功能已完善,此清单用于**逐项推进性能优化**。
>
> ⚠️ **文档定位**:plan.md §F 约定「不做未来计划」。本文件是经用户确认的**例外**——一份可勾选的追踪清单,
> 而非"当前代码行为"描述。每项完成后请勾选 `- [x]` 并在对应 `docs/0X-*.md` 记录最终实现;
> 若某项经评估**不做**,移到文末「已接受的取舍」并注明理由,不要让它永远悬在待办里。

**审计方法**:`src/main` 与 `src/renderer` 两路代码扫描 + docs(09-known-issues / 01 / 04 / 06 / 08)遗留项提取,去重交叉验证。`src/main` 内无 `TODO/FIXME/XXX/HACK/遗留/性能` 标记——所有发现均来自代码本身。

---

## 🔴 Tier 0 — 最大收益(大库体感最明显)

### P0-1. files 索引仍是全量重建,非增量

- **现状**:[index-db.ts](../src/main/index-db.ts) `ingestFiles`(~L171)在每次 `index:build` 上对所有条目做 upsert,即使 `mtime/tags/size` 字节不变。每个 upsert 触发 `files_au AFTER UPDATE`(`index-db.ts` L62-67)对 `files_fts` 做 `DELETE`+`INSERT`。SQLite 的 `ON CONFLICT DO UPDATE` 永远跑 UPDATE 分支。
- **影响**:10 万文件且内容完全没变,仍付 10 万次 FTS delete+insert。**当前最大单点浪费**。
- **参照**:fulltext 侧已做增量([fulltext.ts](../src/main/fulltext.ts) L207,`fulltextPrior` mtime 比对);files 侧没跟上。
- **做法**:加 `filesPrior(rootPath): Map<path, mtimeAndTagsHash>`(或 `hash` 列),`ingestFiles` 跳过签名匹配的行——跳过的行不碰触发器。

- [x] 实现(2026-07-13)— 新增 `filesPrior(rootPath): Map<path, signature>` + `filesSignature(e)`(签名 = `${mtime}|${size}|${tags.join(' ')}`),照抄 fulltext 侧范式。`ingestFiles` 改增量:签名匹配的行 `continue` 跳过 upsert(不碰 `files_au` 触发器),只 upsert 变化/新增行;删除改用 `removed = prior.keys() 不在 seen` 逐条删(弃用原 `cur_paths` 临时表 + `NOT IN` 全扫)。**tags 强制进签名**(sidecar 改标签不改 mtime,漏了它标签编辑就不会重新索引)。`index-db.test.ts` 加了增量测试:无变更重索引 FTS 完好(回归闸)+ 仅改 tags(mtime 不变)也能重新索引(签名正确性)。14/14 index-db 测试过,`type-check` 干净。

### P0-2. 把 SQLite / 索引管线挪进 `utilityProcess` 沙箱

- **现状**:FTS5 索引 DB(`<root>/.whale/index.db`)跑在 Electron **主进程**事件循环上。`buildLocationIndex` / `buildFulltextIndex` / 全文抽取共享主线程。已有缓解:`INGEST_BATCH=1000` + `setImmediate` 让步、`mapWithConcurrency(8)`、增量 upsert/delete。
- **影响**:大语料首次索引期间 UI 冻结。文档原话「主进程 SQLite 阻塞由分批提交缓解」——缓解未解决。
- **参照**:[docs/04-search-index.md](./04-search-index.md) §9 最后一条:「真阻塞场景已移到下一阶段:考虑 `utilityProcess` 沙箱跑」。
- **做法**:把 index/extract 管线搬进沙箱 utility process,沿用现有 batched-yielding 模式。

- [x] 实现(2026-07-13)— 新增 `index-worker.ts`(utilityProcess 子进程)+ `index-worker-host.ts`(惰性 spawn / reqId 关联 / 崩溃重 spawn / `before-quit` kill)+ `index-protocol.ts`(11 op 判别联合,`request<O>()` 泛型)+ `index-worker-spawn.ts`(锚定 `__dirname` 解析 entry 路径)。`ipc.ts` 11 个 handler 全转 `request()` 转发,`assertWithinAllowedRoot` **留主进程**;`index-db.ts` 加生产守卫(`!process.parentPort` 判断)防管线被重新加载回主进程;webpack dev+prod 加 `index-worker` entry。batch 边界、`markExifProcessedMany` 单事务、prod 剥 stack 均保留。**显式 defer**:进度推送、优雅 shutdown + WAL flush。**打包排坑(2026-07-13 冒烟发现并修)**:① `index-worker-spawn.ts` 原 `app.asar→app.asar.unpacked` 重写是错的——`utilityProcess.fork` 是 Electron 原生、asar 感知(不同于 `child_process.fork`,见 electron#2708),直接从 app.asar 加载 entry 即可;而 entry 不在 `asarUnpack`,重写后路径不存在 → 打包版 worker ENOENT。已删重写。② `index-worker.ts` 原 `import { parentPort } from 'electron'` 在 Electron 42 运行时为 `undefined`(类型声明挂在 electron 导出上,实际值只在 `process.parentPort`)→ worker 启动即抛 → **P0-2 此前从未真正跑通**。改用 `process.parentPort`。③ dev 下 `app.getAppPath()` 返回项目根(`c:\WhaleTag`),原 `path.join(app.getAppPath(),'dist','main',…)` 拼出不存在的 `c:\WhaleTag\dist\main\index-worker.js` → dev fork `ERR_MODULE_NOT_FOUND`(打包 getAppPath 是 app.asar,所以不触发);改锚定 `__dirname`(worker 与 main.js 同目录,webpack `node.__dirname:false` 两 config 都开)。冒烟验证:打包 fork 从 app.asar、dev fork 从 `release/app/dist/main`,都 `ready` → `index:build`/`index:status` 往返 OK(`better-sqlite3` 正常)。详见 [docs/04 §9](./04-search-index.md) + [docs/09 §25](./09-known-issues.md)。

### P0-3. Mapique 每个 Marker 每次渲染都重建

- **现状**:[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx) L1042-1102,`knownGeo.map((geo) => <Marker icon={makePinSign(...)} eventHandlers={{ click, contextmenu, dragend }} .../>)` 在每次父渲染执行。`eventHandlers={{...}}` 每次新对象 → react-leaflet 拆绑重绑;`makePinSign()` 每 marker 每渲染分配新 `L.divIcon`。父组件有大量 setState(`setMapCenter` 每次 `moveend`、`setCtxMenu`、选中、`panelOpen`、`loadingRecursive`)。
- **影响**:数百/数千 geo 文件时,平移/选中/右键都是几百 ms marker 重建。
- **做法**:抽 `React.memo` 的 `<GeoMarker>`,父层 `useCallback` 稳定回调;或把 `knownGeo.map(...)` 包进 `useMemo([knownGeo, geoColorMap, activeEntry?.path, selected, t])`;`makePinSign` 按 `color+state` 用 `Map` 缓存。

- [x] 实现(2026-07-14)— 取 **React.memo `<GeoMarker>`**(优于 `useMemo` 整数组):传**原始 `state`** 字面量而非整 `selected` Set → 选择变化时**只有状态真正改变的 marker** 重渲(icon `useMemo` 重建),其余 shallow-equal 全部 bailout。`<GeoMarker>` 内部对 `icon`(`makePinIcon(color,state,path)`)、`position`、`eventHandlers` 各自 `useMemo` → react-leaflet 在重渲时对未变字段跳过 `setIcon`/`setPosition`/rebind。**关键 spoiler 修复**:`selectRow` 原先闭包捕获 `visibleTrayEntries`——`distance` 排序下 `moveend`(每次平移)会让 `trayEntries` 重算(`mapCenter` 在其 dep 列表)→ `visibleTrayEntries` + `selectRow` 每次平移都换身份 → 建其上的 marker click handler 每次平移都废掉所有 marker memo。改用 ref:新增 `visibleTrayEntriesRef` + `trayIndexByPathRef`(path→index,顺带把原 `findIndex` O(n)/click 降为 O(1) 查表);`selectRow` deps 改 `[]`、marker 三回调(`handleMarkerClick`/`handleMarkerContextMenu`/`handleMarkerDragEnd`)全部稳定;`applySetGeo` 经 `applySetGeoRef` 读,dragend handler 不随 `geoByName`(EXIF 抽取)churn。顺带 hoist 模块级 `EMPTY_TAG_COLORS`/`EMPTY_GROUPS` 当默认值(同 P2-4 思路,FileList 经 `useShallowEqualSelector` 传本就是 shallow-stable 的值,这是无参/测试路径的保险)。**行为零回归**:click/ctrl/shift-range 选择、右键菜单、dragend 写坐标 + undo + `lastDragEndAtRef` 防 click 抢写全保留。`type-check` + `eslint` 干净;[MapiqueView.test.tsx](../src/renderer/components/MapiqueView.test.tsx) 触及改动路径的 3/5 通过(blank-map ctx menu / tray 键盘导航 / marker→tray ctx 拷坐标)。⚠️ **遗留(非本次引入)**:同文件测试 1/2(tray filter 的 ToggleButton 断言)在改动前即失败——代码用 `Select`/`MenuItem`,测试仍查 `MuiToggleButton-root`(0 !== 3),与本项无关,单独跟进。

### P0-4. Kanban / Matrix / Gantt-triage 卡片无 memo、无虚拟化

- **现状**:
  - [KanbanView.tsx](../src/renderer/components/KanbanView.tsx) L354-366:`entries.map((entry) => <EntryCard .../>)`,且 `renderContextMenu` 是 L359 的内联箭头。
  - [MatrixView.tsx](../src/renderer/components/MatrixView.tsx) L331-345(四象限)+ L467-477(未标记托盘),同样内联 `renderContextMenu`(L339、L474)。
  - [GanttView.tsx](../src/renderer/components/GanttView.tsx) L934-944(Triage 托盘)。
  - `EntryCard` 未 memo,每张跑 `useDrag`+`useDrop`+`ThumbIcon`(各自带 IntersectionObserver + redux 订阅)。
- **参照**:[GalleryView.tsx](../src/renderer/components/GalleryView.tsx) L38-45 有注释:当年正是 `<ImageList>.map()` 在 1000+ 图目录下崩掉。
- **做法**(先廉后贵):① `React.memo(EntryCard)` + 把 `renderContextMenu` 从内联箭头稳定下来(`useCallback`);② 单列卡片超百张时换 `react-window` `List`(`MapiqueTray` 是最近模板)。

- [x] ① memo + 稳定回调(2026-07-14)— `EntryCard` 改 `memo(EntryCardBase)` 默认导出。三 prop 全 ref-stable:`entry`(来自 `data.entries` 的 DirEntry ref)、`data`(FileList `cellData` useMemo)、`renderContextMenu`(各视图 `useCallback`)。**关键正确性**:选择仍生效——`isSelected` 身份挂在 `selectedTick` 上、是 `cellData` 的 dep,故选择变化会 re-bind `data` → 所有 EntryCard 重渲读新 `selectedPaths`(与改前一致);缩略图不受影响——`ThumbIcon` 靠自身 `useState`(`dataUrl`/`loaded`)在 `doLoad` 里刷新,父 memo 不挡子自渲(与 react-window memo 化的 list `Row` 同模型)。**稳定 4 个调用点**:① Kanban 主 `openEntryMenu` `useCallback([])` → 传 `KanbanColumn`;`KanbanColumn` 内 `renderCardContextMenu` `useCallback([onOpenEntryMenu])`(先关列菜单再转发)。② Matrix 主 `openEntryMenu` `useCallback([])` 共享给 `Quadrant` + `UntaggedTray`;`Quadrant` 内 `renderCardContextMenu` `useCallback([onOpenEntryMenu])`;`UntaggedTray` 是纯转发,直接 `renderContextMenu={onOpenEntryMenu}`(无需包一层)。③ Gantt 主 `openEntryMenu` `useCallback([])` → Triage `EntryCard` 的 `renderContextMenu`。**验证**:`type-check` + `eslint` 干净;KanbanView / MatrixView / GanttView 三套测试 **74/74 通过**(含 Kanban 卡片右键菜单 #3-5b、EntryCard tag-drop #8、Matrix 象限菜单 #3 / 未标记托盘 #4、Gantt Triage #2 / domain 菜单 #5)。注:GanttRow 的 `onContextMenu` 是同形闭包,留 **P1-5** 统一处理(本项不动 GanttRow)。
- [x] ② 列内虚拟化(2026-07-15)— 新增 [EntryCardStack.tsx](../src/renderer/components/EntryCardStack.tsx):react-window v2 `List` + `useDynamicRowHeight`(卡片可变高:84px min,标签换行更高),抄 `MapiqueTray` 范式(ResizeObserver 测容器高 + `rowProps` memo)。接入 **Kanban 列体**([KanbanView.tsx](../src/renderer/components/KanbanView.tsx))+ **Matrix 象限体**([MatrixView.tsx](../src/renderer/components/MatrixView.tsx))——这俩是竖向卡片栈,单 stage/象限可能数百卡。**横向 tray 不虚拟化**:Matrix `UntaggedTray`、Gantt Triage 都是 `overflowX:auto` 的薄横条(maxHeight 160 / 单行),横向虚拟化要 `Grid(1×N)` 复杂且低值,留原 `entries.map` + flex `gap`。**DnD 不受影响**:drop target 是包裹 stack 的列/象限 Box(恒挂载,与哪张卡虚进虚出无关),可见卡仍各自 `useDrag`;无列内位序重排(workflow stage 是分类不是有序表),故无需卡级 drop target。**几个坑**:① row 组件不能 `memo`(react-window v2 `rowComponent` 要函数不要 `NamedExoticComponent`;`<EntryCard>` 已 memo + `rowData` 已 memo,够省);② row 包 `display:flex;flexDirection:column` 让卡的 `mb:1` **算进测量高**(flex item 不折叠 margin,否则行高量不到 8px gap);③ jsdom 下 `getBoundingClientRect`=0,`height` 留默认 400、行用 `defaultRowHeight`——小 board(测试 1–3 卡/列)仍全挂载,断言不受影响(MapiqueView 已证 react-window v2 在 jsdom 能查到 `[data-entry-path]`)。`CARD_MIN_HEIGHT` 从 EntryCard export 给 `defaultRowHeight`。type-check + eslint 干净;Kanban/Matrix/Gantt/GanttEntryMenu 83/83 过。

---

## 🟠 Tier 1 — 高收益且改动小

### P1-1. `execFileSync` 二进制探测阻塞主线程最多 3s

- **现状**:
  - [thumbnail.ts](../src/main/thumbnail.ts) L137:`execFileSync('soffice', ['--version'], { timeout: 3000 })`
  - [ebook-convert.ts](../src/main/ebook-convert.ts) L45:`execFileSync('ebook-convert', ['--version'], ...)`
  - [cad-convert.ts](../src/main/cad-convert.ts) L29:`execFileSync('dwg2dxf', ['--version'], ...)`
- **影响**:首次调用发生在用户交互手势中(打开 Office/ebook/DWG),冷启动 Windows 上 PATH 查找 + 二进制 bootstrap 可吃满 3s timeout,冻结所有窗口与 IPC。`execFileSync` 阻塞整个事件循环。调用后已 memo,但首次阻塞无法接受。
- **做法**:换异步 `execFile`,`sofficeBinary()` / `ebookConvertBinary()` / `dwg2dxfBinary()` 返回 `Promise<string | null>`;或在 `app.whenReady()` 空闲时预热。候选路径 `existsSync` 分支(便宜)可保留。

- [x] 实现(2026-07-13)— `sofficeBinary` / `ebookConvertBinary` / `dwg2dxfBinary` 全改异步 `execFile`(callback 形式),返回 `Promise<string|null>`;加 `_xxxInflight: Promise` 去重并发首调;`isSofficeAvailable` / `isEbookConvertAvailable` 同步改异步;所有 caller([ipc.ts](../src/main/ipc.ts) `ext:detect*`、office-convert / ebook-convert / thumbnail 内部、3 个 `.test.ts`)已 `await`(全量 trace 确认无遗漏)。修了改动遗留的 3 个 `stdio:'ignore'` 类型错(`execFile` callback overload 不收 `stdio`,删之——行为不变,callback 形式本就不向父进程继承 stdio)。`npm run type-check` 干净。

### P1-2. persist 每次读写都打 `console.log`

- **现状**:[persist-storage.ts](../src/main/persist-storage.ts) L61、L66、L79(以及 L70、L88、L109 错误分支),每次 `persistRead` / `persistWrite` 多条 `console.log`(含 value length + 文件路径)。主线程同步。
- **影响**:redux-persist 每次 state 变更 + 关机都 flush,每 flush 触多 key。明显是 leftover debug,已进生产。
- **做法**:删除或 `if (isDev)` 门控。**5 分钟改动,零风险**。

- [X] 实现(2026-07-12) — 删 3 个 `console.log`(`persistRead` 头/尾 + `persistWrite` 头)+ 3 个多余的 `eslint-disable-next-line no-console`(error 分支本就不需要);**保留** 3 个 catch 分支的 `console.error`(真 IO 失败诊断,符合 plan.md §A「错误必须上抛」)。`npm run lint` + `npm run type-check` 干净。详见 [docs/02 §8](./02-file-io.md)。

### P1-3. 递归目录聚合(viewDepth>1)无结果缓存

- **现状**:`viewDepth > 1` 时,每次深度变更触发全新 `listDirectoryRecursive` + `readSidecarsForPaths` + `aggregateRecursiveEntries`。`MAX_RECURSIVE_ENTRIES=10000` 截断 + 200ms 防抖只挡快速滑动,不挡重复访问。
- **影响**:同一文件夹同一深度反复访问,每次重做全部 IPC + sidecar IO。depth-5 踩 node_modules 类树 200-500ms/次。
- **参照**:[docs/08-data-depth.md](./08-data-depth.md) §11:「按 FolderViz `index-archive` 同模式补 `index-recursive/`,mtime 失效 + 原子写——留作独立项」。
- **做法**:per-folder `index-recursive/` 缓存 + mtime 失效 + 原子写 + `inflight` 去重(抄 [transcode-cache.ts](../src/main/transcode-cache.ts) / `office-cache.ts` / FolderViz `index-archive` 形状,挂 `ipc.ts` 的 `cleanupMeta` / `fs:rename` / `fs:move` / `fs:copy` / `fs:importExternal` 钩)。

- [x] 实现(2026-07-14)— 新增 [recursive-cache.ts](../src/main/recursive-cache.ts)(镜像 `office-cache.ts`:path helper + `inflight: Map<key, Promise>` + 原子写 + 失效钩子)。缓存 `<dir>/.whale/index-recursive/d<depth>.json`,**只缓存 scan(`DirEntry[]`)**——这是 10k-stat 那步;sidecar 读更便宜且失效耦合 `wsd.json`,留后续。**对 renderer 透明**:IPC 仍返回 `DirEntry[]`,零 renderer/preload/ipc-types 改动。探查发现「FolderViz `index-archive`」无现成代码(docs 简写),实抄 transcode/office-cache。**hybrid 失效**(per-folder 比 per-file 多的难点):① 读时双守卫——`dirPath` 匹配(挡文件夹移动/复制带走的缓存,entries 旧路径)+ `folderMtime` 匹配(挡直接子项增删,WhaleTag 或外部 Explorer);② `invalidateRecursiveScan(path)` 清祖先(≤5 层)的 `index-recursive/`,挂 6 个 fs-op 钩子(delete/rename/move/copy/importExternal + **mkdir**,后者原先无任何缓存钩)。scanner 依赖注入(`listDirectoryRecursive` 从 ipc.ts 传入)便于测试。`recursive-cache.test.ts` 5/5 过(hit 不重扫 / mtime 变 miss / dirPath 变 miss / 祖先失效 / 不同 depth 独立)。type-check 干净。**defer**:sidecar 缓存、in-memory 简版、`truncated` 精确判定。

### P1-4. office→PDF 的 bytes 在 IPC 上双重拷贝

- **现状**:`convertOfficeToPdf` 返回 Node `Buffer`;IPC handler 拷成 `ArrayBuffer`;renderer 再 `new Uint8Array(msg.data)`。典型 office PDF 数 MB 到数十 MB。
- **影响**:每个文档打开白拷两遍。
- **参照**:[docs/09-known-issues.md](./09-known-issues.md) §16.4,明确列为浪费。
- **做法**:Electron IPC 透明支持 `Buffer` / `Uint8Array` / `ArrayBuffer` 互传,直传一个,删中间拷贝。一行级改动。

- [x] 实现(2026-07-13)— 把 office 路径端到端改成 `Uint8Array`(Buffer→IPC→renderer→iframe 本就产生 Uint8Array,原 `ArrayBuffer` 契约是错的)。① [ipc.ts](../src/main/ipc.ts) `ext:convertOfficeToPdf` 直接 `return loadOfficePdf(...)`(Buffer),删 `new ArrayBuffer + .set(buf)` 拷贝;② [ipc-types.ts](../src/shared/ipc-types.ts) / [ipc-api.ts](../src/renderer/services/ipc-api.ts) / [extension-types.ts](../src/shared/extension-types.ts) `OfficePdfContentMessage.data` 全 `ArrayBuffer→Uint8Array`;③ [office-viewer/index.ts](../src/extensions/office-viewer/index.ts) `pending.resolve(msg.data)` 直传(原先 `new Uint8Array(msg.data)` 在 msg.data 已是 Uint8Array 时会拷贝)。净省 1 次 memcpy/文档(原 3 次 byte 传输:ipc 拷贝 + IPC clone + postMessage clone → 现 2 次)。type-check 干净(office-viewer 在 tsconfig `src/**` 范围内,已覆盖)。**同类未做**:`ext:convertDwgToDxf` / `convertEbookToEpub` / `convertAudio` 是一样的 `new ArrayBuffer+.set(buf)` 拷贝,可照此批量改(各自 viewer 接收端也要相应直传)。

### P1-5. `GanttView` 用内联闭包废掉 `GanttRow` 的 memo

- **现状**:[GanttView.tsx](../src/renderer/components/GanttView.tsx) L821-853 给 `memo(GanttRowImpl)`([GanttRow.tsx](../src/renderer/components/gantt/GanttRow.tsx) L409)传的全是每次新引用:
  - L821 `onClickTag={(tag) => onClickTag?.(tag)}`
  - L822 `onTagContextMenu={(entry, tag, x, y) => onTagContextMenu?.(...)}`
  - L825 `onOpen={(e) => data.onOpen(e)}`
  - L835 `onDropEntry={(entry, dayKey) => {...}}`
  - L849 `onCommit={(entry, next) => {...}}`
  - L853 `onContextMenu={(entry, x, y) => setGanttMenu(...)}`
- **影响**:memo 永不短路,每次 `setGanttMenu`/`setZoom`/`setRange`/`setExportNotice` 重渲所有可见行。`onClickTag`/`onTagContextMenu`/`onOpen` 的 wrapper 还是纯转发,多余。
- **做法**:直接传 `data.onOpen`、`data.onClickTag`、`data.onTagContextMenu`(FileList 已 `useCallback` 稳定);其余按需 `useCallback`。

- [x] 实现(2026-07-14)— 6 个 GanttView→GanttTimeline 内联闭包全稳定:① 3 个纯转发直接传 `data.*`——`onClickTag`/`onTagContextMenu`(从 `data` 解构,FileList `useCallback` 稳定)、`data.onOpen`(原 `onOpen={(e)=>data.onOpen(e)}` wrapper 多余);② `onDropEntry` → `handleDropEntry` `useCallback([readOnly, data.onSetEntryDateTag])`;③ `onCommit` → `handleCommit` `useCallback([data.onSetEntryDateTag])`;④ `onContextMenu` **复用 P0-4 已建的 `openEntryMenu`**(`setGanttMenu({entry,x,y})` 同形)。**关键额外发现(审计未列)**:光稳 GanttView 闭包不够——[GanttTimeline.tsx](../src/renderer/components/gantt/GanttTimeline.tsx) L788 还有 **per-row `onCommit` adapter** `(_path, next) => onCommit(row.entry, next)`,每渲染每行新函数,**这才是真正让 GanttRow memo 永不短路的 spoiler**。修法:把 entry-binding 从 GanttTimeline 下沉到 **GanttRow 内部**(与 `onClick` 已有的 `(_path, e) => onClick(entry, e)` 同模式)——GanttRow `onCommit` prop 改 `(entry, next)`、内部 `onCommit={(_path, next) => onCommit(entry, next)}` 给 GanttBar;GanttTimeline 改 `onCommit={onCommit}` 直传。`useBarDrag`/`GanttBar` 的 `(path, next)` 契约不动(测试零改)。`row` prop 本就稳定(`displayRows`/`swimLanes` 均 `useMemo`,scale/range/menu 变不重算)→ 两 spoiler 修完后,GanttRow memo 在 `setGanttMenu`/`setExportNotice` 等纯状态变化时真正 bailout(`setZoom`/`setRange` 改 `pxPerDay`/scale → 行理应重渲,正确)。**验证**:`type-check` 干净;eslint 仅 2 个**既有** warning(GanttTimeline `RefObject`/`laneBoundaryIndices` 未用,与本次无关);GanttView + useBarDrag + useGanttKeyboardNavigation 全过(含 #5 domain 菜单、#8/#15 drop 路径、#10/#11 右键、`useBarDrag state machine`=onCommit 链路)。

### P1-6. 文件夹缩略图无并发上限

- **现状**:renderer 队列 `MAX_CONCURRENT=4`([thumb-load-queue.ts](../src/renderer/services/thumb-load-queue.ts) L25)只管**文件**缩略图 IPC。文件夹缩略图走单独 IPC(`thumbnail:loadFolder` 等,[ipc.ts](../src/main/ipc.ts) L1000-1032),无队列无主进程信号量。
- **影响**:宽树展开并发触发多个 `generateFolderThumbnail`,每个又对首个可缩略子项调 `generateThumbnail` → 并发 fan-out 大量 sharp/ffmpeg/pdfjs/soffice。主进程只有 per-source `inflight` 去重,无全局 cap。
- **做法**:`doGenerateThumbnail` 外包共享 `Semaphore(4)`(匹配 renderer 预算,或 `os.cpus().length`),顺带覆盖非 renderer 调用方(folder thumb、setFolderThumbnail)。

- [x] 实现(2026-07-14)— 加 `thumbnailSemaphore = new Semaphore(4)`([concurrency.ts](../src/main/concurrency.ts),抄 `sofficeSemaphore`/`mediaConvertSemaphore` 范式)。`doGenerateThumbnail` 把**encode+write** 包进 `thumbnailSemaphore.run(async () => {...})`;**便宜的 kind/stat/reuse 短路留在 permit 外**(缓存命中不占槽)。`generateThumbnail` 的 `inflight` 去重仍在上层——同文件并发仍只编一次,不同文件最多 4 路并发。因 cap 在 `doGenerateThumbnail` 内,**所有调用方自动覆盖**:file-thumb IPC(renderer 队列 4)、`generateFolderThumbnail`(L665)、`setFolderThumbnail`(L684)全共享同一 4-permit 预算。lambda 内的 `return`(office/ebook/svg/font 静默失败)从 run 返回(undefined,不写盘);`throw e` 经 `Semaphore.run` 的 `finally release` 仍正确释放槽。`type-check` 干净;`thumbnail.test.ts` + `concurrency.test.ts` 28/28 过(含「dedupes concurrent generation of the same video」回归闸)。

---

## 🟡 Tier 2 — 中等收益

### P2-1. 缩略图无内存缓存,滚动反复读盘 + base64

- **现状**:[thumbnail.ts](../src/main/thumbnail.ts) L489-496 `loadThumbnail`,每次 `fsp.readFile` + `buf.toString('base64')` + IPC 序列化,无内存缓存。renderer 队列只去重 in-flight,不跨 mount 记 data URL。
- **影响**:来回滚大目录,每张 JPEG 重读重编码;base64-over-IPC 还多 33% 体积。
- **做法**:① main 加 mtime-keyed LRU(`doGenerateThumbnail` 已有 mtime 检查可复用);或 ② 走已有 `whale-file://` 流式协议([main.ts](../src/main/main.ts) L466,已 Range-aware + Chromium 缓存,已 confine 到 allowed roots)替代 base64-over-IPC。

- [x] 实现(2026-07-14)— 取做法 ①(改动小、零行为变化;② 要改 renderer `<img src>` 与 CSP,风险大)。`loadThumbnail` 加**进程内 LRU**(`thumbCache: Map<path, {mtimeMs, dataUrl}>`,cap 500,Map 插入序淘汰最旧)。失效信号用 thumb 文件的 `mtimeMs`——`doGenerateThumbnail` 生成时已把 thumb mtime 盖到 `>= srcMtime`(L454),所以重新生成必换 mtime → 自动 miss。`loadThumbnail` 改 `fsp.stat`(既是存在检查又是失效信号,替掉原 sync `existsSync`+`readFile`),命中即返缓存 data URL(LRU 命中重插到队尾);未命中才 `readFile`+base64。`removeThumbnail` 同步删缓存项。行为零变化:`thumbnail.test.ts` 全过(含 "returns null when none" / "reuses when unchanged (mtime)" / "removes a thumbnail" / 多种生成→load 链路);`type-check` + `eslint` 干净。**未做**:`loadFolderThumbnail`(L666)同形,但频率远低于文件缩略图(每文件夹一次),留作按需。② `whale-file://` 直传仍是一个更彻底的退路(省掉 base64 33% + IPC clone),需要时再上。

### P2-2. `SELECT count(*)` 全表扫描轮询状态

- **现状**:[index-db.ts](../src/main/index-db.ts) L417 `hasFulltext`、L425 `indexStatus` 用 `SELECT count(*) AS c FROM files` / `FROM fulltext_fts`,大索引上全扫。经 `index:status` / `fulltext:has`([ipc.ts](../src/main/ipc.ts) L884、L901)被 renderer 轮询就绪状态。
- **做法**:`meta` 表按 root 存计数,`ingestFiles` / `insertFulltext` 同事务内更新;或用 FTS5 的 `files_fts_size` 虚表(O(1))。

- [x] 实现(2026-07-14)— 加 `meta(key TEXT PRIMARY KEY, value INTEGER)` 表。`files_count`:**不维护增量 delta,直接在每次 ingestFiles 末尾写 `seen.size`**(ingest 后 files 表恰等于 `seen`——不变行留着、变更新增行 upsert、移除行删——所以 `seen.size` 即精确行数;每次重写=自愈)。`indexStatus` 走新 `getFileCount(db)`:读 meta 命中即 O(1);**老库(P2-2 前创建、meta 无 files_count 行)回退一次 `count(*)` 并写回缓存**,故老库最多扫一次、之后永远 O(1)。`hasFulltext` 改 `SELECT 1 FROM fulltext_fts LIMIT 1`(命中首行即停,替掉全段扫描的 `count(*)`)——它只要布尔,无需精确计数,故不为它维护 fulltext 计数(多写路径 insert/delete/replace 维护成本高、不值)。`type-check` 干净;index-db 测试 15/15 过(含新增「count tracks adds + deletes across re-ingests」回归闸,锁 `seen.size` 在增删重 ingest 下不漂移)。注:这些查询现在跑在 utilityProcess worker(P0-2),不阻塞主线程,但 O(1) 仍省 worker CPU + 减少轮询延迟。

### P2-3. better-sqlite3 每次击键都重新 prepare

- **现状**:[index-db.ts](../src/main/index-db.ts) L226 `queryFiles`、L296 `advancedQuery`、L303 `distinctTags`、L399 `queryFulltext`,每次 `db.prepare(sql)` 新编译。搜索 as-you-type 每键触发。
- **做法**:模块级 `Map<string, Statement>` 按 SQL 串缓存(`advancedQuery` 按 filter shape 组装的 SQL 同形状会复现)。

- [x] 实现(2026-07-14)— 加 `prepareCached(db, sql)` + `stmtCache: WeakMap<DB, Map<sql, Statement>>`。**必须按 DB 实例 key**(Statement 绑连接;`WeakMap` 让关闭+GC 的 db 缓存自动回收,reopen 的 db 拿全新缓存无 stale)。Statement 类型用 `Database.Statement<unknown[], unknown>`(BindParameters=`unknown[]` 才能 `.get()`/`.all()` 零参或多参调用——`ReturnType<DB['prepare']>` 会解出 `unknown[] | {}` 导致 `.get()` 报缺参,踩过)。**只缓存查询热路径**(`queryFiles` 两条 / `advancedQuery` / `distinctTags` / `queryFulltext`)+ P2-2 的新 meta 查询;ingest/EXIF 的 prepare 不动(每次调用内已 prepare 一次、循环复用,跨调用缓存收益≈0,保持最小改动面)。`advancedQuery` 按组装后的完整 SQL 串缓存——同 filter shape 跨击键产同串 → 命中,只有 param 值不同(在 `.all()` 绑定,非 prepare 时)。`type-check` + `eslint` 干净;index-db 15/15 过。

### P2-4. selector 返回整 slice / `?? {}` 每次新引用

- **现状**:
  - [Sidebar.tsx](../src/renderer/components/Sidebar.tsx) L208-209:`useSelector((s) => s.locations)`(整对象)+ `useSelector((s) => s.settings)`(整对象)→ 任何字段变更都重渲。
  - [CurrentLocationContextProvider.tsx](../src/renderer/hooks/CurrentLocationContextProvider.tsx) L66:同型问题。
  - `?? {}` / `?? []` 每次新引用:[AdvancedSearchDialog.tsx](../src/renderer/components/AdvancedSearchDialog.tsx) L80、[TagGroups.tsx](../src/renderer/components/TagGroups.tsx) L159、TaskReminder L58、TagLibrary L139——`tagColors` 未定义时每次返回新 `{}`,任何 store 更新都强制重渲。
- **做法**:选 primitive(`useSelector((s) => s.locations.items)` / `s.settings.defaultLocationId`);hoist 模块级 `const EMPTY_OBJ = {}; const EMPTY_ARR: never[] = [];`;或用已有 `useShallowEqualSelector`。更彻底:reducer 初始化好这些字段,`??` 永不命中。

- [x] 实现(2026-07-14)— **真问题是 whole-slice selector,不是 `?? {}`**。核对 reducer:`settings.tagColors`/`taglibrary.groups`/`workflow.stages`/`savedsearches.items`/`locations.items` **全都已初始化**(`combineReducers` 保证 slice 恒在 + 各 reducer initialState + settings migrate 补 tagColors),故审计列的 4 个 `?? {}`/`?? []` 位点(TagGroups/TagLibrary/TaskReminder/AdvancedSearchDialog)**按审计自己的「彻底」标准已满足**——`?? {}` 实际永不命中、永远返回稳定 reducer 引用。仍按 MapiqueView P0-3 范式把它们 harden 成共享 `EMPTY_OBJ`/`EMPTY_ARR`([constants.ts](../src/renderer/constants.ts),`never` 类型通配)做 defense-in-depth + 显式意图。**真正改动**:① Sidebar `const { items } = useSelector(s=>s.locations)` → `s.locations.items`(原先切 `activeId` 也重渲);② Sidebar `const { defaultLocationId } = useSelector(s=>s.settings)` → `s.settings.defaultLocationId`(原先任何 settings 变更都重渲)。**不改** CurrentLocationContextProvider L66:它同时用 `items`+`activeId`,而 `LocationsState` 恰只有这两字段,whole-slice 与 narrow 行为完全等价。`type-check` + `eslint` 干净。

### P2-5. `EntryTagChips` / `ThumbIcon` 未 memo

- **现状**:[EntryTagChips.tsx](../src/renderer/components/EntryTagChips.tsx) L27、[ThumbIcon.tsx](../src/renderer/components/ThumbIcon.tsx) L31,每个单元格都渲染(Row / GridCell / GalleryCell / EntryCard / GanttRow / MapiqueTrayRow——可见数十到数百实例),且都订阅 redux(`tagShape` / `officeThumbnailEnabled`+`sofficePath`)。
- **影响**:行因 hover/drop 重渲时,这俩 props 没变也跟着白渲。
- **做法**:`React.memo`。props 全是 primitive / 来自 `cellData` 的稳定引用。

- [x] 实现(2026-07-14)— `EntryTagChips` / `ThumbIcon` 各包 `memo(Base)`(抄 EntryCard P0-4 的 `export default memo(XBase)` 范式)。**ThumbIcon** props 全 primitive / FileList 拥有的 `thumbCache` Map,无需改调用点,memo 在所有调用点(List/Grid/Gallery/Gantt/Kanban/Matrix/Calendar/Mapique/PropertiesTray)直接生效;缩略图仍靠自身 `useState` 刷,memo 不冻填充。**EntryTagChips** 要先稳 props:① 4 个调用点(Row/GridCell/EntryCard/GanttRow)的 `containerSx={{...}}` 内联字面量 hoist 成模块级 `TAG_CHIPS_SX`(`as const` 撑住 `flexWrap:'wrap'` 等字面量对 SxProps 的窄类型),否则 memo 永不命中;② Row/GridCell/EntryCard 的 `tagsByName.get(entry.path) ?? []`(无 tag 行每渲染新数组)改 `?? EMPTY_ARR`(GanttRow 的 `tags` 来自已 memo 的 `row`,稳定,不动)。回调(`onClickTag`/`onTagContextMenu`)/`tagColors`/`groups`/`t`/`activeTag`/`entry` 均来自 FileList `cellData`(`useCallback`/`useMemo` 稳定)。`type-check` + `eslint` 干净;KanbanView/MatrixView/GanttView/GanttEntryMenu 83/83 过。

### P2-6. `KanbanView.bucketEntries` 在 render body 未 memo

- **现状**:[KanbanView.tsx](../src/renderer/components/KanbanView.tsx) L88-89,`const buckets = bucketEntries(...)` 每次 KanbanView 渲染重算(选中、菜单、hover 都触发)。`MatrixView.tsx` L69-72 同调用正确 `useMemo` 了——这是漏网。
- **做法**:`useMemo(() => bucketEntries(entries, stageValues, tagsByName), [entries, stageValues, tagsByName])`。一行。

- [x] 实现(2026-07-14)— `stageValues` 先 `useMemo(() => stages.map((s) => s.value), [stages])`(原 `stages.map(...)` 每渲染新数组,直接进 deps 会让 buckets memo 永不命中);`buckets` 照 MatrixView 范式 memo;顺手把 `columnKeys`(`[...stageValues, UNTAGGED_COLUMN]`)也 memo(它传进 `columnKeys.map` 渲染列,稳定引用更干净)。`useMemo` 已在 import 列表。`type-check` + `eslint` 干净;KanbanView/MatrixView/GanttView/GanttEntryMenu 测试 83/83 过。

### P2-7. 重型原生依赖仍 eager import

- **现状**(pdfjs 已 lazy `getPdfjs()`,这批没跟上):
  - [thumbnail.ts](../src/main/thumbnail.ts) L5 `import sharp`、L6 `import ffmpegStatic`(L6 只当路径串用)、L7 `@napi-rs/canvas`
  - [exif.ts](../src/main/exif.ts) L8 `import exifr`(大型多媒体解析器,仅 `extractGps` / `getExifSummary` 用)
  - [ipc.ts](../src/main/ipc.ts) L6-7 `jschardet` + `iconv-lite`(仅 `readTextFile` 用)、L8 `@napi-rs/canvas`(仅画一次拖拽 fallback 图标)
  - [font-thumb.ts](../src/main/font-thumb.ts) L14、[drawio-thumb.ts](../src/main/drawio-thumb.ts) L3、[excalidraw-thumb.ts](../src/main/excalidraw-thumb.ts) L2:`@napi-rs/canvas`
- **影响**:这些原生模块给每次冷启加可测延迟,即便该 session 不碰成像/FTS/canvas。
- **参照**:[docs/01-architecture.md](./01-architecture.md) §4 冷启惰性加载已建范式;`getPdfjs()` via `createRequire(__filename)`。**注意硬约束** [docs/09-known-issues.md](./09-known-issues.md) §19:主进程必须保持 CommonJS,`module: 'esnext'` 会把 `createRequire` stub 成 `undefined`。
- **做法**:补 `getSharp()` / `getCanvas()` / `getExifr()` / `getChardet()`。`better-sqlite3` 几乎每操作都用,eager 正确,不动。

- [x] 实现(2026-07-14)— 新增 [lazy-native.ts](../src/main/lazy-native.ts):`getSharp()` / `getCanvas()` / `getExifr()` / `getChardet()` / `getIconv()`,全用 `createRequire(__filename)`(`nodeRequire`)+ 模块级 `let _x` 缓存,照 `getPdfjs()` 范式。**sharp 类型坑**:`typeof import('sharp')` namespace 在类型位不可调用(报 no call signatures),改 `typeof import('sharp')['default']`(esModuleInterop 合成的 default 才是 callable factory)。改的文件:① [thumbnail.ts](../src/main/thumbnail.ts) 删 `import sharp` + `import { createCanvas }`(`ffmpegStatic` 保留——只当路径串用,极廉价),4 处 `sharp(...)` → `getSharp()(...)`,1 处 `createCanvas` → `getCanvas().createCanvas`。② [exif.ts](../src/main/exif.ts) `exifr.gps/parse` → `getExifr().gps/parse`。③ [ipc.ts](../src/main/ipc.ts) `chardet.detect`/`iconv.decode`/`createCanvas` → 三个 getter。④ [font-thumb.ts](../src/main/font-thumb.ts) `createCanvas`+`GlobalFonts` → `getCanvas().*`,L75 的 `ReturnType<ReturnType<typeof createCanvas>['getContext']>` 改 type-only `SKRSContext2D`。⑤ [drawio-thumb.ts](../src/main/drawio-thumb.ts)/[excalidraw-thumb.ts](../src/main/excalidraw-thumb.ts) `createCanvas` → `getCanvas().createCanvas`(`SKRSContext2D` 保留为 type-only)。**webpack**:exifr/jschardet/iconv-lite 原本被 bundle(sharp/canvas/pdfjs 早 externalized),在两份 main config 的 `externals` 加这 3 项,与 sharp/canvas 一致。**冒烟**:`build:main:dev` 通过;bundle 里 5 个 `nodeRequire('...')` 全在 getter 内、createRequire 未被 stub(9 处)、sharp/canvas/exifr/jschardet/iconv **不再出现在 bundle 依赖图**(无 `external "sharp"` stub,因无静态 import)——冷启不再付这 5 个原生/重型 JS 模块的加载。type-check(本项文件)+ eslint 干净;thumbnail/exif/concurrency/font-thumb 测试 45/45 过。

---

## 🟢 Tier 3 — 较小 / 长期

### P3-1. office-viewer 冷转码期间无缩略图占位

- **现状**:[thumbnail.ts](../src/main/thumbnail.ts) L138-165 已为 office 生成 256px JPEG(`.whale/thumbs/<basename>.jpg`),但 office-viewer iframe 没用它。`soffice` 转码 2-5s 冷启期间 iframe 空白无进度。
- **参照**:[docs/09-known-issues.md](./09-known-issues.md) §16.10。
- **做法**:extension ready 时**并行** `requestThumbnail` + `requestOfficeConvert`;先显 jpg + 进度标签,再 crossfade 到渲染 PDF;缓存命中也用缩略图当首页占位。

- [x] 实现(2026-07-15)— 新增消息对:`requestThumbnail`(ext→host)+ `thumbnailContent`(host→ext,data URL | null)([extension-types.ts](../src/shared/extension-types.ts));host 桥([ExtensionHost.tsx](../src/renderer/components/ExtensionHost.tsx))`case 'requestThumbnail'` 调 `ipcApi.loadThumbnail(path)` 回 data URL。office-viewer `openOfficeFile` **并行** fire `requestThumbnail` + `requestOfficeConvert`;缩略图到达即 `showThumbnailPlaceholder`(居中 `<img>` + `opacity:0.85` + 阴影),`renderPdf` 清掉占位画真页。双守卫防覆盖:token 比对(被新开档/renderPdf 超越则弃)+ `pagesEl.querySelector('canvas')`(真页已画则弃)。取做法的「先显 jpg + 进度标签」;**未做 crossfade**(简化:`renderPdf` 直接清占位画真页,无过渡动画——可后续加 CSS transition);「缓存命中也用缩略图当首页占位」部分满足——缓存命中 convert 快、占位窗口极短,但 **cold convert(主场景)占位完整覆盖 2-5s**。**验证**:`type-check` + `eslint` 干净;pdfjs-in-iframe 22/22;`build:extensions` 15 个扩展全过(office-viewer bundle 1.65MiB)。详见 [docs/09 §16.10](./09-known-issues.md)。

### P3-2. office-viewer 缺 pdf-viewer 同款 rAF resize/scroll

- **现状**:office-viewer 仅手动 +/- 缩放。缺 ResizeObserver + rAF 重排("窗口 resize 时不重新渲染像素,只重排 CSS")与 scroll 同步 `currentPage` via rAF("scroll 事件 rAF 找出最接近视口顶 25% 的页")。
- **影响**:大 office PDF 在 resize 时重栅格化、滚动 handler 无节流 → 卡顿。
- **参照**:[docs/09-known-issues.md](./09-known-issues.md) §16.8;§16.7 已抽出公共 `src/extensions/shared/pdfjs-in-iframe.ts`。
- **做法**:复用该公共 session plumbing,接上 rAF 批量 resize/scroll。

- [x] 实现(2026-07-15)— **只移植了 scroll 半边**(有真实价值):office-viewer 给 session 加 `onAfterPageRender` 给每张 canvas 盖 `data-page-num`(office 原本忽略该 hook);新增 `currentPage`/`totalPages` 状态 + rAF scroll handler(抄 pdf-viewer 的「top ≤ 视口顶 25% 且最接近」规则),`pageInfoEl` 从静态 `N / N` 改 `cur / total`。**resize 半边对 office 是 N/A**:office 画布是**固定 px 宽**(`renderPageContent` 设的 `baseVp.width` px,无 fit-mode),容器 resize 既不重栅格化也不需要 CSS relayout——没东西要节流。审计「现状/影响」描述的 resize 重栅格化 / 滚动 handler 无节流,对 office 的固定-px 模型不成立(office 连滚动 handler 都没有);真正缺的就是 scroll-sync 这半边,现已补。**验证**:`type-check` + `eslint` 干净;pdfjs-in-iframe 22/22;`build:extensions` 全过。

### P3-3. 长期:UNO/soffice 常驻后台进程

- **现状**:`sofficeConvertArgs()` 已加 `--norestore --nologo --nofirststartwizard`(~30-50% 提速);共享 `sofficeSemaphore`(cap 1)防 profile-lock 损坏。但每次 convert 仍付全新 `soffice` 进程 spawn 成本。
- **参照**:[docs/09-known-issues.md](./09-known-issues.md) §16.2:「长期 UNO 后台进程仍是 follow-up」。
- **做法**:保活 UNO listener,convert 任务派发过去而非每次 spawn。是 P1-1 / P3-1 的根本解。

- [ ] 实现

### P3-4. AI 流式 `thinkingStreamed`/`textStreamed` boolean 兜底

- **现状**:per-uuid `streamedMsgs` 去重疑似失效(SDK partial vs complete uuid 不匹配);加了 per-turn boolean 对兜底,能用,但 complete 消息被 yield 两次再过滤——每轮多做一次渲染。
- **参照**:[docs/09-known-issues.md](./09-known-issues.md) §23「遗留/未决」。Windows `electronmon` 留 zombie electron 锁 userData 磁盘缓存,当时没法干净诊断。
- **做法**:记 uuid 流向日志确诊;确认后让 `streamed` 的 uuid 检查原生生效,删 boolean 标志,complete 消息在源头短路。

- [ ] 实现

### P3-5. 零碎项(单点小、批量做)

- [x] ~~`firstThumbnailableFile`~~(2026-07-15 评估→**不做**)— 它是「按排序名找第一个可缩略文件」+ 早返回。常见情况第一个候选就是文件(目录极少带可缩略扩展名)→ **1 次 stat** 即中。换 `mapWithConcurrency` 反而会 stat 全部候选(过度取数),对 find-first 是劣化。已是最优,留原样。
- [x] ~~`distinctTags`~~(2026-07-15 评估→**不做**)— 仅 advanced-search 标签选择器开打时调一次,**非热点**(非每键)。trigger 维护 `tags` 表要管多对多计数(add 增 / file-delete 减 / 归零删),复杂且易漂移;递归 CTE 切空格 gnarly。当前 `SELECT tags ... split/Set` 简单正确,留原样。
- [x] `importExternal`([ipc.ts](../src/main/ipc.ts))串行 `for { await fsp.cp }` → `mapWithConcurrency(sources, 4, ...)`(2026-07-15)。**name dedup 无竞态**:`nextAvailableName` + `taken.add` 在首个 `await` 前同步执行,JS 单线程不交错;per-item 返回 destPath/error,结果按序聚合。
- [x] `atomicWrite`([atomic-write.ts](../src/main/atomic-write.ts))每次写 `readdir`+N `rm` 扫残留 temp → per-target `sweptTargets: Set<string>` 记已扫(2026-07-15)。`.whale/thumbs/` 这种高基数目录原本每次 thumb 写都 readdir 全目录(O(n)/写、O(n²)/n thumb)。残留 temp 来自真实 crash(正常写自清);后来的 crash temp 名字唯一(pid+counter)不撞,等下次会话首扫清。
- [x] `odaConverterBinary`([cad-convert.ts](../src/main/cad-convert.ts))加 `let _odaCache` memo(2026-07-15)— 抽 `detectOdaConverter()` 纯探测,no-override 结果缓存(ODA 装载路径会话内不变)。
- [x] `getPdfAsset` / `readCadWasm` / `readHeicWasm`([ipc.ts](../src/main/ipc.ts))不可变字节缓存源 `Buffer`(2026-07-15)— pdf asset 走 `Map<path,Buffer>`、两 wasm 各 `let _xxxBuf`。仍每次返回**新拷贝 ArrayBuffer**(字节过 IPC→iframe,emscripten 可能消费)。
- [ ] `extractPdfText`([fulltext.ts](../src/main/fulltext.ts) / [thumbnail.ts](../src/main/thumbnail.ts))整 PDF 读进内存 → 病态大 PDF 内存峰值(**罕见,可接受,仅记录**;见下「已接受的取舍」)。
- [x] renderer 零碎(2026-07-15):① [FileToolbar.tsx](../src/renderer/components/FileToolbar.tsx) `recents` 加 `useMemo`(`recentItems` 顺带 `?? EMPTY_ARR` 稳定)+ toolbar RO 加 `prev===w` 守卫;② [GanttTimeline.tsx](../src/renderer/components/gantt/GanttTimeline.tsx) 删 no-op ResizeObserver(回调 `void el.clientWidth` 纯空转,scrollToToday 懒读 clientWidth,本就不需要它;顺带清未用的 `useLayoutEffect` import);③ [GalleryView.tsx](../src/renderer/components/GalleryView.tsx) 手动 width RO 加 `prev===w` 守卫(减少 resize tick 重渲;与 `<VirtualGrid onResize>` 的双路测宽结构未动——删手动 RO 有首帧布局 flash 风险,onResize 已有守卫,收益不值)。**未穷举**其余 RO 守卫(审计说「多处」),只补了被点名的热路径。

---

## ✅ 已接受的取舍(文档已决定不做,勿重复提)

| 项                                                      | 出处                                         | 理由                                                                                      |
| ------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| soffice 串行 cap 1                                      | [docs/06](./06-thumbnails.md) §3             | 并发 soffice 争 profile-lock 会损坏。P3-3 UNO 才是真解                                    |
| `mediaConvertSemaphore` cap 2                         | [docs/06](./06-thumbnails.md) §3             | 用户发起的一次性转换,intentional                                                          |
| depth-5 node_modules 200-500ms                          | [docs/08](./08-data-depth.md) §9             | 有截断 + loading 反馈,「可感知但不卡死」;P1-3 缓存是恶化时的退路                          |
| PDF 缩略图 CJK`notdef`                                | [docs/06](./06-thumbnails.md) §7             | `@napi-rs/canvas` 缺 pdfjs CJK 字表;缩略图尺寸可接受;完整 viewer 在 Chromium 内渲染绕过 |
| 缩略图管线无大文件保护                                  | [docs/06](./06-thumbnails.md) §7             | 仅 video 有首帧捷径;非 video 大文件走全解码,已知限                                        |
| per-folder depth override                               | [docs/08](./08-data-depth.md) §11            | 「不做,真需要再补」                                                                       |
| 首次索引大语料慢                                        | [docs/04](./04-search-index.md) §9           | loading spinner 缓解;仅主进程阻塞部分(P0-2)可做                                           |
| `index.db` 无单事务原子性                             | [docs/04](./04-search-index.md) §9           | 「可接受,缓存可重建」,correctness 取舍                                                    |
| `main.ts` L484 `whale-file://` handler `statSync` | 代码审计                                     | `<video>` range 热路径,异步 `fsp.stat` 加微任务延迟反而伤 seek,保持                   |
| `readSidecars` buildIndex 时每目录重读 `wsd.json`   | [indexer.ts](../src/main/indexer.ts) L13 注释 | 标签不改 mtime,mtime 缓存会错,正确                                                        |

---

## 🔧 可复用的已实现范式(做上面任务时照抄)

- **缓存形状**:`transcode-cache.ts` / `office-cache.ts` / FolderViz `index-archive` = mtime 失效 + 原子 `.tmp`+rename + 模块级 `inflight: Map<key, Promise>` 去重 + 删/改/移/拷钩(`ipc.ts` 的 `cleanupMeta` / `fs:rename` / `fs:move` / `fs:copy` / `fs:importExternal`)。P1-3 照此镜像。
- **惰性原生 require**:`getPdfjs()` via `createRequire(__filename)`。P2-7 扩展到 sharp / canvas / exifr / jschardet。注意 §19 CommonJS 硬约束。
- **批量让步**:`INGEST_BATCH=1000` + `setImmediate`、`mapWithConcurrency(8)`、EXIF `markExifProcessedMany` 25 行/fsync。P0-2 带进 utility process。

---

## 建议推进顺序

1. **P1-2**(删 persist `console.log`)—— 5 分钟、零风险、立刻见效。热身项。
2. **P0-1**(files 增量索引)—— 大库最大单点收益,fulltext 已有范式可抄。
3. **P1-1**(异步二进制探测)—— 消除最差的交互冻结。
4. **P2-7 + P1-6**(惰性重型依赖 + 文件夹缩略图信号量)—— 缩启动、限主线程最坏负载。
5. **P0-3 / P0-4 / P1-5**(Mapique memo、EntryCard memo、GanttRow memo 解锁)—— renderer 重渲一轮打包。
6. **P2-1 / P2-2 / P2-3**(缩略图缓存、count 缓存、prepared statement 缓存)—— 上面落地后的顺手项。
7. **P0-2**(索引进 utilityProcess)—— 结构性大改,放最后。
