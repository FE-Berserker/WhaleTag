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
| `folderviz` | active | FolderVizView | 4 图:tree / radial / treemap / sunburst(递归结构,直接调 `listDirectoryRecursive`) |
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
- **Triage drop** = `onRemoveEntryDateTag(entry)`(清 period)
- **底部 Triage** 沿用 Matrix `UntaggedTray` 模式(**常显**,2026-07-22:空了显示 `ganttTriageEmpty` 提示而不消失,保留"拖回取消排期"的放置目标)

## 3. 共享渲染三件套

[src/renderer/components/perspective/](../src/renderer/components/perspective/):

- `LoadingOverlay` —— 加载中半透明遮罩
- `EmptyHint` —— 空态提示
- `ErrorBanner` —— 错误展示

**实际只在 3 个视角**用:`KnowledgeGraphView` / `MapiqueView` / `TagCloudView`。

其他视角各自实现 loading/empty 状态(Gallery / Kanban / Matrix / Gantt / Calendar / Task / FolderViz)。

## 4. 全局递归深度 `viewDepth`

**所有 9 个有效视角受 `viewDepth ∈ [1, 5]` 控制**,默认 1(等同"只看当前目录")。`settings.viewDepth` 走 redux-persist,**全局不 per-folder**。

- 深度 1 = 当前目录(等同历史行为)
- 深度 5 = 递归纳入 5 层子目录文件;`MAX_RECURSIVE_ENTRIES = 10000` 截断

**实现层**:由 [DirectoryContentContextProvider](../src/renderer/hooks/DirectoryContentContextProvider.tsx) 处理,**单一数据源**;所有视角从 context 拿全部所需数据。Map 全部以 **`entry.path` 为 key**(`tagsByName.get(e.name)` 改成 `tagsByName.get(e.path)`,修复同名跨目录文件互不污染)。

**工具栏**深度 Slider(70px,无 marks,1–5):`FileToolbar.tsx` 直接 dispatch `setViewDepth`(无 marks、`valueLabelDisplay="auto"`、70px);**200ms 防抖在 `DirectoryContentContextProvider` 内**(`useEffect` + `setTimeout` 守卫 `debouncedDepth`),拖动 1→5 只触发 1 次递归 IPC。

`FileToolbar` 顶部全局入口,各视图自带深度滑块已删除(原 TagCloud / KG / Mapique 各自维护的 `whale.<view>.<id>.maxDepth` 已清理)。

**FolderViz 例外**:仍直接调 `ipcApi.listDirectoryRecursive`(`maxDepth` 来自全局 `viewDepth`),因为它需要嵌套树结构(`dirs + entries` 重建树)。`whale.folderViz.<id>` localStorage 只保 `vizType`,`hiddenFilesInFolders` / `filterMode` 视图局部状态不动。

## 5. 拖拽打标一致性

9 视角的拖拽打标行为统一:

- 从标签库 chip 拖到 entry(行 / 卡片 / tile / node / marker)→ 调 `onDropTag`
- 单文件 / 多选 / 文件夹三种落点都支持
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

## 9. Gantt 测试与工程债索引

> 2026-07-05 立项的 Gantt P0(泳道 / 视觉状态 / 空态 / 键盘 / 双筛选器)+ P1(快捷区间、PNG 导出)已于 2026-07-05/06 全部实现,行为细节收进 §2c;tag 派生柱色方案撤销(结论见 §2c「柱颜色」)。P2(依赖箭头 / 里程碑节点 / 撤销重做 / 资源泳道分组 / 打印视图)整体搁置,未立项。

**测试覆盖**:

- [src/renderer/domain/gantt.test.ts](../src/renderer/domain/gantt.test.ts):`groupRowsByWorkflow` 4 个单测(203-262)+ `periodStatus` 边界 case(`overdue` / `inProgress` / `normal` 及包含边界)
- [src/renderer/components/GanttView.test.tsx](../src/renderer/components/GanttView.test.tsx):`#18 swim lanes` 4 case(按 stages 排序 + 分隔线数 = lane 数 - 1 / 单 lane 不分隔 / `stages=[]` 不分隔)、`#6.5 quick-range presets` 5 case(渲染 4 按钮 / 持久化 / 清除 / 跨度变化 / hydrate)、`#19 PNG export toolbar` 4 case(3 按钮 testid / inner chart-content 存在 / 空态不渲染 / 初始 enabled)
- [useGanttKeyboardNavigation.test.tsx](../src/renderer/components/gantt/useGanttKeyboardNavigation.test.tsx):14 case(5 键 × 2 路径 + wrap-around + readOnly + modifier guards + tabIndex 派生 + 空 paths 安全)
- [useGanttTagFilter.test.tsx](../src/renderer/components/gantt/useGanttTagFilter.test.tsx):23 case(默认值 / toggle / setAll / 持久化 round-trip / auto-include / passes 边界 / tag-less 中性 vs narrow / 中文 tag 值匹配与持久化)
- [GanttEntryMenu.test.tsx](../src/renderer/components/GanttEntryMenu.test.tsx):2 case("disables write sections when hasFilteredSource is true" / "leaves Open enabled even when hasFilteredSource is true")
- [useGanttRange.test.ts](../src/renderer/components/gantt/useGanttRange.test.ts):8 case(`ganttRangeToBounds` 跨度 / 中心点 + hook 默认值 / 持久化 hydrate / sanitize / 选择 / 清除)
- [useBarDrag.test.tsx](../src/renderer/components/gantt/useBarDrag.test.tsx):8 用例,覆盖 3 态转换(click path、drag→commit 算术、Escape 取消、readOnly 拦截、非左键 / 修饰键、sub-day no-commit)

