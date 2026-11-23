← 返回 [plan.md](../plan.md)

# 09. 已知坑与已修复的关键 bug

> 跨模块的实战教训。新增 / 排查时先看这里;模块专属坑留在对应模块文档。

---

## 1. dev 启动黑魔法:`ELECTRON_RUN_AS_NODE=1` 残留

**症状速查**(出现任一组合,先查这个,不要怀疑版本):

- `electron .` 启动报 `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`(或 `app` / `BrowserWindow` / `ipcMain`)
- 主进程里 `require('electron')` 拿到的是**字符串**(electron.exe 路径),不是模块
- 脚本开头 `process.type === undefined`
- electronmon 抛 `TypeError: Cannot use 'in' operator to search for 'name' in undefined`(hook.js:82)后 `app exited with code 7`

**根因**:shell 残留 `ELECTRON_RUN_AS_NODE=1` —— 上次跑测试 `cross-env ... ELECTRON_RUN_AS_NODE=1 electron --test ...` 留下的。这个变量让 electron.exe 退化为纯 Node 解释器,不进 Chromium 主进程上下文,`process.type` 永远是 `undefined`。

**修复 + 预防**:

```bash
unset ELECTRON_RUN_AS_NODE
echo "ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"   # 确认已清
netstat -ano | grep ":4002"
cmd //c "taskkill /F /PID <pid>"
npm run dev
```

永远不要从这里去查"是不是 Electron 42 / Node 24 不兼容" —— 用户机器一直能跑,问题永远在 shell 环境。

---

## 2. redux-persist "恢复默认值" (H.25, 2026-07-04)

改了 settings 关闭重启后全部回到 `themeMode: 'light'` / `viewDepth: 1` / `language: 'en'` 等默认。真实根因是 **`autoMergeLevel1` reconciler 跳过整个 settings slice 的 rehydration**(不是写盘丢失),叠加三层 bug:

1. **rehydration 核心**:[`src/renderer/reducers/settings/system.ts`](../src/renderer/reducers/settings/system.ts) 的 keybindings 迁移 `base = { ...base, keybindings: sanitizeKeybindings(base.keybindings) }` —— `sanitizeKeybindings` 总返回**新对象**;`autoMergeLevel1` 见 `originalState[key] !== reducedState[key]` 跳过整个 slice 合并
2. **userData 路径分裂**:开发期直接 `electron.exe main.js` 启动时,`app.getName()` 退化为 `"Electron"`,userData 落到 `%APPDATA%/Electron/`,与打包应用两套入口互不感知
3. **写盘非原子 + 错误静默**:`persistWrite` 用 `writeFileSync` 直写主文件,部分写入 + `JSON.parse` 抛错被吞

**修复**:

- `pinUserDataToProductName()` 在 `whenReady` 之前 pin 到 `%APPDATA%/<productName>`
- 字段级迁移(sanitize / migrate)逐键比较,**真改了才分配新对象**
- 写 `<key>.json.tmp` + `renameSync`,失败 re-throw 不再静默
- `storage.ts` IPC 全部 try-catch,失败 `Promise.reject`
- 读失败不再按"无数据"处理:非 ENOENT 上抛,renderer 暂停 persistor 并提示,避免默认值回写覆盖;写盘每会话保留一份 `.json.bak`(2026-11-23)

详见 [docs/02-file-io.md §8](./02-file-io.md)。

---

## 3. MUI 9 API 迁移

- `<Stack alignItems="center">` → `<Stack sx={{ alignItems: 'center' }}>`
- `<TextField InputProps={{...}}>` → `<TextField slotProps={{ input: {...} }}>`
- `<Checkbox inputProps={{...}}>` → `<Checkbox slotProps={{ input: {...} }}>`
- `<ListItemText *TypographyProps>` → `<ListItemText slotProps={{...}}>`
- `<Dialog PaperProps>` → `<Dialog slotProps={{ paper: {...} }}>`
- **例外**:`<InputBase inputProps={{ 'data-tag-input': true }}>` **仍可用**(MUI 9 保留此 API)

---

## 4. 原生模块 ABI

better-sqlite3 / sharp / ffmpeg-static / @napi-rs/canvas 均为 N-API / 预编译:

- `@electron/rebuild` 针对 Electron ABI
- webpack externals(主进程)需要标注
- `builder.json` `asarUnpack` 含二进制
- Electron ABI 探针防 node_modules ABI 与 Electron 不匹配

---

## 5. 写文件时 grep 报"binary file matches"(2026-07-01, kanban.ts 中招)

Edit 工具在 Windows 偶发写入 `\0` null 字节。修法:用 Write 重写干净。改纯函数后注意 grep 确认非 binary。

---

## 6. drawio 双层 iframe 拓扑的四件套

(任何想用 Electron 套第三方 webapp 的扩展都受这条影响,如 excalidraw / drawio)

1. `protocol.registerSchemesAsPrivileged({standard, secure})` 必须在 `app.ready` **之前**
2. **不要**给 `whale-extension://` 响应套主进程 CSP;`onHeadersReceived` 跳过,用各扩展 meta CSP 治理
3. build 第三方 webapp 时**不要**自作聪明过滤子目录;drawio `App.main` 同步等子资源 200,失败不发 `init`
4. 第三方 webapp 的 embed 协议经常有"遗留字符串握手"和"结构化 JSON"两套;drawio 是 `proto=json` URL 参数切换

详见 [docs/01-architecture.md §3](./01-architecture.md)、[docs/07-extensions.md §6](./07-extensions.md)。

---

## 7. drawio H.17 五个 bug(已修,踩坑教训)

