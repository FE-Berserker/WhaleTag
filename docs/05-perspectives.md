← 返回 [plan.md](../plan.md)

# 05. 视角系统

> 9 类视角 + Task 第三档(子视图)、全部受全局 `viewDepth` 控制、单一数据源。
> 数据层详见 [docs/08-data-depth.md](./08-data-depth.md)。
> 本文最后更新于 **2026-07-06**。

## 1. ViewMode 联合类型

[src/shared/whale-meta.ts](../src/shared/whale-meta.ts) `ViewMode`(TS 联合 10 个字面量,运行时有效 9 个):

| literal | 性质 | 组件 | 说明 |
|---|---|---|---|
| `list` | active | [FileList](../src/renderer/components/FileList.tsx) | 虚拟滚动行列表(react-window v2) |
| `grid` | active | FileList + GridCell | 卡片网格 |
| `gallery` | active | GalleryView | 仅 image / video,等高网格 + Lightbox |
| `task` | active | TaskView | 第三档子视图:Kanban / Matrix / Gantt |
| `calendar` | active | CalendarView | 5 档子视图:month / week / year / agenda / week-timeline / year-heatmap |
| `mapique` | active | MapiqueView | Leaflet 地图 + 右侧详情托盘 |
| `folderviz` | active | FolderVizView | 4 图:tree / radial / treemap / sunburst(复用 Provider 递归结果,前端重建嵌套树) |
| `tagcloud` | active | TagCloudView | echarts-wordcloud,字号按文件数 sqrt |
| `knowledge-graph` | active | KnowledgeGraphView | xyflow(react-flow v12)标签↔文件二部图;导出三件套(save / save-as / copy,2026-07-22 补齐 copy);节点拖拽位置按 location 持久化(`whale.kg.<id>` prefs,2026-07-22) |
| `mindmap` | **legacy** | (无对应视图) | 旧 `ViewMode = 'mindmap'` 迁移为 `knowledge-graph` |
| `kanban` / `matrix` | **legacy 字面量** | (无对应视图) | 通过 `migrateViewMode` 映射为 `task` |

**legacy 迁移**(`whale-meta.ts:migrateViewMode`):

- `'mindmap'` → `'knowledge-graph'`
- `'kanban' | 'matrix'` → `'task'`

未识别的字面量走 `undefined`,UI fallback 到全局默认视角(由 `settings.defaultViewMode` 决定)。

每个文件夹的 `viewMode` / `entrySize` 持久化到 `.whale/wsm.json`,切走切回保持;目录加载时经 `migrateViewMode` 自动迁移。

## 2. Task 第三档:三套子视图

`viewMode = 'task'` 时,`TaskView` 内部 ToggleButton 三选一:**Kanban**(默认) / Matrix / Gantt。

**子视图持久化**:`localStorage.whale-task-subview`(非 `.whale/wsm.json`,**全局不 per-folder**)。

### 2a. Kanban

按 workflow 阶段分组,卡片 40×40 缩略图 + 文件名 + tag chips:

- 列头右键:新建文件夹 / 文件(自动打该阶段标签) + 管理阶段(打开 `WorkflowManagerDialog`)
- 卡片右键:`KanbanEntryMenu` 领域菜单(移动阶段 / 优先级 / 期间 / 编辑标签 / 打开 / 删除 / 更多文件操作)
- 多选拖拽:一组选中一起移动到目标阶段(由 `EntryCard.dragItem.paths` 携带所有选中 path)
- 拖 `period:` chip 到卡片 → 弹 `PeriodTagDialog`
- 无阶段空态(`kanbanNoStages`)在**所有 hooks 之后**渲染(2026-07-22 修:曾在 hooks 前 early-return,删光最后一个 stage 时 hooks 数变化 → "Rendered fewer hooks" 整视角崩溃);空态下 `WorkflowManagerDialog` 保持挂载,可就地补回阶段

### 2b. Matrix

Eisenhower 2×2 四象限 + 底部未分类托盘(**常显**,2026-07-22:空了显示 `matrixUntaggedEmpty` 提示而不再消失——托盘消失就没有"拖回未标记"的放置目标;托盘同 quadrant 一样接受系统文件拖入,`tagToApply: null` 不盖章):

