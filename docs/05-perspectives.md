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
| `knowledge-graph` | active | KnowledgeGraphView | xyflow(react-flow v12)标签↔文件二部图 |
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

### 2b. Matrix

Eisenhower 2×2 四象限 + 底部未分类托盘:

- 卡片拖拽到不同象限写互斥 quadrant 智能标签
- 卡片右键:`MatrixEntryMenu`(同 KanbanEntryMenu 三段式,只是 "Move to stage" 那一段的工作流值从 props 传入)

### 2c. Gantt(`Tasks §3.3`)

**技术栈**:**纯 DOM**(无 ECharts,无 dataZoom)。放弃 ECharts 的原因:

- 每个 `mouseup`/`mouseout` 触发 `CustomSeriesModel.getDataParams`,第一句读 `dataIndex.getRawIndex()`;自定义子元素无 data hookup 时 `dataIndex` 是 undefined → 抛错
- 故旧版本被替换为 `GanttTimeline` 子组件 + `useBarDrag` hook,DOM 节点直接挂载

主要机制:

- **缩放方式**:**浏览器原生水平滚动**(无 dataZoom 滑块)
- **缩放档位**:工具栏 `Select`(Day / Week / Month),`useGanttZoom` hook,持久化 `whale-task-gantt-zoom` localStorage
- **快捷区间**(P1 #8,2026-07-06):工具栏 `ToggleButtonGroup`(`1w / 2w / 1m / 1q`),`useGanttRange` hook,持久化 `whale-task-gantt-range` localStorage;选中时以今天为中心固定跨度,未选中时回退到自然任务区间
- **拖拽改时间**:整体平移 + 左右边缘 resize(`useBarDrag` hook,2026-07-05 修过 pending→dragging 转换的真实 bug)
- **键盘导航**(P0 #4,2026-07-05):`useGanttKeyboardNavigation` 持有 focus state + scroller-level keydown;`↑↓ ← →` / Space / T / Esc;只有 focused bar 可 tab;focus ring 用 `outline + box-shadow` 高对比度
- **泳道分组**(P0 #1,2026-07-05):按 workflow stage 分组,每 lane 第一行上方有 stage label chip;无 stage 的行落入“未分类”lane
- **筛选器**(P0 #5/#6,2026-07-05):工具栏两个多选 `Select`(workflow / quadrant),默认全选;未选中的行 `opacity: 0.3` + `pointer-events: none`
- **PNG 导出**(P1 #9,2026-07-06):工具栏 save / save-as / copy-to-clipboard 三按钮,复用 `useImageExport` + `modern-screenshot`,捕获 inner chart-content Box;失败时 tooltip 切 `ganttExportFail`,复制成功弹 Snackbar `ganttExportCopied` / 文本回退 `ganttExportCopiedAsBase64`
- **视觉状态**(P0 #2,2026-07-05):`GanttBar` 根据 `periodStatus(period, todayKey)` 分三种状态;`overdue` 柱加红色描边(`outline: 2px solid #ef4444`);`inProgress` 柱左侧加绿色 `PlayArrowIcon` 角标 + `ganttInProgress` tooltip;正常柱无额外装饰
- **空态引导**(P0 #3,2026-07-05):无 scheduled 且 Triage 非空时,空态文案显示 `ganttNoTasksHint`(“把 Triage 卡片拖到时间轴任意一天开始排期”);Triage 托盘首次出现时有 3 秒一次性呼吸描边(`@keyframes whale-gantt-breath`),标志位存 `sessionStorage`
- **数据源** = period 标签(`YYYYMMDD-YYYYMMDD`),**不发明新元数据**
- **Triage drop** = `onRemoveEntryDateTag(entry)`(清 period)
- **底部 Triage** 沿用 Matrix `UntaggedTray` 模式

P0 已完整实现;后续 P1/P2 扩展点见 [§9 Gantt 扩展点(roadmap)](#9-gantt-扩展点roadmap)。

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
- `CalendarEntryMenu` —— Calendar 专用
- `MapiqueView` 内嵌 marker / tray 菜单
- 目录树节点 + 位置条目用不同的菜单(不与 entry 菜单共用)
- 通用 `EntryContextMenu` 共用基础项

## 8. 已知取舍

- Sort 在 TagCloud / KG 是 dead control(无效果),已不在工具栏渲染
- 列宽可拖发现性差(默认透明 6px 热区);后续可加常驻分隔线
- Mapique / TagCloud / KG 的 `preferences` 仍走 `whale.<view>.<id>` localStorage(非 redux-persist)
- FolderViz 自带的 hidden / filter 等局部状态不受全局 viewDepth 影响
- 9 视角共用 `sort.key + sort.order`,但 TagCloud / KG 无 sort UI
- Gantt 子视图既不 ECharts 也不 dataZoom;若日后需要性能更高的虚拟化,再加

## 9. Gantt 扩展点(roadmap)

> 来源:2026-07-05 与用户讨论立项。实现时按 **P0 → P1** 顺序推进,每项完工同步更新本文(把对应小节的状态从 `🟡 待实现` 改成 `✅ 已实现,commit=…`,并把细节收进 §2c)。
>
> **P2 整体搁置**:依赖箭头 / 里程碑节点 / 撤销重做 / 资源泳道分组 / 打印视图 —— 等下一轮讨论再立项,**此处不展开**。

### 9.1 P0(2-3 天可落地,共 6 项)

#### #1 接 swim lanes — 沿用现有 `groupRowsByWorkflow` ✅ 已实现,2026-07-05

- [src/shared/gantt.ts:248-290](../src/shared/gantt.ts) 已实现完整 helper(按 stage 分泳道 + 排序 + 末尾 `no stage` 行);[src/shared/gantt.test.ts:203-262](../src/shared/gantt.test.ts) 有 4 个单测
- 接线方式:`GanttTimeline` 内部用 `groupRowsByWorkflow` 把 `scheduled` 拍平到 lane 数组,每条 lane 单独过滤,过滤后为空的 lane 折叠成占位
- 改动:
  - `GanttTimeline` 新增 `stages: WorkflowStage[]` + `tagsByName: Map<string, string[]>` props;内部派生 `swimLanes` / `displayRows`(flat 化 + 每行带 laneIndex)/ `laneBoundaryIndices` / `hiddenLaneCount`
  - 行间分隔线 + **stage label chip + 名称**(2026-07-05 UX 修订:纯分隔线看不出是哪个 stage;现在每个 lane 的第一行上方都有 18px 高的水平条,左侧 stage 颜色圆点 + stage 本地化名(`tagDisplayLabel`),`data-testid="gantt-lane-divider-<laneIndex>"` + `data-testid="gantt-lane-chip-<laneIndex>"`;无 stage 行用 `t('ganttNoStageLane')` = "未分类" —— **每个 lane 都画 header**(包括第一个,2026-07-05 fix:之前只在 laneIndex 变化处画,导致第一个 lane 没标记)
  - 行底色取自 stage 色(`getTagColor(stageValue, tagColors, groups)`)→ 10% alpha 混入背景(`#XXXXXX1A`)
  - **日期 tick 行层级修复(2026-07-06)**:lane header(`zIndex: 2`) 的 top 定位会侵入 tick 行底部,导致日期被遮挡;将 tick 行 `zIndex` 从 1 提升到 3,确保日期始终在最上层
  - 整 lane 全被过滤时:`<Box data-testid="gantt-hidden-lane-placeholder">` 显示 "已隐藏 N 个阶段"(`t('ganttLaneHidden', { count })`),绝对定位在最后一行下方
  - `GanttRow` 新增 `laneTintColor?: string` prop,只改 `bgcolor`,不动 `colorFor`(bar 色独立,见 §9.4)
  - `GanttView` 把 `stages` + `tagsByName` 透传给 `GanttTimeline`
- 边界:
  - `stages = []` → 全部行落入唯一 "no stage" lane,无分隔线(back-compat)
  - 单 lane → 无分隔线
  - 仅 1 行 → 走原 vertical windowing slice
- 测试覆盖:[src/renderer/components/GanttView.test.tsx](../src/renderer/components/GanttView.test.tsx) `#18 swim lanes (P0 #1)` 4 个 case(按 stages 排序 + 分隔线数 = lane 数 - 1 / 单 lane 不分隔 / `stages=[]` 不分隔)
- 影响面:GanttTimeline(~120 行新增 / 改动)+ GanttRow(~10 行)+ GanttView(透传 2 个 prop)+ i18n en/zh 各加 1 key,共约 150 行

#### #2 过期 / 今天视觉强化 ✅ 已实现,2026-07-05

- 状态分类由 `shared/gantt.ts:periodStatus(period, todayKey)` 统一计算,返回 `overdue | inProgress | normal`
- `overdue`(`endKey < today`):柱加红色描边 `outline: 2px solid #ef4444; outlineOffset: 1px`,用 `outline` 而不用 `border` 是为了不撑开内容盒(避免 drag 数学依赖的 `width` 被吃掉)
- `inProgress`(`startKey ≤ today ≤ endKey`):柱左侧加绿色圆形角标(`PlayArrowIcon`,14×14 px,`pointer-events: none`),tooltip 显示 `ganttInProgress`
- today 竖线已存在,不动
- 测试覆盖:[src/shared/gantt.test.ts](../src/shared/gantt.test.ts) 有 `periodStatus` 边界 case(`overdue` / `inProgress` / `normal` 及包含边界)
- 影响面:`GanttBar` 加状态分支 + `shared/gantt.ts` 加 `periodStatus` helper + i18n 2 key(`ganttOverdue` / `ganttInProgress`),约 50 行

#### #3 空态引导文案 ✅ 已实现,2026-07-05

- 无 scheduled 且 Triage 非空时,空态从裸 `ganttNoTasks` 改为显示 `ganttNoTasksHint`(“把 Triage 卡片拖到时间轴任意一天开始排期”)
- Triage 托盘首次出现时加一次性(每会话)呼吸描边提示,3 秒后淡出(`keyframes whale-gantt-breath` 1.2s × 3 次),标志位存 `sessionStorage['whale-gantt-triage-hint-shown']`
- 触发条件重新进入空态+有 Triage 时会再次提示(例如用户清空排期后切走再切回)
- 影响面:`GanttView.tsx` 文案 + CSS keyframes + `sessionStorage` 读写,约 30 行

#### #4 键盘导航 ✅ 已实现,2026-07-05

- Tab 进 Gantt 后:
  - `↑↓` 切柱(垂直方向,跨 swim lane,环回)
  - `← →` 移柱 ±1 天(走 `onCommit` 路径,落持久化 = 同拖拽行为)
  - `Space` 弹 PeriodTagDialog(复用 click 路径)
  - `T` 跳到 today(等价工具栏 Today 按钮)
  - `Esc` 清空 focus
- ~~`Shift+← →` 调整长度~~ — **不在 P0 范围**(2026-07-05 砍掉,理由:长度调整语义上需要双轴反馈,跟单轴 ±1 天的移动混在同一个 hook 里会让 state machine 复杂化,先用 §9 #4 验证键盘交互通路)
- 焦点状态由新 hook [src/renderer/components/gantt/useGanttKeyboardNavigation.ts](../src/renderer/components/gantt/useGanttKeyboardNavigation.ts) 持有:`focusedPath` + `tabIndexFor` + `onKeyDown`
- 每个 bar `<div tabIndex={tabIndexFor(path)}>` + `data-focused={focused ? 'true' : undefined}`,只有 focused 的 bar 可 tab,其余 `tabIndex={-1}` 跳过
- focus ring:`outline: 2px solid #1976d2; outline-offset: 2px; box-shadow: 0 0 0 4px rgba(25,118,210,0.25)`(高对比度 + 微光晕,28px 高度的 bar 上能看清,Chrome 默认 1px dotted 不够)
- scroller 自身 `tabIndex={-1}` + `outline: none`,承载 keydown handler(集中处理避免 per-bar listener thrash)
- Ctrl/Meta/Alt + 任意键 → no-op(不抢浏览器快捷键)
- readOnly:焦点仍可移动(无障碍导航不被阻塞),但 ← → / Space / commit 全部跳过
- 测试覆盖:[src/renderer/components/gantt/useGanttKeyboardNavigation.test.tsx](../src/renderer/components/gantt/useGanttKeyboardNavigation.test.tsx)(14 case:5 个键 × 2 路径 + wrap-around + readOnly + modifier guards + tabIndex 派生 + 空 paths 安全)
- 影响面:useGanttKeyboardNavigation(~120 行新) + GanttBar(加 3 prop + focus ring + tabIndex) + GanttRow(透传 3 prop) + GanttTimeline(hook 接线 + scroller onKeyDown + 复用具名 today's jumpToToday) + GanttView(传 onJumpToToday),共 ~150 行

#### #5 工作流筛选器(对应 Kanban 视图) ✅ 已实现,2026-07-05

- 工具栏 `Select`,**多选** workflow 阶段(默认全选)
- 未选中的阶段 → 行 `opacity: 0.3` + `pointer-events: none`(drag / 双击 / 右键全部不响应)
- 状态:localStorage `whale-task-gantt-filter`,shape `{ workflow: string[]; quadrant: string[] }`,per-字段独立
- 新 hook:[src/renderer/components/gantt/useGanttTagFilter.ts](../src/renderer/components/gantt/useGanttTagFilter.ts),generic over `T extends string`,两个筛选器共用
- **关键的 `passes` 语义**(用户 2026-07-05 提出修订):
  - **有已知 tag 的行**:该 tag 必须出现在 `selected` 中 → 通过
  - **无相关 tag 的行**:仅当 `selected.size === knownValues.length`(用户没 narrow 过任何东西,处于"中性"状态)时通过。用户一旦 un-select 任何一个值,tag-less 行就立即被隐藏 —— 否则 "show me only in-progress" 会同时把"没在任何阶段"的行也露出来,违反筛选直觉
  - stale / 已删除的值(`knownValues` 不含的)被忽略,不参与匹配
- 实现要点:
  - 持久化时只写被改动的字段(`{ workflow: undefined, quadrant: [...], [key]: [...] }`),避免跨字段覆盖
  - `seenValuesRef` 区分"新出现的值"(auto-include)与"用户主动 un-select"(保持 un-selected),避免 `useEffect([knownValues])` 重渲染时把 un-selected 的值重新塞回去
- 测试覆盖:[src/renderer/components/gantt/useGanttTagFilter.test.tsx](../src/renderer/components/gantt/useGanttTagFilter.test.tsx)(23 cases:默认值 / toggle / setAll / 持久化 round-trip / auto-include / passes 边界 / **tag-less 在中性 vs narrow 状态** / **中文 tag 值匹配与持久化**)
- 影响面:新 hook + GanttView toolbar + GanttTimeline + GanttRow 改动,共约 200 行

#### #6 优先级筛选器(对应 Matrix 视图) ✅ 已实现,2026-07-05

- 工具栏 `Select`,**多选** quadrant(4 选 N),默认全选
- 与 #5 共用 `useGanttTagFilter<string>('quadrant', QUADRANT_VALUES)`,完全独立,交集生效
- 多选含过滤项时的菜单行为:`hasFilteredSource` prop 从 view 传入 menu,所有写动作(Move to stage / Set priority / Set period / Clear period / Delete / Edit tags)统一 `writesDisabled = readOnly || hasFilteredSource`;**Open 与 More actions 保持可用**(读 + 系统菜单自己有 gating)
- 多选 toggle 时用 `setAll` 一次写(避免对每个翻转值都触发一次 localStorage 写入)
- 测试覆盖:与 #5 共用 16 cases;菜单侧补 2 个 case [src/renderer/components/GanttEntryMenu.test.tsx](../src/renderer/components/GanttEntryMenu.test.tsx)("disables write sections when hasFilteredSource is true" / "leaves Open enabled even when hasFilteredSource is true")
- 影响面:复用 #5 的 hook + GanttView toolbar + GanttEntryMenu 加 1 个 prop + writesDisabled 派生,共约 80 行

**#5 + #6 联合空态**:所有 scheduled 行都被过滤时,toolbar 下方显示橙色 Alert `ganttFilteredEmpty` + "Reset" 按钮(`data-testid="gantt-filtered-empty"`)

### 9.2 P1(共 3 项,#8 已撤销)

#### #7 快捷区间 ✅ 已实现,2026-07-06

- 工具栏在 zoom Select 旁加 `1w / 2w / 1m / 1q` 预设按钮(`<ToggleButtonGroup>` 4 选 1,再次点击已选项清除 override)
- 新增 hook [src/renderer/components/gantt/useGanttRange.ts](../src/renderer/components/gantt/useGanttRange.ts):
  - `GanttRangePreset = '1w' | '2w' | '1m' | '1q'`
  - `ganttRangeToBounds(range, anchorKey=today)` 以锚点日期(默认今天)为中心生成 `[startKey, endKey]`
  - 持久化 `whale-task-gantt-range`,shape `{ range?: GanttRangePreset }`;清空时写 `{}`
  - 已做防御性 sanitize,非法 localStorage 值不会崩溃视图
- `GanttView` 的 `scale` 派生:range 存在时用 `ganttRangeToBounds(range)` 作为 `scaleForRange` 的边界;不存在时回退到自然任务区间
- 区间与 zoom 正交:range 控制可见跨度,zoom 控制 px-per-day
- 测试覆盖:
  - [src/renderer/components/gantt/useGanttRange.test.ts](../src/renderer/components/gantt/useGanttRange.test.ts)(8 cases:`ganttRangeToBounds` 跨度 / 中心点 + hook 默认值 / 持久化 hydrate / sanitize / 选择 / 清除)
  - [src/renderer/components/GanttView.test.tsx](../src/renderer/components/GanttView.test.tsx) `#6.5 quick-range presets (P1 #8)`(5 cases:渲染 4 按钮 / 持久化 / 清除 / 跨度变化 / hydrate)
- i18n 新增 `ganttRangeLabel`(按钮组 aria-label) + 已有 `ganttShortcut1w/2w/1m/1q`
- 影响面:`useGanttRange.ts`(新文件) + `GanttView.tsx`(hook 接入 + 工具栏 + scale 派生) + `GanttTimeline.tsx`(加 `data-testid="gantt-chart-content"` 便于测试) + i18n en/zh 各 1 key,共约 180 行

#### #8 自定义柱颜色(复用 `getTagColor`)❌ 撤销,2026-07-06

**撤销原因**:把柱色绑到 tag 上有两个问题,
1. **顺序脆弱**:`colorFor` 走"tags 数组里第一个有色的赢",而 tags 顺序由 sidecar JSON 的数组顺序决定(== 用户加标签的顺序)。同一个文件加完 `in-progress` 再加 `urgent-important` 跟反过来加,柱色不同。
2. **跨职责污染**:tag 的语义是"筛选 / 分类 / 找文件",跟"我要给这个 bar 上个色"是两件事。用户随手加一个无关 tag(比如 `archive`),只要它在数组前面,柱色就跳成 archive 的色。
3. **workflow tag 自相矛盾**:§9.4 当时写"lane 底色 = stage tag 色,柱色 = entry tag 派生色,两层独立",但 getTagColor 对 workflow tag 返回的就是 stage tag 同色 —— 两层完全相同。

**结论与最终状态**(2026-07-06):`colorFor` 退回固定 fallback 蓝 `#3b82f6`,**不读任何 tag**。曾短暂立项的 #10(独立 override + 右键菜单)同日被撤,认为"价值不大"。bar 颜色在 Gantt 中是个弱信息维度,不值得单独立项 —— 真要传 status,靠 P0 #2 的 overdue/inProgress 描边/角标,更明确。

**代码现状**:`colorFor: (entry: DirEntry) => string` 签名保留(`_entry` 参数不读),`GanttRow` / `GanttTimeline` 的调用点不动。若未来真要复活 bar 独立颜色,签名不用改,只换 body。

#### #9 导出 PNG(复用 Calendar 已有的导出)✅ 已实现,2026-07-06

- 工具栏加 **3 个 IconButton**(save / save-as / copy-to-clipboard),紧挨 reset 按钮右侧;`CalendarView` 用 `modern-screenshot` 已有的导出集群同款
- 复用既有 `useImageExport` hook([src/renderer/hooks/useImageExport.ts](../src/renderer/hooks/useImageExport.ts),Calendar / TagCloud / KG 已用):capture → base64 PNG → `ipcApi.writeBinaryFile`(save / save-as)/ `navigator.clipboard.write`(copy)
- 捕获目标 = **inner chart-content Box**(`data-testid="gantt-chart-content"`,scroller 内的 `<Box ref={exportRef}>`),不抓 scroller 本身(避免把 scrollbar 烤进图)
- `dynamic import('modern-screenshot')`:跟 test bundle 解耦,只在用户点击导出时加载
- 3 个 IPC handler 路径已经过 hook,无须新增:`writeBinaryFile` / `saveImageDialog` / 现有 clipboard API
- 复制时走 `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`,失败回退 `writeText(data:image/png;base64,...)` → 弹 Snackbar 区分 `ganttExportCopied` / `ganttExportCopiedAsBase64`(镜像 CalendarView 的 notice pattern)
- 保存失败时 tooltip 切到 `ganttExportFail`(同 CalendarView 模式)
- 空 Gantt(`scheduled.length === 0`)不渲染 chart-content Box → capture 返回 null → `useImageExport` 抛 "Failed to capture image" → tooltip 显示 `ganttExportFail`
- 测试覆盖:[src/renderer/components/GanttView.test.tsx](../src/renderer/components/GanttView.test.tsx) `#19 PNG export toolbar (P1 #9)` 4 case(3 个按钮 testid / inner chart-content 存在 / 空态不渲染 / 初始 enabled)
- i18n 新增 `ganttExportFail` / `ganttExportCopied` / `ganttExportCopiedAsBase64`(en/zh 各 3 key)
- 影响面:`GanttView.tsx`(~50 行:`exportRef` + `capture` + 3 个 IconButton + Snackbar + i18n)+ `GanttTimeline.tsx`(`exportRef` prop + inner Box `ref`,~10 行)+ i18n en/zh 各 3 key + 测试 ~50 行

### 9.3 顺手补的工程债(跟着 P0 一起改,不单独占坑)

| 项 | 说明 | 工作量 |
|---|---|---|
| **GanttEntryMenu 文案脱钩 Kanban** | 当前 [src/renderer/components/GanttEntryMenu.tsx](../src/renderer/components/GanttEntryMenu.tsx) 用了 `kanbanMoveToStage` / `kanbanSetPriority` / `kanbanSetPeriod` / `kanbanClearPeriod` / `kanbanEditTags` 5 个 Kanban 复用 key。语义本来就不同(Matrix 有 priority,Kanban 是 workflow;Gantt 两者都要),补独立 `ganttMoveToStage` / `ganttSetPriority` / `ganttSetPeriod` / `ganttClearPeriod` / `ganttEditTags` | i18n en/zh 各加 5 key + GanttEntryMenu 5 处替换,~30 行 |
| **`useBarDrag` 状态机单测** | 388 行的 hook 一个测试没有。3 态转换(threshold 边界 / Escape / commit 时机)必须先补再上 P0 #4 键盘扩展 | 新增 `useBarDrag.test.ts`,~150 行 |
| **新 i18n key 同步** | 一次性补齐本节所有新 key:`ganttNoTasksHint` / `ganttOverdue` / `ganttInProgress` / `ganttFilterWorkflow` / `ganttFilterPriority` / `ganttFilterClear` / `ganttFilteredEmpty` / `ganttResetFilters` / `ganttFilterLaneHidden` / `ganttShortcut1w` / `ganttShortcut2w` / `ganttShortcut1m` / `ganttShortcut1q` / `ganttExportFail` / `ganttExportCopied` / `ganttExportCopiedAsBase64` | ~16 key × 2 locale |

### 9.4 已敲定决策

| 问题 | 决策 |
|---|---|
| P0 #5/#6 "未选阶段 → 行淡化"具体怎么淡? | `opacity: 0.3` + 不可点击(同时禁用右键菜单的写动作);比直接 `display: none` 保留空间感 |
| P0 #5/#6 "tag-less 行(既无 workflow 也无 quadrant 的行)"该怎么处理? | **中性状态(全选)下可见,narrow 状态下隐藏**(2026-07-05 用户提出修订)。理由:用户 narrow 筛选时的语义是"给我看匹配 X 的行",不是"给我看匹配 X 的行 + 没标签的行" |
| P0 #5/#6 下拉菜单项显示文本怎么本地化? | **用 `tagDisplayLabel(value, t)` 包一层**(2026-07-05 用户提出修订)。直接 `{value}` 会显示原始英文 token(`not-started` / `urgent-important`),中文环境下违反 UI 一致性;`tagDisplayLabel` 经 smart-tags functionality 映射到 i18n 模板(`smartTagWorkflowInProgress` / `smartTagQuadrantUrgentImportant`),与 Kanban/Matrix 列头 / GanttEntryMenu 子菜单的显示语义保持一致 |
| P0 #4 键盘选中态要不要有 visible focus ring? | 要。无障碍是底线,a11y 标准要求可见焦点指示 |
| P0 #1 swim lane 色 vs Gantt bar 色冲突吗? | **不冲突**:lane 整行底色 = stage tag 色(`stageColors.get(stageValue)` × 10% alpha);bar 固定 fallback 蓝 `#3b82f6`(tag-派生链 2026-07-06 撤销,bar 不与 tag 耦合)。**两层解耦** —— 用户后续若想给 bar 加独立颜色,另立 item,不从这里复活 |
| P0 #5/#6 状态保存位置? | localStorage `whale-task-gantt-filter`(per-字段:workflow / quadrant),不走 redux |
| P0 #5/#6 默认值? | 全选(等同"不过滤")—— 不破坏老用户路径 |
| P0 #3 呼吸提示是每次进入 Gantt 都来一次吗? | 否,每会话一次(`sessionStorage` 标志位);防止重复提示让用户烦 |

### 9.5 后续每项完工的更新流程

实现完任何一项后:

1. 把对应小节标题的 🟡 改成 ✅ `已实现,commit=<sha>`
2. 把"改动"清单与"影响面"的最终数字收敛进 §2c Gantt 章节的对应位置
3. 在共享层 / hook 实现的项,在 [src/shared/gantt.test.ts](../src/shared/gantt.test.ts) 或新 test 文件里补测试覆盖
4. 新增 i18n key 同步 en/zh 两份 [src/renderer/locales/{en,zh}/common.json](../src/renderer/locales/)
5. 一次性把这节最后更新于 `<YYYY-MM-DD>` 标在文头

---

## 10. Mapique 地名搜索(geocoding)— 实现计划

> 目标:mapique 地图视图加地名搜索(输入「北京天安门」→ 查坐标 → 地图 flyTo 定位 + 结果列表选)。本节是实现设计,review 后落地。

> **决策(2026-07-11):B 方案** —— 不配高德 key,两种 mapProvider **统一用 Nominatim**(免费、无需 key)。代价:国内地址偏弱、英文/拼音友好。坐标系:Nominatim 返 WGS-84 → `toDisplay`(gaode 模式转 GCJ-02 显示,与 marker 放置同链路)。

### 10.1 现状摸底(已确认)

- **mapProvider**:二元 `'gaode' | 'osm'`([settings.ts:46](../src/renderer/reducers/settings.ts#L46)),默认 `'gaode'`。**无 baidu/google**。
- **tile**:二元 if/else([MapiqueView.tsx:226-229](../src/renderer/components/MapiqueView.tsx#L226)),gaode = GCJ-02(`webrd0{1-4}.is.autonavi.com`),osm = WGS-84(`tile.openstreetmap.org`)。
- **坐标系**:内部/存储统一 **WGS-84**;GCJ-02 只在 gaode 显示层。`toDisplay`(WGS-84→显示,233)/ `fromDisplay`(显示→WGS-84,241)是组件内闭包,调 [src/shared/gcj02.ts](../src/shared/gcj02.ts)。
- **flyTo**:**无现成 flyTo/setView**(只有 `FitBounds` 1627)。需加 `FlyTo` 子组件(同款 useMap 模板)。
- **nameQuery**(203):文件名搜索(detail panel 文件筛选),**非地名**,不能复用。

### 10.2 geocoding(B 方案:统一 Nominatim)

不分 mapProvider,两种模式都走 Nominatim:

| 项 | 值 |
|---|---|
| API | `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=cn&accept-language=zh&q=<query>` |
| 返回坐标系 | **WGS-84**(内部系,直接用) |
| key | 无需 |
| 限制 | 需自定义 `User-Agent`(浏览器 fetch 设不了 → 必走 main 进程)+ 限频 1 req/s |

### 10.3 坐标系(B 简化)

Nominatim 返 **WGS-84**(= 内部系),**无需任何转换**就能喂给 `toDisplay`:

- gaode 模式:`toDisplay(wgs)` 内部 `wgs84ToGcj02` → GCJ-02 显示坐标 → flyTo(和 marker 放置同链路,不会错位)
- osm 模式:`toDisplay(wgs)` 恒等 → 直接 flyTo

→ geocoding 结果统一 `toDisplay(lat,lng)` 后用,与 marker 放置一致。

### 10.4 实现步骤(文件改动)

1. **IPC 层([src/main](../src/main))**:加 `mapique:geocode` channel,主进程用 `net`/`fetch` 调 Nominatim(带自定义 `User-Agent: WhaleTag/<version>`)。**走 main 不走 renderer**:(a) renderer fetch 外部域撞 CSP;(b) Nominatim 强制 UA,浏览器 fetch 设不了。入参 `{ query }` → 返 `{ results: Array<{ name, lat, lng }> }`(WGS-84)。
2. **[MapiqueView.tsx](../src/renderer/components/MapiqueView.tsx)**:
   - 搜索框 UI:`mapWrapperRef` Box(1017)内、MapContainer 后、EmptyHint 前,`position:absolute; top:8; left:8; zIndex:1000`,TextField + 结果下拉。复用已 import 的 `SearchIcon`/`TextField`/`InputAdornment`/`ClearIcon`。
   - `FlyTo` 子组件(参考 `FitBounds` 1627-1647):props `{ target: {lat,lng,zoom}, nonce }`,`useEffect` 检 nonce 变化调 `map.flyTo([toDisplay(lat,lng)], zoom)`。放 MapContainer 内(1031)。
   - 流程:输入(防抖 400ms)→ `ipcApi.mapiqueGeocode(query)` → 结果下拉 → 选结果 → `setFlyToTarget` + nonce++。
3. **preload + [ipc-types](../src/shared/ipc-types.ts) + [ipc-api](../src/renderer/services/ipc-api.ts)**:加 `mapiqueGeocode(query: string): Promise<{ results: GeoSearchResult[] }>` invoke 通道。
4. **i18n**([en/zh common.json](../src/renderer/locales/)):搜索框 placeholder(「搜索地名…」)/ 无结果 / 加载中。

### 10.5 风险 / 注意

- **CSP**:geocoding 必走 main IPC(renderer fetch 撞 CSP + Nominatim UA)。
- **Nominatim 合规**:1 req/s、有效 UA、`countrycodes=cn` + `limit=5` + `accept-language=zh`、尊重结果 license。
- **限频防抖**:搜索输入防抖 400ms,避免打字每键一请求(Nominatim 限频严格)。
- **国内地址弱**:Nominatim 国内 POI 覆盖不如高德;后续若需国内准,可加高德 key 升级(回到 A 方案,接口已在 main IPC 层好扩展)。
- **坐标系**:见 §10.3。

### 10.6 不在本期

- 反向 geocoding(点地图 → 地名)—— marker 已有坐标,非必需。
- 搜索历史 / 收藏地点 —— 可后加(localStorage)。
- 高德 geocoding(A 方案)/ 百度 / Google —— 留接口,后续按需加(provider 分支在 main IPC 层)。