- `#1` `BINARY_EXT` 误加 drawio/dio(mxfile 是 UTF-8 文本)
- `#2` `readFirstDiagramXml` 对无 `%` 前缀的 body 盲目 inflate → "invalid bit length repeat"
- `#3` `useNewDrawio` 占位符是缩进格式(`<diagram>\n  <mxGraphModel/>`),drawio `parseDiagramNode` 拿空白文本当 documentElement 失败 → 改成单行零空白占位符
- `#4` drawio save 实测走 `export` action event,**不是** `autosave`/`save`;bridge 必须三事件统一映射到 `{kind: 'xml', xml}`
- `#5` drawio `editor.modified` 默认 false;Save 按钮不能依赖 dirty
- 加上 drawio `parent.postMessage('ready', '*')` 字符串握手 → 加 `?proto=json` 切到结构化协议

详见 [docs/07-extensions.md §8](./07-extensions.md)。

---

## 8. PDF 渲染与 CJK 字体

**最终方案** = 在扩展 iframe(真 Chromium)内用 pdfjs 浏览器版渲染到 `<canvas>`。曾经走主进程 `node-canvas`,但 pdfjs 在 Node 端**没有 CJK 字体替换表** —— 非嵌入字体(如 CAJ 导出 PDF 里非嵌入黑体/宋体标题)只能画成 notdef 方框。Chromium 渲染会自动用系统字体经 `@font-face local()` 补字形。

**`pdfjs-dist` 主进程路径**(`cMapUrl` / `standardFontDataUrl`):

- 必须是**纯文件系统路径 + 结尾 `/`**(不是 `file://` URL)
- 也不能用 `path.sep` 反斜杠 —— pdfjs 强制结尾 `/`

**iframe 内绕开 CSP**:

- 线程内 fake worker:`globalThis.pdfjsWorker = pdfjsWorker` 让 pdfjs 在 iframe 主线程解析,免独立 worker / `worker-src` CSP
- 自定义 `BinaryDataFactory`(`getDocument` 支持传)—— cmap / 标准字体 / wasm 经 `postMessage` 向宿主索取(宿主 IPC 走 `ext:getPdfAsset` 从 `node_modules/pdfjs-dist` 读),绕开 iframe `connect-src 'none'` 与 `registerFileProtocol` 不支持 fetch
- `isEvalSupported: false`(iframe 无 `unsafe-eval`)
- `builder.json` `asarUnpack` 已含 `pdfjs-dist` 的 `cmaps/` `standard_fonts/` `wasm/` 三目录

**遗留**:扫描型图片 PDF(JBIG2 / JPEG2000)需 WebAssembly,iframe CSP 未开 `wasm-unsafe-eval`,可能解码失败;当前文本型 PDF 不受影响。

---

## 9. 路径处理(macOS / Windows / 云)

