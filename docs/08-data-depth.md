← 返回 [plan.md](../plan.md)

# 08. 数据层与全局递归深度

> `DirectoryContentContextProvider` 单一数据源、全局 `viewDepth`、path-keyed 投影、截断、防抖。

## 1. 单一数据源

[src/renderer/hooks/DirectoryContentContextProvider.tsx](../src/renderer/hooks/DirectoryContentContextProvider.tsx) 是**所有 9 个有效视角**消费的同一份数据。L11 起拆成**两个 context**,让只读数据的消费者不被 loading/sort/视角等 UI 字段变化连带重渲染(反之亦然):

- **`DirectoryContentContext`(meta)** —— 只在**重新扫描**时变。hook:`useDirectoryContent()`。
- **`DirectoryUIContext`(ui)** —— 只在**加载/排序/视角/尺寸/用户动作**时变。hook:`useDirectoryUI()`。
- 合并 hook `useDirectoryContentContext()`(读两片,给 FileList / TagMetaContext 等同时要数据和 UI 的用)。

```ts
interface DirectoryContentMetaValue {
  entries: DirEntry[];                   // 文件 + 目录混合(viewDepth 内所有可见)
  dirs: DirEntry[];                      // 仅目录(FolderViz 重建树用)
  tagsByName: Map<string, string[]>;     // path → tags
  descByName: Map<string, string>;       // path → description
  geoByName: Map<string, GeoPoint|null>;// path → geo
  recursiveTruncated: boolean;
}
interface DirectoryUIValue {
  loading: boolean;
  error: string | null;
  sort: SortState;
  setSort: (sort: SortState) => void;
  refresh: () => void;                   // 触发重新扫描
  viewMode: ViewMode;                    // per-folder 视角
  entrySize: EntrySize;                  // per-folder 条目尺寸
  setViewMode: (mode: ViewMode) => void;
  setEntrySize: (size: EntrySize) => void;
}
// 合并(legacy,读两片):
type DirectoryContentContextValue = DirectoryContentMetaValue & DirectoryUIValue;
```

单片消费者用 `useDirectoryContent()`(数据)或 `useDirectoryUI()`(UI);同时要两片的用 `useDirectoryContentContext()`。三个 Map 由**单趟遍历** `entries` 产出(M8,曾三趟独立 useMemo)。

**Map 全部以 `entry.path` 作 key**(取代 basename),同名跨目录文件互不污染。`FileList`、`PropertiesTray`、`EntryCard`、`GridCell`、`MapiqueView`、`TagCloudView`、`KnowledgeGraphView`、`kanban.ts` 的 `bucketEntries` 等所有消费方都用 `e.path` 查。

`aggregateRecursiveEntries(visible, sidecars)` 纯函数保留在 [src/shared/recursive-entries.ts](../src/shared/recursive-entries.ts),可单测。

## 2. 全局递归深度 `viewDepth`

[src/renderer/reducers/settings.ts](../src/renderer/reducers/settings.ts):

- `viewDepth: number`,clamp `[1, 5]`,默认 `1`(`DEFAULT_VIEW_DEPTH = 1`)(等同"只看当前目录",向后兼容)
- `SET_VIEW_DEPTH` + `setViewDepth(n)` action
- redux-persist 持久化(全局,不分位置 / 不分文件夹)
- 迁移兜底:`if (base.viewDepth === undefined) base = { ...base, viewDepth: DEFAULT_VIEW_DEPTH }`

**视图消费**:

- 深度 = 1:走现有 `listDirectory` + 单 `readSidecars(dir)`,行为等同历史(逐像素一致承诺)
- 深度 > 1:走 `listDirectoryRecursive(currentDirectoryPath, { maxDepth: viewDepth })` + 批量 `readSidecarsForPaths(...)` 拼 `aggregateRecursiveEntries`

**性能护栏**:

- `MAX_RECURSIVE_ENTRIES = 10000` —— 主进程 `listDirectoryRecursive` 切片截断(剩余配额递归)
- `DirectoryContentContextProvider` 内 `useEffect` 200ms 防抖(`setTimeout` + `debouncedDepth` 守卫),拖动 1→5 只触发 1 次递归 IPC
- `recursiveTruncated: boolean` 在 context 中暴露,由各消费者决定是否展示

## 3. 批量 sidecar 读取 IPC

[src/main/ipc.ts](../src/main/ipc.ts) 注册 `sidecar:readForPaths` handler;主进程侧 [src/main/sidecar.ts](../src/main/sidecar.ts) 的 `readSidecardsForPaths(paths)` 并行执行两遍:

- **Pass 1**(并行 `Promise.all`):按父目录分组,每个目录 bulk 读 `wsd.json`
- **Pass 2**(并行 `Promise.all`,仅当 Pass 1 后仍有 `missing` 时):凡 wsd.json 没命中的 path,逐个调 `readSidecar(filePath)`(内部已经实现"先试 wsd.json → 失败就 withLock(loadFilesOrMigrate) 读 legacy per-file")

**性能**:深度 = 5 + 50 子目录实测从 50 IPC → 1 IPC,2.5-10s → 100-300ms。

**回归**:旧 `.whale/<file>.json` legacy per-file sidecar 在新加 tag 之前 dir 没有 `wsd.json`,Pass 2 仍正确读出。

## 4. IPC 注册教训