**顺手补的工程债**:

- `GanttEntryMenu` 文案脱钩 Kanban:[GanttEntryMenu.tsx](../src/renderer/components/GanttEntryMenu.tsx) 改用独立 `ganttMoveToStage` / `ganttSetPriority` / `ganttSetPeriod` / `ganttClearPeriod` / `ganttEditTags` 5 个 key(en/zh/zh-TW/ja/ko 各 5);Matrix 仍用 kanban key(文案同,未列入脱钩范围)
- i18n 新增 key 总清单(en/zh 各一份,[locales](../src/renderer/locales/)):`ganttNoTasksHint` / `ganttOverdue` / `ganttInProgress` / `ganttFilterWorkflow` / `ganttFilterPriority` / `ganttFilterClear` / `ganttFilteredEmpty` / `ganttResetFilters` / `ganttFilterLaneHidden` / `ganttShortcut1w` / `ganttShortcut2w` / `ganttShortcut1m` / `ganttShortcut1q` / `ganttRangeLabel` / `ganttExportFail` / `ganttExportCopied` / `ganttExportCopiedAsBase64`

---

## 10. Mapique 地名搜索(geocoding)— ⚠️ 已尝试并回退(2026-07-17)

> **不要照原样重试 Nominatim 方案。** 曾按「两种 mapProvider 统一用 Nominatim」落地(commits `f3e97e0` 等),但**国内网络 Nominatim(`nominatim.openstreetmap.org`)被墙/超时**——搜索请求挂住、结果下拉框永不弹出,功能完全不可用,已 revert(commit `128c810`,−419 行)。
>
> **根因**:地图瓦片用高德(`autonavi.com`,国内通、免 key),geocoding 却用 Nominatim(OSM,国内不通)——服务体系不一致。当初选 Nominatim 是为免 key,忽略了国内可达性。
>
> **若以后要做**:① 高德 geocoding(`restapi.amap.com`,国内通、与高德瓦片同坐标系 GCJ-02),但要一个免费 web key + 设置项;② 或**走 AI 助手**——让 AI 处理「找天安门、定位过去」这类自然语言地名查询,免 key、免自接 geocoder。

### 10.1 相关现状(与搜索功能无关,仍然成立)

- **mapProvider**:二元 `'gaode' | 'osm'`([settings.ts:46](../src/renderer/reducers/settings.ts#L46)),默认 `'gaode'`。**无 baidu/google**。
- **tile**:二元 if/else([MapiqueView.tsx:226-229](../src/renderer/components/MapiqueView.tsx#L226)),gaode = GCJ-02(`webrd0{1-4}.is.autonavi.com`),osm = WGS-84(`tile.openstreetmap.org`)。
- **坐标系**:内部/存储统一 **WGS-84**;GCJ-02 只在 gaode 显示层。`toDisplay`(WGS-84→显示)/ `fromDisplay`(显示→WGS-84)是组件内闭包,调 [src/renderer/domain/gcj02.ts](../src/renderer/domain/gcj02.ts)。
- **flyTo**:**无现成 flyTo/setView**(只有 `FitBounds`)。**nameQuery** 是文件名搜索(detail panel 文件筛选),**非地名**,不能复用。

### 10.2 回退实现留下的约束(重做时须遵守)

- **geocoding 必走 main 进程 IPC**,不走 renderer:(a) renderer fetch 外部域撞 CSP;(b) Nominatim 类服务强制自定义 `User-Agent`(浏览器 fetch 设不了)。当时通道为 `mapique:geocode` + `mapiqueGeocode(query): Promise<{ results: Array<{ name, lat, lng }> }>`(WGS-84),已随 revert 删除,可照此重建。
- **坐标系无需转换**:Nominatim 返 WGS-84 = 内部系,结果统一过 `toDisplay(lat,lng)` 再定位,与 marker 放置同链路不会错位(gaode 模式内部转 GCJ-02 显示,osm 模式恒等)。
- **限频合规**:Nominatim 限 1 req/s、需有效 UA、尊重结果 license;搜索输入须防抖(当时 400ms)。当时请求参数:`format=jsonv2&limit=5&countrycodes=cn&accept-language=zh`。
- 当时 UI 形态(可参考):搜索框绝对定位于地图左上(`top:8; left:8; zIndex:1000`)+ 结果下拉;选中后由 `FlyTo` 子组件(参考 `FitBounds` 的 useMap 模板)调 `map.flyTo(toDisplay(...), zoom)`。反向 geocoding、搜索历史 / 收藏地点当时明确不做。