- 三形态归一(Mac/Linux `\`、Windows `\ `、云 `/` 无盘符)
- 比较前两侧统一去尾分隔符
- 大小写按平台归一:win32/darwin 折叠、linux 精确(与主进程 [path-fold.ts](../src/main/path-fold.ts) 一致;`isSameOrDescendant` 的 `caseInsensitive` 参数可显式覆盖)
- Path 把 basename 解析反函数 `parentDir` 在 [src/renderer/services/path-util.ts](../src/renderer/services/path-util.ts)

---

## 10. allowedRoots / symlink 逃逸

`sync` symlink 让 allowedRoots 校验看似通过实际写入旁路:必须用 `fs.realpathSync` 解析目标(不存在则递归解析存在的父目录再拼尾部);`setAllowedRoots` 也对 root 做 `realpathSync`(不可达 fallback `path.resolve`)。

---

## 11. Mapique 瓦片加载 / CSP

底图灰屏的真凶是**两道独立 CSP**(主进程 `onHeadersReceived` header 和 `index.html` `<meta>`),浏览器取**交集**。两处 `img-src` 都须含 `https: http:`。

- OSM 瓦片国内不可达 → 默认高德(`mapTileUrl` 在 Settings → Mapique 可改)
- Leaflet 在 flex 布局里需根容器 `height:'100%'` + `AutoResize`
- 坐标系:存储 WGS-84;高德 WGS→GCJ、点图打标 GCJ→WGS(`src/renderer/domain/gcj02.ts` 迭代反算);OSM 不转

---

## 12. ThumbIcon 快速滚动卡 Skeleton

IO 回调 `observed` 标志必须**双向同步**:`isIntersecting: true` 复位 true,`false` 翻 false。否则快速滚过的 cell 永远停在 Skeleton,滚回视口也不会再填充。详见 [docs/06-thumbnails.md §4](./06-thumbnails.md)。

---

## 13. CAJ 文件

`CAJ\0` 子型内嵌 PDF 的对象流本身就不规范(不止 xref 坏,对象顺序、压缩、引用都可能异常),pdfjs 自动恢复解不出来 → `Invalid PDF structure`。CAJ 缩略图 / CAJ viewer 已撤回,完全不实现。`.caj` 双击走系统默认应用(CAJViewer / 浏览器)。详情:不可做的根因(无 GPL 依赖)见原 `docs/06-thumbnails.md` 决策段。

---

## 14. allowedRoots 启动竞态 — TaskReminder / LocationIndex 触发"Refused: no configured locations"(2026-07-05)

**症状**:Dev console 启动期固定报一行

```
Task reminder check failed: Error: Error invoking remote method 'index:build':
  Error: Refused: no configured locations, cannot write C:\Whale\Test
```

紧接着 `tagLibrary:read` 同样报一次。任务提醒永远不弹;HMR / 重启前都不恢复。

**根因**(顺序):

1. React **子 → 父** 触发 `useEffect`。`TaskReminder`(Root 的子树)在 `Root.tsx:87-89` 之前挂载并跑自己的 effect,把 `index:build(<Test>)` IPC 立刻发出去。
2. 同一帧稍后 `Root` 的 effect 跑,把 `setAllowedRoots([<Test>])` IPC 发出去。
3. 两个 IPC 在 renderer→main 通道里按发送顺序排队。**`index:build` 先到**,主进程 `allowedRoots.size === 0` → 抛 "Refused"(`src/main/allowed-roots.ts:47-49` 的 fail-closed 防御,见 [docs/02-file-io.md §6](./02-file-io.md))。
4. `setAllowedRoots` 接着到,把 `<Test>` 注册进 allowedRoots,但 `TaskReminder` 的 deps `[enabled, location, pendingTags]` 没变,**不会重跑**。
5. `TaskReminder.tsx:131` 的 `console.warn` 把错误吞掉,UI 不报。

[LocationIndexContextProvider.tsx](../src/renderer/hooks/LocationIndexContextProvider.tsx) 的 `build` 回调有同样的依赖,但只在用户点击"重建索引"时触发,通常晚于 Root 的 effect,所以表现不明显 —— 不修也不会出问题。

**修复**(`src/renderer/services/allowed-roots.ts`,新文件):

- `setAllowedRootsAndWait(roots)` 在 `Root.tsx` 调用,把 in-flight promise 记到模块级变量
- `waitForAllowedRoots()` 返回那个 promise(没有就 `Promise.resolve()`),`TaskReminder` 在 `await ipcApi.buildLocationIndex(root)` **之前**先 `await waitForAllowedRoots()`

子 effect 已经把 IPC 排队了,await 的是**同一个** in-flight promise,不是新发一次,所以不增加一次 round trip。空 allowedRoots 的合法场景(用户没配 location)同样安全 —— TaskReminder 的 `!location` 短路,不会到 `buildLocationIndex`。

**替代方案未取**:`useLayoutEffect` 仍是子→父顺序;`setAllowedRoots` 提到 store 订阅层会让 `configureStore.ts` 依赖 `window.whale`;`ipcRenderer.sendSync` 同步 IPC 要扩 preload + main 且无硬需求。

**fail-closed 是预期行为**:没注册根目录就调写 IPC 本就该被 `assertWithinAllowedRoot` 拒(否则等于绕过安全护栏);只在 renderer 层把"发 IPC 的时机"对齐到"根目录到位"。

---

## 15. 已移除模块的归档教训(media-player / office-viewer / pdf-viewer / md-editor)

✅ 四个扩展均随 0.4.9 瘦身移除(2026-09),各自的历史坑清单随代码删除归档,只留仍然有效的通用教训:

- **media-player**:Chromium `<video>` / `<audio>` 的 native controls 栏(含画中画图标)是 shadow DOM,与 React 工具栏无关;排查"用户报告的按钮"先看 `tagName`,抑制单个按钮用 `controlsList` / `disablePictureInPicture` / `disableRemotePlayback`。
- **office-viewer**:通用资产(pdfjs 会话工厂、`computeDisplayScale` 三档缩放、a11y 模式)后随 pdf-viewer 一并移除;多页内容容器的高度管理走"溢出 + 滚动"而非"flex 平均压缩"——用户报"每页被挤成 1/N"几乎一定是子项默认 `flex-shrink: 1` 被压扁。
- **pdf-viewer**:pdfjs 的 API 同型异名(`PDFDocumentProxy.cleanup(): Promise` vs `PDFPageProxy.cleanup(): boolean`)照 `.d.ts` 抄,别凭记忆。**PDF 支持没丢**:缩略图(`thumb-render.ts`)与全文索引(`fulltext.ts`)仍走 pdfjs-dist,见 [docs/06](./06-thumbnails.md) / [docs/04](./04-search-index.md)。
- **md-editor**:postMessage 沙箱须校验 `e.source === contentWindow` 且 shape 匹配(§6);DOMPurify 放行属性要配 `FORBID_ATTR`;扩展 `applyTheme` 必须接受并解析 `'system'`(AGENTS.md 坑 #4)。
- **dev 模式不 watch 扩展**:改完 `src/extensions/` 必须 `npm run build:extensions`,否则 `release/app/dist/extensions/<id>/bundle.js` 一直 stale;`watch:extensions` script 存在但没接进 `npm run dev` 的 concurrently。

## 19. webpack `module: 'esnext'` 把主进程 `createRequire` stub 成 undefined (2026-07-09)

**症状**:`npm run dev` / `npm start` 主进程启动即崩,electron 退出码 1,electronmon 崩溃循环:

```
App threw an error during load
TypeError: Cannot read properties of undefined (reading 'resolve')
    at ./src/main/fulltext.ts (main.js:18426:32)
    at __webpack_require__ ...
    at ./src/main/ipc.ts
```

**根因**:为让 renderer 的 `React.lazy` 能 code-split,给 ts-loader 加了 `compilerOptions.module: 'esnext'`(让动态 `import()` 成为分割点)。这条**不能进主进程**:ESM 下 webpack 的 node-plugin 识别出 `import { createRequire } from 'module'` 的 `createRequire` 绑定,把 `createRequire(__filename)` **stub 成 `undefined`**(build 时无法解析 `__filename` 路径)。产物里 literally 是:

```js
const nodeRequire = /* createRequire() */ undefined;
```

随后 `nodeRequire.resolve('pdfjs-dist/...')` 当场炸。CommonJS 下 `import { createRequire } from 'module'` 编成普通 `require('module').createResolve`,webpack 不特殊识别,正常。

**为什么 type-check / 单测 / `build:main` 都没抓到**:stub 只出现在**运行时主进程 webpack 产物**里。`tsc --noEmit`、ts-node 单测(直接读 tsconfig)、prod `build:main`(只编译不跑)都不执行产物。**只有真跑起来才暴露** —— smoke test 抓到的。

**修复**:[webpack.config.base.ts](../.erb/configs/webpack.config.base.ts) 从 `export default {…}` 改成 `createBase({ esnext })` 函数。**只有 renderer 传 `esnext: true`**([renderer.dev](../.erb/configs/webpack.config.renderer.dev.ts) / [renderer.prod](../.erb/configs/webpack.config.renderer.prod.ts)),**主进程 + 扩展用 CommonJS**(`createBase()`,不传)。base 文件头部注释已写死这条约束。修后产物确认:`const nodeRequire = (0, module_1.createRequire)(__filename);` —— 真 createRequire。

**教训**:

- webpack 配置改动(尤其 `module` / `target` / `node`)必须**真跑 `npm run dev` 验证主进程启动**,不能只靠 build / test。
- 主进程用 `nodeRequire`(`createRequire(__filename)`)的地方:[fulltext.ts](../src/main/fulltext.ts) / [thumbnail.ts](../src/main/thumbnail.ts) —— 任何让它们走 ESM 的改动都会复现这个 stub。

## 20. 工具链硬化:测试自动发现 + pretest 类型闸门 (2026-07-09)

**问题 A — 测试脚本漏跑**(2026-07 历史快照,文件数为当时口径):`package.json` 的 `test` 曾是硬编码 91 个文件的手维护列表。当时实测磁盘 98 个 `.test.ts(x)`,**8 个从未跑过**(含 [EntryContextMenu.test.tsx](../src/renderer/components/EntryContextMenu.test.tsx) / [PeriodTagDialog.test.tsx](../src/renderer/components/PeriodTagDialog.test.tsx) / gantt hooks / [locations.test.ts](../src/renderer/reducers/locations.test.ts) / [migrate-date-tags.test.ts](../src/main/migrate-date-tags.test.ts) / 2 个 drawio 脚本测试),外加 1 个幽灵条目指向不存在的 `text-viewer/text-stats.test.ts`。[TaskView.test.tsx](../src/renderer/components/TaskView.test.tsx) 虽在列表里但 12 个 case 全失败(缺 `IOActionsContextProvider` 包裹),`npm test` 一直是红的 —— 只是没被当硬闸门。

**修复**:[scripts/run-tests.cjs](../scripts/run-tests.cjs) 用 glob 自动发现 `src` + `scripts` 下全部测试交给 `electron --test`,新增测试无需改 package.json。补全 2 个测试文件的 provider 包裹(对照一直绿着的 [KanbanView.test.tsx](../src/renderer/components/KanbanView.test.tsx))。全套从"红"修到 1702 绿(当时口径;当前规模见 [docs/01 §10](./01-architecture.md))。

**问题 B — 构建全链路不做类型检查**:所有 `build:*` 带 `TS_NODE_TRANSPILE_ONLY` + ts-loader `transpileOnly`,无 CI、无 pretest 钩子。`src/main` 里有个类型导入路径错(`../../../shared/whale-meta`,多一层 `../`),运行时是 type-position 被擦除所以不崩,但 `tsc` 报错 —— 被 transpileOnly 掩盖已久。

**修复**:加 `"pretest": "npm run type-check"`。`npm test` 先跑 `tsc --noEmit` 再跑测试;并修掉那处类型导入路径。之后 #11 加 `markExifProcessedMany` 时,pretest 当场抓到漏改 `WhaleApi` 接口([ipc-types.ts](../src/shared/ipc-types.ts)),避免了带病上线。

**教训**:`transpileOnly` 下 pretest 是**唯一**的类型校验点;给桥(`window.whale` / `WhaleApi`)加方法必须三处同步改:[preload.ts](../src/main/preload.ts)(实现)+ [ipc-types.ts](../src/shared/ipc-types.ts)(接口)+ [ipc-api.ts](../src/renderer/services/ipc-api.ts)(renderer 侧)—— pretest 会拦下漏改。

## 21. dev 缺 `splitChunks` → React.lazy 视图 chunk 带第二份 React → "Expected static flag was missing" (2026-07-10)

**症状**:dev 下切到 lazy 视角(Gallery / Calendar / Mapique / KnowledgeGraph 等)时控制台抛:

```
Internal React error: Expected static flag was missing. Please notify the React team.
  at GalleryCell ... at GalleryView ... at Suspense ... at FileList ...
```

(react-dom 开发模式);prod 不报。

**根因**:[webpack.config.renderer.dev.ts](../.erb/configs/webpack.config.renderer.dev.ts) 原本没有 `splitChunks`,webpack 默认(async-only)把 **React 打第二份进每个 `React.lazy` 视图 chunk**。lazy 组件的 JSX(用它自己那份 `react/jsx-runtime` 实例生成)交给入口的 React 渲染时,JSX 静态 flag 对不上 → react-dom dev 抛错。prod 有 `splitChunks: { chunks: 'all' }`(React 去重成一份,所以 prod 没事),dev 漏了。

**修复**:dev 配置加 `optimization: { splitChunks: { chunks: 'all' } }`,和 prod([webpack.config.renderer.prod.ts](../.erb/configs/webpack.config.renderer.prod.ts))对齐 —— React 去重成单个共享 vendor chunk,所有 lazy 视图共用同一份。配置改动需重启 dev server(HMR 不重载配置)。

**教训**:给 renderer 加 `React.lazy` 拆包(见 [docs/01 §8](./01-architecture.md))后,**dev 配置也要同步 `splitChunks`**,否则 dev 下多份 React 触发这个内部错。和 §19(createRequire)一样,这类 webpack 配置问题只有真跑起来才暴露 —— dev / smoke test 验证不可省。

## 22. 自定义命令:Windows 路径含 `%` 被拒(2026-07-12)

**症状**:右键一个文件名含 `%` 的文件(如 `data%20file.csv`)→ "命令" 子菜单跑用户命令 → toast `commandPathBlocked`,命令不运行。

**根因**(设计取舍,非 bug):cmd.exe 默认下,双引号 `"..."` 内的 `%VAR%` 仍会展开成环境变量(如 `%PATH%`)。`%%` 转义**只在 .bat 批处理内有效**,`cmd /k "<cmd>"` 单条命令内无法可靠转义 `%`。文件名里的 `%` 因此可能注入环境变量内容 → 命令注入面。

**处理**:[runUserCommand](../src/main/shell-command.ts) 在替换前检测 `targetPath.includes('%')` → 直接拒,renderer 映射到 `commandPathBlocked` 文案。`!`(cmd 默认 delayed expansion 关)放行。99.99% 文件名不含 `%`。用户解法:重命名文件去掉 `%`,或改用不含 `${path}` 的命令。

**通用教训**:任何"用户模板 + 文件路径替换进 cmd"的功能,`%` 是 cmd 引号套不住的唯一元字符 —— 要么拒(当前方案)、要么改走 PowerShell(`psQuote` 单引号全安全,见 [fs-write.ts runOsZip](../src/main/ipc/fs-write.ts))、要么写临时 .bat(批处理内 `%%` 生效)。详见 [docs/13 §8](./13-security.md)。

---

## 23. utilityProcess 子进程:`parentPort` 在 `process` 上不在 `electron` 导出上;且 fork 能直读 app.asar(2026-07-13,P0-2 索引迁出主进程)

**症状**:P0-2 把 SQLite / FTS5 / EXIF 管线迁进 `utilityProcess`([index-worker.ts](../src/main/index-worker.ts)),type-check 过、dev 不报错,但 worker **一启动就 `exit code 1`**,所有 `index:*` / `fulltext:*` / `exif:*` IPC 全 reject「index worker exited unexpectedly」。dev 没被发现是因为 worker 惰性 spawn(首次索引请求才拉起)。

**根因(三个独立坑,前两个打包才触发,第三个 dev 才触发)**:

1. **`parentPort` 取错地方**:`index-worker.ts` 写 `import { parentPort } from 'electron'`。但 Electron 42 的 utilityProcess 子进程里 `parentPort` **只在 `process.parentPort` 上**;`require('electron').parentPort` 运行时是 `undefined`(Electron 的 `.d.ts` 把类型挂在 electron 导出上 → TS 不报错,值却不在)→ `if (!parentPort) throw` → 启动即崩。探针实证:`{ hasProcessParentPort: true, hasElectronParentPort: false }`。
2. **`utilityProcess.fork` 能直读 asar**(P0-1):`index-worker-spawn.ts` 误把「外部 node 读不了 asar」的教训套到 utilityProcess 上,做了 `app.asar → app.asar.unpacked` 重写。但 utilityProcess 是 Electron 原生进程、asar 感知(不同于 `child_process.fork`,见 electron#2708);而 worker entry **不在 `asarUnpack`**(只原生 node_modules 解包了)→ 重写后路径不存在 → 打包版 fork ENOENT。dev 无 asar,不触发。
3. **dev 下 `app.getAppPath()` 是项目根**(第 3 个坑,dev 冒烟才发现):原 `index-worker-spawn.ts` 用 `path.join(app.getAppPath(), 'dist', 'main', ...)` 拼 worker 路径。打包时 `getAppPath()` = `app.asar`,拼出来对;但 **dev(electronmon 跑 `.`)`getAppPath()` 返回项目根 `c:\WhaleTag`**,拼出 `c:\WhaleTag\dist\main\index-worker.js`(不存在,真文件在 `release/app/dist/main/`)→ dev fork `ERR_MODULE_NOT_FOUND`。打包不触发。

**修复**:
- [index-worker.ts](../src/main/index-worker.ts):`import { parentPort } from 'electron'` → `const parentPort = process.parentPort`(主进程里 `process.parentPort` 为 `null`,守卫仍挡得住误从主进程加载)。
- [index-worker-spawn.ts](../src/main/index-worker-spawn.ts):**锚定 `__dirname`**(worker 和 main.js 同目录;webpack `node.__dirname:false` dev+prod 都开着 → dev=`release/app/dist/main`、打包=`app.asar/dist/main` 都对),不再用 `app.getAppPath()`;同时删掉 asar 重写(fork 直读 app.asar)。
- [index-db.ts](../src/main/index-db.ts) 生产守卫同样用 `!process.parentPort`(Electron 类型:非 utility 进程为 `null`,不是 `undefined`)。

**冒烟验证**:打包版 `utilityProcess.fork('…/app.asar/dist/main/index-worker.js')` → `ready` → `index:status` / `index:build` 往返 OK(`better-sqlite3` 从 app.asar 正常加载);dev 版 fork `release/app/dist/main/index-worker.js` 同样 OK。三个坑 type-check 全过、dev 只触发第 3 个、打包只触发前两个。

**通用教训**:
- utilityProcess 子进程的 parent port 用 `process.parentPort`,**不要** `import from 'electron'`——类型在、运行时值不在。Electron 类型声明误导的高发区。
- `utilityProcess.fork`(Electron 原生)≠ `child_process.fork`(纯 Node)。前者 asar 感知,后者读不了 asar(electron#2708)—— 对 asar 内 entry 做 `app.asar → app.asar.unpacked` 重写只对外部 node 子进程成立,utilityProcess 反而会 ENOENT。
- **`app.getAppPath()` 在 dev 和打包返回值不同**(dev = 启动目录/项目根,打包 = `app.asar`)。要拿「和 main.js 同目录的文件」,锚定 `__dirname`(前提 webpack `node.__dirname:false`),别用 `getAppPath()` 拼。
- utilityProcess / 打包相关改动,type-check 发现不了;dev 和打包各自的坑只有各自冒烟才暴露。**`npm run dev` 触发一次索引 + `npm run package` fork 冒烟,两个都要做**。详见 [docs/15 P0-2](./15-perf-audit.md)。

## 24. 启动时序:主进程 bootstrap 早于渲染层 roots 推送,启动迁移静默空跑(2026-07-18)

**症状**:`wsd.json` / `wsm.json` 里的老前缀日期标签(`today-YYYYMMDD` 等)在生产环境从未被迁移;启动日志恒为 `scanned=0 migrated=0`。

**根因**:`bootstrap()` 在 `createWindow()` **之前**调 `runMigration(getAllowedRoots())`(原 [main.ts](../src/main/main.ts)),而 allowedRoots 只能由渲染层挂载后经 `fs:setAllowedRoots` 推送([Root.tsx](../src/renderer/containers/Root.tsx) → [fs-roots.ts](../src/main/ipc/fs-roots.ts))—— 启动时集合必为空,`runMigration` 对空数组直接 early-return。type-check / 单测全绿(单测直接传 roots 调 `runMigration`,不经启动路径),只有全链路审阅才暴露。

**修复**:触发点移到 `fs:setAllowedRoots` handler —— 首次**非空**推送时 `triggerStartupMigration(getAllowedRoots())`([migrate-date-tags.ts](../src/main/migrate-date-tags.ts));模块级 once-guard 防后续 location 增删的重推送重跑,空推送不消耗 guard(渲染层 rehydration 前可能先推一次 `[]`)。

**教训**:主进程 `bootstrap()` 里任何依赖**渲染层推送状态**(allowedRoots / settings)的逻辑,启动时拿到的都是初始空值 —— 这类"启动即跑"的任务必须挂到首次推送之后,或像 `TaskReminder` 那样 `waitForAllowedRoots()`。详见 [docs/03 §11](./03-tagging.md)。

## 25. console.* 写死管道 → EPIPE 未捕获异常(2026-07-19)

**症状**:dev 长时间运行 + electronmon 多轮重启后,打开地图视角触发 `Uncaught Exception: EPIPE: broken pipe, write`,栈顶停在 `extractGps` 的 `console.debug`。

**根因**:主进程 `console.*` 写的是父进程(electronmon / concurrently)持有的 stdout/stderr 管道;父进程死了管道即断 —— dev 多实例堆积(docs/01 §8)时必现。此后任何一次 console 写入都 EPIPE 并冒成未捕获异常。地图视角只是触发点:它给每张图调 `extractGps`,而该函数每张图打一条 debug 日志。

**修复**:① [exif.ts](../src/main/exif.ts) 删掉两条 per-file `console.debug`(批量扫描下本来就是刷屏);② [main.ts](../src/main/main.ts) 顶部加全局 EPIPE 守卫 —— `process.stdout/stderr.on('error')` 只吞 EPIPE、其余上抛;GUI 应用丢日志好过崩溃。

**教训**:主进程任何 `console.*`(含 `process.stdout.write` 直写)都是潜在 EPIPE 崩溃点;per-file 调试日志不进库。清场重启(docs/01 §8)只缓解,守卫才是根治。

## 26. 组件在 hooks 之前 early-return → 条件态切换时 hooks 数变化,React 整树崩溃(2026-07-22)

**症状**:Kanban 视角打开 `WorkflowManagerDialog` 删掉最后一个阶段(或反过来,空阶段配置下新增首个),整个视角被 ErrorBoundary 接管,报 `Rendered fewer hooks than expected`。

**根因**:[KanbanView.tsx](../src/renderer/components/KanbanView.tsx) 的 `if (stages.length === 0) return <空态/>` 写在全部 `useMemo`/`useState`/`useCallback` **之前**;`stages.length` 0↔N 切换改变 hooks 数,违反 Rules of Hooks。

**修复**:空态 return 移到所有 hooks 之后(空态下 `WorkflowManagerDialog` 保持挂载,用户可就地补回阶段);回归测试 `KanbanView.test.tsx #2b` 锁住 empty→populated→empty 双向切换。

**教训**:任何"空态提前 return"都必须放在组件 hooks 链末尾(或改为 JSX 条件分支)。MatrixView 本来就是对的;新写视角组件时把空态当一等分支审。

> 同类陷阱(同日修):悬停打开的 MUI 嵌套子菜单,**子 Menu 的 ModalRoot 是 fixed inset-0 全屏层**,会盖住父菜单项制造幻影 mouseLeave/Enter 循环(飞窗闪烁)——flyout root 须 `pointer-events:none`(paper 恢复 `auto`)。详见 [docs/13 §8](./13-security.md) 菜单形态条。

## 27. 用本地化文案前缀匹配推断 toast 严重度 → 五种语言全部误判(2026-07-22)

**症状**:ja/ko 界面下所有 toast(包括真错误)显示绿色"成功";en/zh 下"移动/打包成功"反而显示红色错误。

**根因**:FileList 的 Snackbar 拿 notice 文本去 `startsWith(t('tagsApplied',{count:0}).split('0')[0])` 等判断 severity。ja/ko 译文以 `{{count}}` 开头 → 前缀为空串,`startsWith('')` 恒真(全绿);`movedItems`/`packaged` 不在白名单 → 成功消息落到默认 error(全红)。

**修复**:notice 结构化 `{ text, severity, openTrash? }`,严重度由产生处显式携带(`showNotice(msg, severity?, opts?)`,默认 error;`useListCommands` 同步)。**语义绝不从展示文案反推** —— 尤其文案是多语言可变的。

**同类陷阱**(同日修):DirectoryTree 删除确认固定用 `confirmDelete`("不可撤销")但底层默认走回收站 —— 文案必须与 `deleteToTrash` 实际行为分支一致。

## 28. MUI Snackbar 关闭时仍渲染子元素 + 项目级 strictNullChecks 未开 → 空引用崩溃编译期不可见(2026-07-22)

**症状**:FileList 渲染即崩 `TypeError: Cannot read properties of null (reading 'severity')`,整树被 ErrorBoundary 接管。

**根因**:两条叠加 —— ① MUI `Snackbar` 为了退出过渡,**`open=false` 时也保持子元素挂载**,子元素内的任何表达式都会在 `notice === null` 时执行;notice 结构化改造时把 `notice?.severity` 写成了 `notice.severity`。② 项目 `tsconfig.json` **从未开启 `strict` / `strictNullChecks`**,`T | null` 上直接读属性编译不报错 —— 这类崩溃在 `npm run type-check` 下完全不可见。

**修复**:Snackbar 子元素内恢复可选链(`notice?.severity ?? 'info'` / `notice?.text ?? ''` / `notice?.openTrash`),并留注释说明子元素常驻挂载。

**教训**:① Snackbar 的子元素是"常驻渲染"的,任何读状态的表达式都必须 null-safe(或把条件判断挪到 Snackbar 外面,代价是失去退出动画)。② 本项目 null 安全曾长期靠人工,不靠编译器 —— 评审 `| null` 状态的渲染路径时要主动找 naked property access。
**2026-11 更新**:`tsconfig.json` 已开启 `strict`(含 `strictNullChecks`),并把 `scripts/` 纳入 `tsc` include;本次硬化清掉 112 个 strict 错误(其中测试 helper 占多数),进程见 [docs/19](./19-code-audit.md) P1-25。这条教训的"编译器看不见"前提不再成立,但 Snackbar 常驻挂载的结构性风险仍在。

## 29. pdfjs 自定义 range transport 必须 `extends PDFDataRangeTransport` —— 鸭子类型被 `instanceof` 静默吞掉(2026-07-25)

✅ 消费方 pdf-viewer 已随 0.4.9 瘦身移除(2026-09),`WhaleRangeTransport` 与 `fs:readFileRange` 桥随之删除,本条归档。通用教训仍然有效:第三方库的"鸭子类型接口"一律先查源码有没有 `instanceof` 品牌检查(pdfjs 尤甚);命中检查时不会报"类型不对",而是报一个误导性的"参数缺失"(如 `getDocument` 的 `expected either 'data', 'range', or 'url'`)。

## 30. 测试在 jsdom 之前静态加载 MUI → Emotion 选到 SSR 包装,出现 ref / Grow 告警(2026-11-22)

**症状**:`CalendarView.test.tsx` / `EntryContextMenu.test.tsx` 在 `globalJsdom()` 之前就静态 `import` 被测组件,组件链带入 MUI;测试输出 `Function components cannot be given refs` / `Expected an element that can hold a ref` 以及 Grow / 过渡相关告警。生产构建与真实窗口没有这些告警。

**根因**:Emotion 在模块求值时根据 `typeof document` 选择实现;测试文件顶部的静态 import 先于 `before()` 里的 `globalJsdom()` 执行,于是选中 SSR 版 `withEmotionCache`(非 `forwardRef` 包装),之后 Tooltip / Menu / Select 再传 ref 就告警。这是测试装载顺序问题,不是组件实现问题。

**修法**:测试把被测组件改成 `let` 类型声明(`CalendarView` 另含被间接带入的 `IOActionsContextProvider`),在 `before()` 里 `globalJsdom()` 之后 `await import(...)`;同时增加断言:开启 `console.error` 捕获上述两类 ref 告警,渲染后必须为空。生产组件不改 —— 浏览器 / Electron 中 DOM 始终先于 MUI 模块求值。

**教训**:jsdom 测试的契约是"先建 DOM,再加载 MUI";文件顶部的静态 `import` 会绕过 `before()` 的时序。新增涉及 MUI 过渡组件的测试时,沿用动态 import,别为了 import 好看把顺序改回去。

## 31. 多 entry 的 `[runtime]/chunks` 会让扩展 chunk URL 变成 `_/chunks`(2026-11-22)

**症状**:磁盘上 chunk 正确落在 `excalidraw-editor/chunks/`,但 Excalidraw 的动态 import 请求 `_/chunks/<id>.<hash>.js`,真实扩展 404;只检查文件名、bundle 体积或不打开扩展的 GUI 回归会误判通过。

**根因**:webpack 多 entry 构建在 chunk 加载运行时的 `data.runtime` 不是字符串,`TemplatedPathPlugin` 会把 `[runtime]` 替换成字面 `_`;资源落盘与 URL 生成走了不同的 runtime 取值。直接删掉 `[runtime]` 又会把多扩展 chunk 写到共同根目录,按 `whale-extension://<extId>/` 解析仍找不到,跨扩展 splitChunks 还会破坏自包含边界。

**修法**:每个扩展使用独立 compiler 与 `output.path=dist/extensions/<extId>/`,统一 `chunkFilename='chunks/[id].[contenthash].js'`、`publicPath=''`;`splitChunks:{chunks:'async'}` 只在当前扩展内去重。验收必须执行真实 Excalidraw/Mermaid 冒烟,并把 `requestfailed` / `pageerror` / console error / 404 纳入断言,不能只看构建产物存在。

## 32. Excalidraw 0.18.1 的 API 早于 initializeScene,首份 fileContent 会被空场景覆盖(2026-11-22)

**症状**:打开已有 `.excalidraw` 时偶发空白画布;宿主已下发 fileContent,扩展也没有报错,但编辑器停在空场景,此时保存会把空场景写回磁盘。

**根因**:Excalidraw 0.18.1 在异步 `initializeScene` 完成前就暴露命令式 API;扩展收到首份 fileContent 后立刻 `updateScene`,初始化完成的空场景又把它覆盖。把内容暂存到 `pending` 再等 API ready 仍有同样的时序窗口。

**修法**:首份 fileContent resolve 进一次性 `initialData` Promise,由 `<Excalidraw initialData={loadInitialData}>` 在初始化阶段原子恢复 `{elements, appState, files}`;`consumed` 之后的 fileContent 才走 `applyScene`。上游 `restore` 是 total 函数,所以非空 JSON 先经 `parseExcalidrawScene` 验证 `type==='excalidraw'` 且 `elements` 缺省或为数组,拒绝 `{}`、library export 等 fail-open 输入。解析/形状/恢复失败向宿主 post `{type:'error',fatal:true,path}` 并重新抛出,不再静默 `restore({})`;只有恢复成功才设置文件路径,扩展内部和宿主 Save 均被阻断。失败时关闭保存立即返回 false,不再等 15 秒;宿主显示可 Retry 的错误界面,Retry 同时清空旧 revision 与自写回读快照,成功恢复后强制 dirty=false 对账,因此失败后的空画布不能覆盖源文件。

**教训**:第三方编辑器的命令式 API “已出现”不等于“初始化已完成”;场景/文档类数据优先走组件提供的 initialData 入口,而不是抢在初始化前 update。

## 33. 保存后的 fs.watch 回读会把编辑器重载回去(2026-11-22)

**症状**:Excalidraw 保存成功、宿主 dirty 已清,但紧接着 Mermaid 插入的预览或内容消失/标签被重载;外部编辑器修改同一文件时又必须刷新。

**根因**:主进程 `fs.watch` 把本次写盘也当外部变化回读,ExtensionHost 收到与刚写入内容完全相同的 `fileContent` 后重新下发,编辑器按“外部刷新”重建场景。

**修法**:ExtensionHost 用 `lastWrittenContentRef` 记录最近一次成功 `writeFileWithRevision` 的内容;仅当 `ready` 且新 `fileContent` 与记录不相等时才下发,保存成功后更新记录。出现不同内容时先作废旧自写快照再刷新,避免 B(自写)→C(外部)→B(外部) 把最后的 B 错当重复回读;切换文件或 `retryExtensionLoad` 时也会清空记录与旧 revision,重试后即使内容逐字相同也会重新下发。

**教训**:自写回读抑制要按“内容相等”而不是按路径或时间窗口:路径比较会漏掉同一文件的外部真实修改,时间窗口则依赖 fs 事件延迟;同时自写快照不能永久粘性,第一份不同内容必须将其作废,否则后续外部改回旧字节会被误吞。

## 34. React.lazy 的 import 被拒后不会自愈,需要重建 lazy 组件(2026-11-22)

**症状**:开发态或打包态某次 chunk 请求失败(404 / 网络 / CSP)后,高级搜索或扩展页一直停在错误态;再点按钮也不会重新请求。

**根因**:`React.lazy` 会把 rejected import 缓存在组件类型上;同一个 lazy 组件再次渲染仍抛同一错误,只清 ErrorBoundary 的 error state 不够。

**修法**:SearchBar/MainLayout 用 `attempt` 计数 + `useMemo(() => lazy(loader), [attempt])` 在重试时创建新的 lazy;ErrorBoundary 增加 `resetKey` / `onError` / `fallback`,重试时同时清错误态并递增 attempt。MainLayout 的 fallback 保留 `ExtensionTabBar`(可切 tab/关闭),SearchBar 的 fallback 提供错误提示与重试按钮;Suspense fallback 使用不透明背景。正常 tab 切换仍复用同一 lazy 组件,不重挂 iframe。

**教训**:lazy chunk 失败恢复要同时处理“错误边界状态”和“lazy 组件身份”;只 reset boundary 会立刻再次抛错。

## 35. editState 改 tabId 键后,关闭/监听/LRU 仍按 filePath 查询(2026-11-22)

**症状**:文本编辑器已显示 dirty `•`,关闭后台标签却不出现保存确认;外部文件刷新可能覆盖未保存内容,达到 8 个标签上限时 dirty 标签也可能被 LRU 静默驱逐。

**根因**:`extensions.editState` 为支持同一文件在不同扩展中独立编辑,键已改为 `makeTabId(filePath, manifestId)`;但关闭确认、保存后复查、fs.watch dirty 检查和 `pickLruEvict` 仍按 `filePath` 查询,全部读取不到对应 dirty 状态。

**修法**:新增 `isTabDirty(editState, tabId)` 并统一关闭/保存/监听/flush 查询;LRU 接收 `dirtyTabIds` 并用 `tab.id` 判断。共置测试覆盖同一路径两个扩展互不影响及 dirty LRU 保护;真实 packaged GUI 冒烟继续覆盖后台脏标签 Cancel 后焦点恢复与内容保留。

**教训**:修改状态键是跨读写双方的契约变更;必须 grep 所有读取点和淘汰策略,不能只改 reducer 与写入端。

## 36. 局域网只读访问的已知边界与取舍(2026-11-22)

功能行为见 [./22-lan-access.md](./22-lan-access.md),安全保证见 [./13-security.md §14](./13-security.md)。这一节只记"决定不做 / 暂时这样"的部分:

- **明文 HTTP,不防嗅探**:不做 TLS / 自签证书 / HTTPS 混淆。同网段的设备可以抓包看到目录内容、文件与配对请求里的 `Authorization` 头;前提是"可信局域网"。
- **只读,没有写能力**:不做打标 / 改名 / 移动 / 删除 / 上传;要改元数据必须回桌面端。
- **依赖桌面端已建索引**:不替 Web 端建索引或全文索引,索引缺失只回 `indexUnavailable` 并提示;搜索只覆盖文件名子串 + 标签(固定"标签全部满足"),不支持桌面的类型 / 大小 / 日期 / 排除标签条件。
- **不生成缩略图与缓存**:手机列表 / 网格直接显示安全栅格原图,加载失败回退图标,不在服务端生成缩略图;流量与解码成本按原文件算,换来的是浏览过程绝不写 `.whale/` 缩略图缓存。
- **单层浏览 + 500 项截断**:没有分页 / 游标协议;超大目录的首次加载按每项 `realpath` 复核的开销线性上升。
- **会话级而非设备级**:没有设备列表 / 单独踢下线 / 持久白名单;「停止」对全体生效,重新开始会换 token、通常也换端口。
- **网卡一变就停**:切 Wi-Fi、断网、DHCP 换 IP、VPN 起停都会自动关闭服务(面板每 2s 轮询收回已失效的二维码);多网卡 / 热点场景需要重新开启。
- **只服务私网**:跨网段、公网、运营商网络或 VPN 出口访问一律 403;不做远程访问 / 内网穿透。
- **Windows 防火墙要用户放行**:首次在 `0.0.0.0` 监听时系统会弹窗,必须勾选专用网络;拒绝后手机端表现为连不上(超时),仓库不带防火墙规则。
- **主动内容只下载**:PDF / HTML / SVG / JS 在手机上不预览,只提供下载。
- **移动端是独立实现**:自有 i18n 字典与样式(不共用桌面 locale 与主题),改文案 / 视觉要两边都改。