- 卡片拖拽到不同象限写互斥 quadrant 智能标签
- 卡片右键:`MatrixEntryMenu`(同 KanbanEntryMenu 三段式,只是 "Move to stage" 那一段的工作流值从 props 传入)

### 2c. Gantt(`Tasks §3.3`)

**技术栈**:**纯 DOM**(无 ECharts,无 dataZoom)。放弃 ECharts 的原因:每个 `mouseup`/`mouseout` 触发 `CustomSeriesModel.getDataParams`,第一句读 `dataIndex.getRawIndex()`;自定义子元素无 data hookup 时 `dataIndex` 是 undefined → 抛错。故替换为 `GanttTimeline` 子组件 + `useBarDrag` hook,DOM 节点直接挂载。

主要机制(2026-07-05/06 一轮 P0+P1 全部落地;测试索引见 [§9](#9-gantt-测试与工程债索引)):

- **缩放方式**:**浏览器原生水平滚动**(无 dataZoom 滑块)
- **缩放档位**:工具栏 `Select`(Day / Week / Month),`useGanttZoom` hook,持久化 `whale-task-gantt-zoom` localStorage
- **快捷区间**:工具栏 `ToggleButtonGroup`(`1w / 2w / 1m / 1q`,再次点击已选项清除),[useGanttRange.ts](../src/renderer/components/gantt/useGanttRange.ts);`GanttRangePreset = '1w' | '2w' | '1m' | '1q'`,`ganttRangeToBounds(range, anchorKey=today)` 以锚点日期(默认今天)为中心生成 `[startKey, endKey]`;持久化 `whale-task-gantt-range` localStorage,shape `{ range?: GanttRangePreset }`,清空写 `{}`,非法 localStorage 值有 sanitize 不崩。选中时固定跨度,未选中回退自然任务区间;range(可见跨度)与 zoom(px-per-day)正交
- **拖拽改时间**:整体平移 + 左右边缘 resize(`useBarDrag` hook;pending→dragging 转换 bug 已修,见 hook 文件头)
- **键盘导航**:[useGanttKeyboardNavigation.ts](../src/renderer/components/gantt/useGanttKeyboardNavigation.ts) 持有 `focusedPath` + `tabIndexFor` + scroller-level keydown(scroller `tabIndex={-1}` + `outline: none`,集中处理避免 per-bar listener thrash);`↑↓` 切柱(跨 swim lane,环回)/ `← →` 移柱 ±1 天(走 `onCommit` 持久化,同拖拽)/ `Space` 弹 PeriodTagDialog / `T` 跳 today / `Esc` 清 focus。只有 focused bar 可 tab(其余 `tabIndex={-1}`);focus ring = `outline: 2px solid #1976d2; outline-offset: 2px; box-shadow: 0 0 0 4px rgba(25,118,210,0.25)`(a11y 底线,Chrome 默认 1px dotted 在 28px bar 上看不清);Ctrl/Meta/Alt + 任意键 no-op(不抢浏览器快捷键);readOnly 下焦点仍可移动,但 ← → / Space / commit 全跳过。`Shift+←→` 调长度**不做**(双轴反馈与单轴 ±1 天混在同一 hook 会让 state machine 复杂化)
- **泳道分组**:`groupRowsByWorkflow`([gantt.ts:248-290](../src/renderer/domain/gantt.ts))按 workflow stage 分 lane;每 lane 第一行上方有 18px header(stage 颜色圆点 + `tagDisplayLabel` 本地化名,`gantt-lane-divider-<i>` / `gantt-lane-chip-<i>` testid,**每个 lane 都画含第一个**——曾只在 laneIndex 变化处画,第一个 lane 没标记);无 stage 行落入"未分类" lane(`ganttNoStageLane`);行底色 = stage 色 10% alpha(`#XXXXXX1A`,经 `GanttRow.laneTintColor` prop 只改 `bgcolor`);日期 tick 行 `zIndex: 3` > lane header `zIndex: 2`(否则 header 的 top 定位遮挡日期);整 lane 全被过滤时显示 `gantt-hidden-lane-placeholder`("已隐藏 N 个阶段",`ganttLaneHidden`)。边界:`stages = []` → 全部行落入唯一 "no stage" lane、无分隔线;单 lane → 无分隔线;仅 1 行 → 走原 vertical windowing slice
- **筛选器**:工具栏两个多选 `Select`(workflow / quadrant),默认全选(=不过滤,不破坏老用户路径);未选中的行 `opacity: 0.3` + `pointer-events: none`(比 `display: none` 保留空间感)。共用 [useGanttTagFilter.ts](../src/renderer/components/gantt/useGanttTagFilter.ts)(generic over `T extends string`,quadrant 侧为 `useGanttTagFilter<string>('quadrant', QUADRANT_VALUES)`,两筛选器独立、交集生效);状态存 localStorage `whale-task-gantt-filter`,shape `{ workflow: string[]; quadrant: string[] }`,per-字段独立、持久化只写被改动字段。**`passes` 语义**(2026-07-05 用户修订):有已知 tag 的行须该 tag ∈ `selected` 才通过;无相关 tag 的行仅当 `selected.size === knownValues.length`(中性状态)时通过——用户一旦 un-select 任何值,tag-less 行立即隐藏(否则"只看 in-progress"会把没在任何阶段的行也露出来);stale / 已删除的值(`knownValues` 不含)忽略。`seenValuesRef` 区分"新出现的值"(auto-include)与"用户主动 un-select"(保持),避免 `useEffect([knownValues])` 重渲染把 un-selected 塞回。菜单项文本经 `tagDisplayLabel(value, t)` 本地化(直接 `{value}` 会显示 `not-started` 等原始英文 token)。多选含被过滤项时 `hasFilteredSource` prop 传入 menu,所有写动作(Move to stage / Set priority / Set period / Clear period / Delete / Edit tags)统一 `writesDisabled = readOnly || hasFilteredSource`,**Open 与 More actions 保持可用**;多选 toggle 用 `setAll` 一次写(避免逐值触发 localStorage 写入)。所有 scheduled 行都被过滤时,toolbar 下方显示橙色 Alert `ganttFilteredEmpty` + "Reset" 按钮(`gantt-filtered-empty`)
- **PNG 导出**:工具栏 save / save-as / copy-to-clipboard 三按钮,复用 [useImageExport](../src/renderer/hooks/useImageExport.ts) + `modern-screenshot`(Calendar / TagCloud / KG 同款;`dynamic import('modern-screenshot')` 只在点击导出时加载,与 test bundle 解耦):capture → base64 PNG → `ipcApi.writeBinaryFile`(save / save-as,经 `saveImageDialog`)/ `navigator.clipboard.write`(copy),3 个 IPC 路径复用既有、无新增。捕获目标 = inner chart-content Box(`gantt-chart-content`,scroller 内 `<Box ref={exportRef}>`),不抓 scroller 本身(避免把 scrollbar 烤进图)。copy 走 `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`,失败回退 `writeText(data:image/png;base64,...)`,Snackbar 区分 `ganttExportCopied` / `ganttExportCopiedAsBase64`;保存失败 tooltip 切 `ganttExportFail`;空 Gantt(`scheduled.length === 0`)不渲染 chart-content → capture 返回 null → `useImageExport` 抛 "Failed to capture image" → `ganttExportFail`
- **视觉状态**:`GanttBar` 根据 `periodStatus(period, todayKey)`(renderer/domain/gantt.ts)分 `overdue | inProgress | normal`;`overdue`(`endKey < today`)柱加红色描边 `outline: 2px solid #ef4444; outlineOffset: 1px`(用 `outline` 不用 `border`,不撑开内容盒、避免 drag 数学依赖的 `width` 被吃掉);`inProgress`(`startKey ≤ today ≤ endKey`)柱左侧加绿色 `PlayArrowIcon` 角标(14×14,`pointer-events: none`)+ `ganttInProgress` tooltip;today 竖线原本就有,不动
- **空态引导**:无 scheduled 且 Triage 非空时,空态文案显示 `ganttNoTasksHint`(“把 Triage 卡片拖到时间轴任意一天开始排期”);Triage 托盘首次出现时有 3 秒呼吸描边(`@keyframes whale-gantt-breath` 1.2s × 3 次),标志位 `sessionStorage['whale-gantt-triage-hint-shown']` 每会话一次;清空排期后切走再切回、重新满足条件时会再次提示
- **柱颜色**:固定 fallback 蓝 `#3b82f6`,**不读任何 tag**(2026-07-06 撤销 tag 派生方案,原因:① `colorFor` 走"tags 数组第一个有色的赢",顺序由用户加标签顺序决定,同文件不同加法颜色不同;② 随手加的无关 tag 排在前面就会抢走柱色,跨职责污染;③ workflow tag 场景下柱色与 lane 底色同色,两层变一层)。`colorFor: (entry: DirEntry) => string` 签名保留(`_entry` 参数不读),未来要复活 bar 独立颜色只换 body、另立项;lane 底色与 bar 色**两层解耦**,传 status 靠 overdue / inProgress 描边角标
- **数据源** = period 标签(`YYYYMMDD-YYYYMMDD`),**不发明新元数据**
- **Triage drop** = `onRemoveEntryDateTags(entries)`(一次批量清 period;host 内部走**一次** `saveMany`,legacy host 才回退逐条 `onRemoveEntryDateTag`)
- **底部 Triage** 沿用 Matrix `UntaggedTray` 模式(**常显**,2026-07-22:空了显示 `ganttTriageEmpty` 提示而不消失,保留"拖回取消排期"的放置目标)

## 3. 共享渲染三件套

[src/renderer/components/perspective/](../src/renderer/components/perspective/):

- `LoadingOverlay` —— 加载中半透明遮罩
- `EmptyHint` —— 空态提示
- `ErrorBanner` —— 错误展示

**实际只在 3 个视角**用:`KnowledgeGraphView` / `MapiqueView` / `TagCloudView`。

其他视角各自实现 loading/empty 状态(Gallery / Kanban / Matrix / Gantt / Calendar / Task / FolderViz)。

### 3a. MapiqueView 内部拆分(P2 拆分,2026-11)

`MapiqueView.tsx` 从 2120 行降到约 1190 行,内聚块抽到 [src/renderer/components/mapique/](../src/renderer/components/mapique/)(行为与 props 不变):

| 文件 | 职责 |
|---|---|
| `useMapiqueData.ts` | 数据层 hook:sidecar / geo 候选 / 已定位集合 / marker 颜色 / tray 排序与筛选,并导出 `visibleTrayEntriesRef` / `allTrayEntriesRef` / `trayIndexByPathRef` 保持 P0-3 稳定性 |
| `tray-data.ts` | 纯函数:`haversineKm` / `buildSidecars` / `sortTrayEntries` / `filterTrayEntries`(node:test 单测,不依赖 React) |
| `constants.ts` | 瓦片 URL / attribution、`PANEL_WIDTH` / `PREVIEW_HEIGHT`、空 `tagColors` / `groups`、`TrayFilter` / `TraySort` / `MapiquePrefs` |
| `GeoMarker.tsx` | 唯一 `React.memo` 边界(Leaflet marker),P0-3 的收益靠它兑现 |
| `MapPopup.tsx` / `pin-icon.ts` | marker 弹窗与 pin DOM 图标(含 `escapeAttr` / `cssAttrValue`) |
| `MapInterop.tsx` | 命令式 Leaflet 互操作组件:`MapContextMenuHandler` / `MapMoveTracker` / `MapClickHandler` / `AutoResize` / `InvalidateOnChange` / `FitBounds` |
| `BatchPanel.tsx` | 多选时的批量打标面板 |
| `MapiqueToolbar.tsx` / `MapiqueFilterBar.tsx` / `MapiqueDetailPanel.tsx` | 顶部工具条 / 侧栏筛选条 / 详情内容(空态、批量、单条预览 + 坐标 + inline tags) |

`MapiqueView.tsx` 仍持有:地图画布 JSX(含 Markers 列表)、选区与键盘、EXIF 探测/回收、导出与撤销、右键菜单与 Snackbar。测试:`mapique/tray-data.test.ts`(纯函数)+`mapique/MapiqueToolbar.test.tsx`(disabled 矩阵)+ 原 `MapiqueView.test.tsx` 5 例。

### 3b. CalendarView 内部拆分(P2 拆分,2026-11)

`CalendarView.tsx` 从 2264 行降到约 490 行,内聚块抽到 [src/renderer/components/calendar/](../src/renderer/components/calendar/)(默认导出、props(`FileCellData`)与行为不变):

| 文件 | 职责 |
|---|---|
| `types.ts` | `CalendarViewMode` / `GroupingSource` / `SubViewProps`(周期子视图共享 props) |
| `constants.ts` | `CELL_MIN_HEIGHT` / `ENTRY_THUMB` / 共享 `EMPTY_ENTRIES` / `HOURS`(memo 稳定性依赖模块级恒等) |
| `prefs.ts` | `PREFS_KEY_PREFIX` / `CalendarPrefs` / `loadCalendarPrefs`(localStorage,per-location) |
| `CalendarToolbar.tsx` | 顶部工具条三段(日期导航 / grouping + range 筛选 / 视图模式 + year 变体 + PNG 导出),range 变化经 `onRangeChange` 交给宿主做 cursor 跳转 |
| `MonthView.tsx` / `WeekView.tsx` / `TimelineView.tsx` / `AgendaView.tsx` / `YearView.tsx` | 五档周期视图;`YearView` 内含 `YearMonthTile` |
| `YearCharts.tsx` | 年视图的 `YearHeatmap` 与 `YearTrendChart`(ECharts) |
| `DayCell.tsx` | 日格:drop 目标(内部拖拽走 P1-2 批量日期回调)、左键空区新建、右键新建菜单;`CalendarEntryItem.tsx` 为格内条目行 |
| `DatePickerPopover.tsx` | 跳转日期弹层 |

`CalendarView.tsx` 仍持有:状态与派生数据(`bucketsAll` / range 过滤 `buckets` / `hourBuckets` / `entryTimeLabel`)、prefs hydrate/persist、`shouldJumpCursor`(命名导出,测试依赖)、工具栏接线、视图切换、`CalendarEntryMenu` 与 Snackbar。测试:`calendar/DayCell.test.tsx`(7 例)+ 原 `CalendarView.test.tsx`(40 例)全部保持通过。

## 4. 全局递归深度 `viewDepth`

**所有 9 个有效视角受 `viewDepth ∈ [1, 5]` 控制**,默认 1(等同"只看当前目录")。`settings.viewDepth` 走 redux-persist,**全局不 per-folder**。

- 深度 1 = 当前目录(等同历史行为)
- 深度 5 = 递归纳入 5 层子目录文件;`MAX_RECURSIVE_ENTRIES = 10000` 截断

**实现层**:由 [DirectoryContentContextProvider](../src/renderer/hooks/DirectoryContentContextProvider.tsx) 处理,**单一数据源**;所有视角从 context 拿全部所需数据。Map 全部以 **`entry.path` 为 key**(`tagsByName.get(e.name)` 改成 `tagsByName.get(e.path)`,修复同名跨目录文件互不污染)。

**工具栏**深度 Slider(70px,无 marks,1–5):`FileToolbar.tsx` 直接 dispatch `setViewDepth`(无 marks、`valueLabelDisplay="auto"`、70px);**200ms 防抖在 `DirectoryContentContextProvider` 内**(`useEffect` + `setTimeout` 守卫 `debouncedDepth`),拖动 1→5 只触发 1 次递归 IPC。

`FileToolbar` 顶部全局入口,各视图自带深度滑块已删除(原 TagCloud / KG / Mapique 各自维护的 `whale.<view>.<id>.maxDepth` 已清理)。

**FolderViz 数据复用**:同样从 Provider 读取 `entries` / `loading` / `error` / `refresh`,用 `useMemo` 重建嵌套树;`filterMode` 切换只是纯前端投影,不再发第二次递归 IPC。隐藏文件遵循 Provider 的 `showHiddenFiles` 规则。`whale.folderViz.<id>` localStorage 只保 `vizType`,`hiddenFilesInFolders` / `filterMode` 视图局部状态不动。

## 5. 拖拽打标一致性

9 视角的拖拽打标行为统一:

- 从标签库 chip 拖到 entry(行 / 卡片 / tile / node / marker)→ 调 `onDropTag`
- 单文件 / 多选 / 文件夹三种落点都支持
- 多文件落到**日期维度**(Calendar 日格 `onSetEntryDateTags`、Gantt Triage `onRemoveEntryDateTags`)→ 一次批量回调,host 内部只发**一次** `saveMany`;逐条 `onSetEntryDateTag` / `onRemoveEntryDateTag` 仅作 legacy 兜底(2026-11 gui-audit P1-2,此前 N 条拖拽 = N 次单文件 save + N 次 O(N) 重算)
- `period:` chip 落 → 弹 `PeriodTagDialog`(详见 [docs/03-tagging.md §7](./03-tagging.md))
- 只读位置:`canDrop: false` + 工具条 disabled

Gallery 拖拽打标已实现 P0。

## 6. 排序行为

工具栏 Sort 控件在 List / Grid / Gallery / Kanban / Matrix / Calendar / Mapique 有效;TagCloud / KnowledgeGraph 不显 Sort 控件(避免 dead control)。

`compareEntries(a, b, sort)` 在 `DirectoryContentContextProvider` 内:

- **depth-blind**:不接收 `viewDepth`,深度 > 1 也按 basename(`a.name.localeCompare(b.name, …)`)
- 不存在"深度 > 1 改 path-based sort"或 `sortByPathHint` i18n 键 —— 该行为目前未实现
- size / modified / extension 语义不变

## 7. 内置上下文菜单(领域菜单)

每个视角有自己的 entry 右键菜单:

- `KanbanEntryMenu` —— Task / Kanban 专用
- `MatrixEntryMenu` —— Matrix 专用
- `GanttEntryMenu` —— Gantt 专用
- `CalendarEntryMenu` —— Calendar 专用;Calendar 条目**单击 = 选中、双击 = 打开**(2026-07-22,与其它视角一致;此前单击即打开,无法选中/拖拽)
- `MapiqueView` 内嵌 marker / tray 菜单(2026-07-22 起含 **Delete** 项,置底 + canEdit 门控,与其它领域菜单一致)
- Gallery 瓦片右键走**通用 EntryContextMenu**(2026-07-22 起;此前瓦片不处理 contextmenu,事件冒泡成"空白区菜单")
- 目录树节点 + 位置条目用不同的菜单(不与 entry 菜单共用)
- 通用 `EntryContextMenu` 共用基础项

## 8. 已知取舍

- 列宽可拖发现性差(默认透明 6px 热区);后续可加常驻分隔线
- Mapique / TagCloud / KG 的 `preferences` 仍走 `whale.<view>.<id>` localStorage(非 redux-persist)
- FolderViz 自带的 hidden / filter 等局部状态不受全局 viewDepth 影响
- 9 视角共用 `sort.key + sort.order`,但 TagCloud / KG 无 sort UI

## 9. 历史与取舍存档

> 本节只留结论；过程、测试清单与当时的参数都在 git 历史与共置测试里。

- **Gantt P0/P1 已完成**：泳道、视觉状态、空态、键盘导航、双筛选器、快捷区间、PNG 导出都已实现并收进 §2c；柱色改为 tag 派生后固定（早期 tag 派生方案的撤销结论同见 §2c）。**P2 整体搁置**（依赖箭头 / 里程碑节点 / 撤销重做 / 资源泳道分组 / 打印视图），未立项。
- **Mapique 地名搜索（geocoding）已尝试并回退（2026-07-17）**：曾统一走 Nominatim（OSM），国内网络超时导致搜索请求挂住、下拉框永不弹出，已 revert。**不要照原样重试**；根因是瓦片用高德（`autonavi.com`，国内通、免 key）而 geocoding 用 OSM（国内不通），服务体系不一致。若以后要做，走高德 geocoding（`restapi.amap.com`，GCJ-02，需一个免费 web key + 设置项）。
- **重做 geocoding 时的硬约束**：必须走 main 进程 IPC（renderer fetch 外部域撞 CSP，且 Nominatim 类服务要求自定义 `User-Agent`）；输入防抖；限频合规；结果统一过 `toDisplay`/`fromDisplay` 再定位（内部与存储统一 WGS-84，GCJ-02 只在 gaode 显示层）。
- **相关现状（仍成立）**：`mapProvider` 只有 `'gaode' | 'osm'`（默认 gaode），无 baidu/google；组件内没有 `flyTo`（只有 `FitBounds`）；`nameQuery` 是文件名筛选，不是地名搜索。