`readSidecarsForPaths` 定义在 `sidecar.ts` 但 **必须** 在 `ipc.ts` 用 `ipcMain.handle('sidecar:readForPaths', ...)` 真正注册(N12 bug 教训:曾因主进程漏注册,深度≥2 时所有 tag 静默丢失)。

`preload.ts` 暴露的桥名是 `readSidecardsForPaths`(沿用 `sidecar.ts:readSidecards` 的 typo,**不纠**,见 [docs/09-known-issues.md](./09-known-issues.md) §N2)。

## 5. 排序行为

`compareEntries(a, b, sort)` 在 `DirectoryContentContextProvider` 内:

- **depth-blind**:不接收 `viewDepth` 参数,深度 > 1 仍按 `a.name.localeCompare(b.name, …)` 比较
- **不存在**"深度 > 1 改 path-based sort"与 `sortByPathHint` i18n 键 —— 该行为目前**未实现**
- size / modified / extension 语义不变

**已知 bug / 缺口**(代码层面):点击 TagCloud / KG 标签 → 切到列表可能要看完整个递归集才能过滤到对应文件,但**当前按 basename 过滤**,同名跨目录会正确命中(走 path-keyed map)。**H.22 根治**:`aggregateRecursiveEntries` 已是 path-keyed。

## 6. 目录 / 文件分离

context 暴露:

- `entries`:深度内**所有可见条目**(文件 + 目录)—— List/Grid/Gallery/Kanban/Calendar/Matrix/Mapique/TagCloud/KnowledgeGraph 用
- `dirs`:仅目录 —— FolderViz 重建嵌套树用

8 个非 FolderViz 视角不看 `dirs`;FolderViz 拿 `dirs + entries` 重建嵌套树(context 的 flat 列表直接给 FolderViz 重建树性能差且语义不清,所以 FolderViz 例外)。

## 7. loading / error / 截断 UI

- 工具栏 Refresh 按钮旁 spinner(loading 状态)
- FileList 容器半透明 Backdrop(loading 期间)
- **FileList 顶部 `<Alert severity="warning">`**(`FileList.tsx:1373-1377`):context `recursiveTruncated` 触发
- **仅 FileList 渲染**该 Alert;Gallery / Kanban / Matrix / Gantt / Calendar / Mapique / TagCloud / KG / FolderViz 各自的根组件不含此 Alert —— 用户切到这些视图时不会看见截断提示(`recursiveTruncated` 已在 context 中暴露,后续要让每个视角都显就移进 provider 渲染)
- Mapique 的 in-flight loading 经 FileList 新增 `loading` prop 透传

## 8. 工具栏 Slider

[src/renderer/components/FileToolbar.tsx](../src/renderer/components/FileToolbar.tsx) 顶部全局深度 Slider:

- 70px (`sx={{ width: 70 }}`),无 marks,`valueLabelDisplay="auto"`,`min=1, max=5, step=1`
- 拖动直接 `dispatch(setViewDepth)` —— **不在 toolbar 做防抖**
- 200ms 防抖在 `DirectoryContentContextProvider` 内(`useEffect` + `setTimeout` 守卫 `debouncedDepth`),拖动 1→5 只触发 1 次递归 IPC

各视图自带深度滑块已删除(原 TagCloud / KG / Mapique 各自维护的 `whale.<view>.<id>.maxDepth` 已清理)。

## 9. 空 / 边界

- `currentDirectoryPath === ''`(无 location 选中)提前 return 清空状态,不进 IPC
- 单层空子目录场景下深度 1 ≡ 深度 2 的 `entries` / `tagsByName` / `visible` —— `viewDepthEquivalence.test.ts` 锁住
- 深度 5 的大工程目录(`node_modules`)有 200-500ms 扫描延迟 + 截断 + loading 反馈,可感知但不卡死

## 10. 历史清理

启动一次性清掉 `whale.folderViz.<id>` / `whale.tagCloud.<id>` / `whale.kg.<id>` localStorage 中的 `maxDepth` 字段(老 per-view 设置已废弃,迁到全局)。`vizType` 在 folderviz 仍保留 per-location localStorage。

## 11. 已知取舍

- **结果缓存** ✅ 已做(2026-07-14,P1-3)—— `listDirectoryRecursive` 的 `DirEntry[]` 现缓存到 `<dir>/.whale/index-recursive/d<depth>.json`([recursive-cache.ts](../src/main/recursive-cache.ts),镜像 transcode/office-cache)。**只缓存 scan**(sidecar 读留后续)。失效:读时 `dirPath`+`folderMtime` 双守卫 + 6 个 fs-op 钩子(delete/rename/move/copy/importExternal/mkdir)清祖先。对 renderer 透明(IPC 仍返 `DirEntry[]`)。详见 [docs/15 P1-3](./15-perf-audit.md)。
- 每文件夹深度覆盖(像视角 / 尺寸存 `wsm.json`)—— 不做,真需要再补 per-folder override
- `useRecursiveEntries` hook(老)已删除,4 个原使用方(TagCloud / KG / Mapique / FolderViz)grep 不到 import(R4,2026-07-01)
- `maxDepth` 从 `whale.folderViz.<id>` / `whale.tagCloud.<id>` / `whale.kg.<id>` 三处 localStorage 全清空
- Truncated Alert 暂只 FileList 显(其他视角按需后续补 provider 内 portal)
- 路径排序按 depth > 1 切换未实现(`compareEntries` 是 depth-blind)
