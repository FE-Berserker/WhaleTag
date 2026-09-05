← 返回 [plan.md](../plan.md)

# 01. 架构

> 三进程模型、`window.whale` 桥、`.whale/` 元数据、安全模型、构建/打包与启动踩坑。

## 1. 三进程模型

```
┌────────────────────────────────────────────────────┐
│ MAIN 进程 (Node/Electron, src/main/)                │
│   - BrowserWindow、CSP、生命周期                     │
│   - 所有文件 IO(ipc/ 域模块 / sidecar.ts / thumbnail.ts) │
│   - 缩略图、索引、AI CLI 子进程                      │
│   - 注册 whale-extension:// + whale-file:// 协议    │
└────────────────────────────────────────────────────┘
                       ↕ ipcMain.handle / event.sender.send
┌────────────────────────────────────────────────────┐
│ PRELOAD (src/main/preload.ts)                       │
│   contextBridge.exposeInMainWorld('whale', whaleApi) │
│   ~100 个方法 + AI 流式订阅 + persist 同步通道      │
└────────────────────────────────────────────────────┘
                       ↕ window.whale.* + 推送
┌────────────────────────────────────────────────────┐
│ RENDERER (React/MUI, src/renderer/)                 │
│   - web target,webpack 5 多目标                     │
│   - Redux + redux-persist + i18next + react-window  │
│   - Path alias `-/*` → src/renderer/*              │
└────────────────────────────────────────────────────┘
                       ↕ postMessage + whale-extension:// 协议
┌────────────────────────────────────────────────────┐
│ 扩展 (src/extensions/<id>/) 沙箱 iframe            │
│   15 个内置扩展(viewer / editor)                     │
└────────────────────────────────────────────────────┘
```

**Shared 层** (`src/shared/`):纯逻辑 + 类型,与进程无关,可以直跑 node:test。包含 ipc-types、whale-meta、kanban、calendar、mapique、tag-colors、smart-tags、recursive-entries、knowledge-graph、tagcloud、gantt、lunar、gcj02 等 ~30 模块。

## 2. 元数据目录 `.whale/`

每个被管理的目录下建 `.whale/`,所有元数据文件走相对路径存储,便于整体迁移。

```
folder/
├── my-file.txt
└── .whale/
    ├── wsm.json                # 文件夹元数据(viewMode / entrySize / 颜色 / 视角)
    ├── wsd.json                # 目录级聚合 sidecar(keyed by basename,只存有标签的文件)
    ├── wtaglib.json            # per-location 标签库描述
    ├── index.db                # SQLite FTS5 索引(files + files_fts + fulltext_fts + exif_processed)
    ├── thumbs/                 # 单文件缩略图(256px JPEG)
    ├── wst.jpg                 # 文件夹缩略图
    ├── wsb.jpg                 # 文件夹背景(1024px)
    ├── revisions/              # 修订历史备份(<basename>/<ts>.<ext>)
    └── _migration-state.json   # 一次性数据迁移标志
```

## 3. 自定义协议

| 协议 | 用法 |
|---|---|
| `whale-extension://<ext-id>/...` | 沙箱扩展 iframe 资源;`registerSchemesAsPrivileged({standard, secure})` 在 `app.ready` **之前** 调用,否则 origin 是 opaque,`document.cookie` 抛 `SecurityError`。各扩展自己 meta CSP 治理,主进程 CSP **跳过** 该协议 |
| `whale-file://<encoded-path>` | 支持 Range 的流式文件服务,渲染层 `<video>` / `<audio>` / `<img>` 直接用;`createReadStream` + Range 响应,不进渲染层内存 |

## 4. 主进程入口

[src/main/main.ts](../src/main/main.ts) 的关键钩子:

- **`pinUserDataToProductName()`**:`app.whenReady()` **之前** 调 `app.setPath('userData', ...)` + `app.setName(...)`,强制 `userData` 落到 `%APPDATA%/WhaleTag/`。直接 `electron .` 不经 npm 时不调这条会让 `app.getPath('userData')` 退化为 `AppData/Roaming/Electron/`,跟打包应用分两套 userData,"无法保存"的错觉根因
- **CSP**:`onHeadersReceived` 设 renderer CSP(`default-src 'self'; img-src 'self' https: http: data: blob: ...`;`whale-extension://` 响应跳过,见 §3)
- **whale-file 网关**:`protocol.handle('whale-file')` 经 `assertWithinAllowedRoot` 后从磁盘 Range 读;Range 逻辑抽到 `protocol-range.ts`(`createFileRangeResponse`)
- **冷启动惰性加载**:pdfjs-dist(~1MB+)与 ffmpeg-static **不在** main.ts 顶层 import——pdfjs 经 `nodeRequire`(`createRequire(__filename)`)在首次 PDF 缩略图 / 全文抽取时才 load([src/main/fulltext.ts](../src/main/fulltext.ts) 与 [src/main/thumbnail.ts](../src/main/thumbnail.ts) 的 `getPdfjs()`),ffmpeg-static 只为诊断日志惰性 `import()`([src/main/main.ts](../src/main/main.ts))。sharp / better-sqlite3 / @napi-rs/canvas 仍随 `./ipc` eager 加载(IPC handler 启动即要用)。

## 5. 渲染层桥

[src/main/preload.ts](../src/main/preload.ts) 暴露 `window.whale`:

- **所有 FS 操作** = `invoke('fs:*' | 'sidecar:*' | 'thumbnail:*' | ...)`
- **AI 流式** = `event.sender.send('ai:chunk' | 'ai:error' | 'ai:approvalRequest')`;preload 暴露 `onAiChunk(cb)` / `onAiApprovalRequest(cb)` 返回 unsubscribe。**仅限固定 ai: 通道,不泛化整桥** —— 这是唯一 main→renderer 推送通道
- **redux-persist**:`persistRead/Write/DeleteSync` 等同步 IPC(走主进程 `writeFileSync(.tmp) + renameSync`,Chromium localStorage 异步 flush 在 OS 强杀 / 3s close-fallback 时会丢数据)

## 6. 状态管理

**Redux + redux-persist**(不用 Toolkit,plain reducer)。`configureStore` 加载 8 个 slice:

- `locations` `settings` `taglibrary` `workflow` `recent` `savedsearches` `extensions` `ai`

**Context Providers**(挂在 [src/renderer/containers/Root.tsx](../src/renderer/containers/Root.tsx)):

```
CurrentLocation → DirectoryContent → DirectoryTreeRefresh → IOActions
  → LocationIndex → TagMeta → LocationTagLibrary → ExtensionContext
```

`DirectoryContentContextProvider` 是**单一数据源**,统一供给所有 9 视角,详见 [docs/08-data-depth.md](./08-data-depth.md)。

## 7. 安全模型

- `contextIsolation: true` `nodeIntegration: false` `sandbox: true`
- 渲染层**永不**直接碰 Node,只经 `window.whale`
- 所有文件 IO 集中在 [src/main/ipc/](../src/main/ipc/)(按域拆分:fs-read / fs-write / fs-roots / dialogs / shell / search-index / meta / thumbnails / extensions / window / persist),写操作经 `assertWithinAllowedRoot` 限制在已注册位置内
- 扩展 iframe sandbox = `allow-same-origin allow-scripts allow-modals allow-downloads`;主进程只接受 `event.source === iframe.contentWindow` 的消息
- 外部链接走 `shell.openExternal` / 系统浏览器,不在扩展内跳转
- AI 写操作经只读护栏 + 用户批准(`ApprovalModal`)
- API key 存于 Electron `safeStorage`(DPAPI / Keychain),不进 redux-persist / 不回显明文

## 8. 构建 / 打包

```bash
npm install          # 含原生模块(better-sqlite3 / sharp / @napi-rs/canvas)需 @electron/rebuild
npm run dev          # main watch + 渲染层 dev server(:4002) + electronmon
npm run build        # 生产构建 → release/app/dist/{main,renderer,extensions}
npm start            # 跑生产构建
npm run package      # electron-builder 当前平台
npm run package:win  # NSIS / :mac DMG / :linux AppImage
npm run lint         # ESLint
npm run type-check   # tsc --noEmit
npm test             # node:test 经 electron
```

`.erb/configs/webpack.config.{main,renderer}.{dev,prod}.ts` 多目标;原生模块靠 webpack externals + builder `asarUnpack`。基础配置在 [`webpack.config.base.ts`](../.erb/configs/webpack.config.base.ts) 的 `createBase({ esnext })`——**仅 renderer 传 `esnext: true`**(让动态 `import()` 成为分割点);**主进程 / 扩展必须 CommonJS**(ESM 下 webpack 会把 `createRequire(__filename)` stub 成 undefined,详见 [docs/09 §19](./09-known-issues.md))。

**renderer 代码分割**:`FileList` / `TaskView` / `SettingsDialogProvider` / `MainLayout` 里的视角组件 `React.lazy` + `<Suspense>`;echarts(Calendar / TagCloud / FolderViz)、leaflet(Mapique)、@xyflow(KnowledgeGraph)各自独立异步 chunk,首屏只加载 `main + 1 个 vendor`(≈0.94 MiB,拆分前 4.7 MiB)。`webpack.config.renderer.prod.ts` 的 `output.clean: true` 每次构建清掉旧 contenthash chunk,不累积进安装包。

**dev 启动硬约束**(反复踩过的坑,先看完):

```bash
unset ELECTRON_RUN_AS_NODE              # 必须清,残留会让 Electron 退化为 Node 解释器
netstat -ano | grep ":4002"             # 杀光堆积旧进程(electronmon + electron + dev server)
cmd //c "taskkill /F /PID <pid>"
npm run dev
```

**症状速查**:见到 `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`、或 `process.type === undefined`、或 `require('electron')` 拿到字符串 —— 90% 是 `ELECTRON_RUN_AS_NODE=1` 残留,**先 unset 再查版本兼容**。

**扩展 dist 同步警告**:Electron 在运行时加载的是 `release/app/dist/extensions/<id>/`(见 [`src/main/ipc/extensions.ts`](../src/main/ipc/extensions.ts) `loadExtensionRegistry` 路径),**不是 `src/extensions/<id>/`**。改任何 `src/extensions/*/` 下的 **HTML / CSS / 静态资源**,必须重跑:

```bash
npm run build:extensions       # 重新生成 release/app/dist/extensions/<id>/
```

否则 iframe 会加载过期的 HTML/CSS,新的 TS 引用会找不到 DOM 节点 → `applyLocale()` / `setTextContent` 抛 NPE → viewer / editor 静默死锁,主窗口看到的是"打不开"的白屏。**`npm run dev` 只 watch main bundle,HTML/CSS 不会自动复制** —— 必须显式跑一次 `build:extensions`,然后**重启所有 Whale 窗口**(iframe 不热替换 HTML)。

如果只是改了 `index.ts`,webpack 重新打 `bundle.js` 后 iframe 也要刷新一次(`Ctrl+R` 或重启窗口)。

## 9. 扩展加载失败的可见化

每个扩展的 `index.ts` 顶层应该包一层 try/catch,捕获 `applyLocale()` / DOM 引用 / first-paint 任意时点抛出的异常,统一经 `window.whaleExt.postMessage({ type: 'error', path, message })` 通知 host([`ExtensionHost.tsx:750`](../src/renderer/components/ExtensionHost.tsx) 接收并 console.error + toast,避免"白屏无解释")。**`extension-api.js` 已经把 `onMessage` / `onLocale` handler 包了 try/catch**(`src/extensions/shared/extension-api.js:44-51, 79-83`),但**模块顶层 + init 阶段抛出的同步异常不在它的保护范围内** —— 那种异常会一路冒到 `window.onerror`,主窗口看到一个死 iframe 不知道原因。

最小写法:

```ts
try {
  applyTheme(detectInitialTheme());
  state.fontSize = loadFontSize(window.localStorage);
  // ...
  applyLocale();
  renderFile('');
  // ...
  window.whaleExt.postMessage({ type: 'ready' });
} catch (err) {
  window.whaleExt.postMessage({
    type: 'error',
    path: 'init',
    message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
}
```

## 10. 测试命令

`electron --test`(Node test runner,经 ts-node)跑 `src` + `scripts` 下所有 `*.test.ts(x)`(~1700 用例 / 98 文件)。

- **自动发现**:[scripts/run-tests.cjs](../scripts/run-tests.cjs) 用 glob 枚举全部测试文件交给 `electron --test`——**新增测试无需改 package.json**。
- **`pretest` 闸门**:`npm test` 先跑 `tsc --noEmit`;类型回归当场红。`build:*` 都带 `transpileOnly`,pretest 是唯一的类型校验点。

## 11. 设置面板(8 个分类)

[src/renderer/components/SettingsDialog.tsx](../src/renderer/components/SettingsDialog.tsx) = 左侧分类导航 + 右侧分类面板双栏布局(类 VS Code Preferences)。**8 个分类**(代码 `SECTIONS` 数组顺序):

| 分类 | key | Section 组件 |
|---|---|---|
| 通用 | `general` | `GeneralSection` |
| 视图 | `view` | `ViewSection` |
| 键盘 | `keyboard` | `KeyboardSection` |
| 地图 | `mapique` | `MapSection` |
| 标签与工作流 | `tags` | `TagsSection`(内嵌 `WorkflowManagerDialog`) |
| 通知 | `notifications` | `NotificationsSection` |
| AI | `ai` | `AiSection`(enable / 模型 / 权限 / CLI / API key / MCP) |
| 高级 | `advanced` | `AdvancedSection`(内嵌 `ExtensionsSection` + `FulltextSection` + `DwgConverterSection`) |

侧栏(`Sidebar.tsx`)底栏只剩 4 个图标:回收站 / 新建 Excalidraw / 新建 Drawio / 设置。`WorkflowManagerDialog` 由 SettingsDialog 在 `tags` 分类 stateful 渲染。

## 12. 渲染层重渲染优化 + 响应式布局

**重渲染优化(Track C)**:

- **Context 拆分(L11)**:`DirectoryContentContext` 拆成 meta(数据,重新扫描才变)+ UI(loading/sort/视角,动作才变)两个 context,单片消费者互不连带重渲染。详见 [docs/08 §1](./08-data-depth.md)。
- **FileListHeader memo(M6)**:[FileListHeader](../src/renderer/components/FileListHeader.tsx) `React.memo` + 稳定 `useCallback`(列宽 / 可见性 / 密度 handler)+ `setSort` 直传;选行 / 滚动时表头跳过重渲染(曾每次 FileList 重渲染都连带)。
- **useNow 共享(M10)**:[useNow](../src/renderer/hooks/useNow.ts) 所有消费者(FileList / PropertiesTray / TagMeta)共享**一个** `setInterval`(`useSyncExternalStore` + 模块级 store,首消费者启动 / 末消费者停止),每分钟一次批量重渲染(曾每消费者一个定时器)。
- **TagMeta 批量上色(M9)**:新 tag 的色攒成一个 `setTagColors` 一次 dispatch(1 次 persist 写,曾 N 次)。详见 [docs/03 §5](./03-tagging.md)。

**响应式布局(窄窗口)**:

- **视角切换器折叠**:[FileListHeader](../src/renderer/components/FileListHeader.tsx) `ResizeObserver` 测宽——workspace ≥ 720 时 9 个视角全 inline;< 720 时 list/grid/gallery inline + 其余 6 个进 `⋯` 溢出菜单(当前专门视角的图标显示在触发按钮上,活动视角不丢)。
- **左栏标签页**:[MainLayout](../src/renderer/containers/MainLayout.tsx) viewport ≤ 1400px **或 AI 面板打开时**(`aiEnabled && aiPanelOpen`,2026-07-22 起——AI 面板占 380px 右栏,左双列会让工作区过窄),Sidebar(位置)+ DirectoryTree(目录树)合成**单个标签页面板**(位置 / 目录树 切换 + `+` 加位置),省 ~260px 给工作区;AI 面板关闭且 > 1400px 恢复并排。两组件各加 `embedded` 模式(去标题栏、宽度 100%)。
- **AI 面板宽度**:默认 420 → **380**(`aiPanelWidth`,迁移把旧 420 也降到 380;自定义值保留)。

## 13. 架构审阅遗留(2026-07-18)

> 2026-07-18 全仓架构审阅发现的结构项(性能项见 docs/15,不重复)已全部修复,以下记录修复后的当前结构与防复发 gotcha。模块级遗留记在各模块文档:索引生命周期 → [docs/04 §10](./04-search-index.md);扩展宿主 → [docs/07 §10](./07-extensions.md);读侧边界 → [docs/13 §13](./13-security.md)。审阅发现的迁移时序 bug 与 persist 同步链路已修,分别见 [docs/09 §26](./09-known-issues.md) / [docs/02 §10](./02-file-io.md)。

**主进程结构**

- `src/main/ipc/` 按域拆分(11 个域模块,清单见 §7),各域持有自己的业务逻辑与闭包;[index.ts](../src/main/ipc/index.ts) 是 ~40 行薄注册器,`import './ipc'` 经目录解析到 index(调用方零改)。**测试坑**:`ipc.test.ts` 的 require.cache 失效必须枚举全部 12 个模块(只清 `./ipc` 会让域模块钉在旧 stub 上)。**路径坑**:`readCadWasm` / `readHeicWasm` / registry 的 `__dirname/../extensions` 随目录加深为 `../../extensions`。
- `drawio-thumb.ts` / `excalidraw-thumb.ts` 为未接入主流程的死代码(thumbnail.ts 无 drawio/excalidraw kind 分支,缩略图走品牌图标),已删。
- index / thumb 两个 worker host 的 reqId 关联 / spawn 生命周期同构,公共层在 [worker-protocol.ts](../src/main/worker-protocol.ts)(newRequest / completeRequest / failRequest / rejectAllPending);spawn / 传输层各写一遍是有意的(utilityProcess vs 外部子进程)。

**状态管理(§6)**

- redux-thunk 已删注册(`configureStore.ts` 不再 `applyMiddleware`;全库零 thunk action)。异步 IPC 经 ipcApi 直调留在组件 / Provider —— 这是既定模式,真需要编排时再往 services 收敛。
- `reducers/settings.ts` god-slice 已按**同形状拆分**成 [reducers/settings/](../src/renderer/reducers/settings/) 5 个域模块 —— `appearance`(主题/标签色/字体/列/tray)、`browser`(默认视图/回收站/隐藏文件/lunar/viewDepth/fulltext)、`integrations`(地图 + 用户命令)、`ai`(ai* 18 字段单 action)、`system`(默认位置/自动更新/keybindings/任务提醒 + REMOVE_LOCATION/REMOVE_STAGE 跨 slice 反应);各域自持字段接口 / 初始值 / 迁移 / reduce;主文件是 ~90 行组合层(接口 extends 组合 + initialState 展开 + migrate/reduce 链 + `export *` 全量再导出)。**state 形状零变化**:selector / redux-persist 不受影响;keybindings sanitize 的 `autoMergeLevel1` 敏感段原注释随迁。

**渲染层桥(§5)**

- `src/renderer/services/ipc-api.ts` = 42 行类型化代理(`export const ipcApi: WhaleApi = window.whale ?? makeThrowingProxy()`,无 preload 环境首次调用才抛错);`WhaleApi` 单一事实源在 `src/shared/ipc-types.ts`。

**构建(§8)**

- echarts 按需注册(`echarts/core`,共享 [services/echarts-setup.ts](../src/renderer/services/echarts-setup.ts))。`GraphicComponent`(FolderViz 中心标签 `graphic:` 元素)与 `TreeChart`(FolderViz tree / radial 模式)容易漏注册,已踩过;`echarts-wordcloud` 经 `echarts/lib/echarts` 深路径与 `echarts/core` 共享注册表,实例同一性无问题。

**重渲染(§12)**

- `ExtensionContextProvider.tsx` / `FileSelectionContextProvider.tsx` 的 context `value` 已包 `useMemo`(成员本已稳定 —— useSelector 引用 / useState 值 / useCallback),MainLayout 无关渲染不再级联到 FileList 等 6+ 消费者。
- `FileList.tsx` 的 `useNow()` 每分钟 tick 已门控:仅 `date:` / `smart:*` 鲜度过滤把 live `now` 传进 memo(`nowTick`),其余过滤吃冻结哨兵 `FROZEN_NOW` —— 普通标签 / `geo:` / `period:` 过滤下,每分钟 tick 不再重算过滤、不再全可见行重渲;`smartFunctionalityOfTag` 显式传 `now`。
- `FileToolbar.tsx` 用 `useDirectoryUI()` 单片订阅(combined hook 会连数据片一起订,每次 rescan 白重渲工具栏)。

**Shared 层(§1)**

- 19 个视角 / 领域模块已迁入 `src/renderer/domain/`;contracts(ipc-types / whale-meta / extension-types / ai-types 等)留 shared;smart-tags 因 main 仍引用故留下。
- period 解析(`isPeriodTag` / `dateTagRangeKey` / `DateTagRange` / `parseYyyymmdd`)在 [smart-tags.ts](../src/shared/smart-tags.ts)(main 的 HTTP `apply_tag` 与日期迁移要用),[calendar.ts](../src/renderer/domain/calendar.ts) import + re-export,渲染层调用点零改动;全库不再有 shared → renderer/domain 反向依赖。
