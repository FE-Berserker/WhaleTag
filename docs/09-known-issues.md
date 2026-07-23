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

1. **rehydration 核心**:`src/renderer/reducers/settings.ts` keybindings 迁移 `base = { ...base, keybindings: sanitizeKeybindings(base.keybindings) }` —— `sanitizeKeybindings` 总返回**新对象**;`autoMergeLevel1` 见 `originalState[key] !== reducedState[key]` 跳过整个 slice 合并
2. **userData 路径分裂**:开发期直接 `electron.exe main.js` 启动时,`app.getName()` 退化为 `"Electron"`,userData 落到 `%APPDATA%/Electron/`,与打包应用两套入口互不感知
3. **写盘非原子 + 错误静默**:`persistWrite` 用 `writeFileSync` 直写主文件,部分写入 + `JSON.parse` 抛错被吞

**修复**:

- `pinUserDataToProductName()` 在 `whenReady` 之前 pin 到 `%APPDATA%/<productName>`
- 字段级迁移(sanitize / migrate)逐键比较,**真改了才分配新对象**
- 写 `<key>.json.tmp` + `renameSync`,失败 re-throw 不再静默
- `storage.ts` IPC 全部 try-catch,失败 `Promise.reject`

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
- Windows 大小写归一(`isSameOrDescendant` 比较前 `toLowerCase()`)
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

[LocationIndexContextProvider.tsx:99](src/renderer/hooks/LocationIndexContextProvider.tsx#L99) 的 `build` 回调有同样的依赖,但只在用户点击"重建索引"时触发,通常晚于 Root 的 effect,所以表现不明显 —— 不修也不会出问题。

**修复**(`src/renderer/services/allowed-roots.ts`,新文件):

- `setAllowedRootsAndWait(roots)` 在 `Root.tsx` 调用,把 in-flight promise 记到模块级变量
- `waitForAllowedRoots()` 返回那个 promise(没有就 `Promise.resolve()`),`TaskReminder` 在 `await ipcApi.buildLocationIndex(root)` **之前**先 `await waitForAllowedRoots()`

子 effect 已经把 IPC 排队了,await 的是**同一个** in-flight promise,不是新发一次,所以不增加一次 round trip。空 allowedRoots 的合法场景(用户没配 location)同样安全 —— TaskReminder 的 `!location` 短路,不会到 `buildLocationIndex`。

**替代方案**(没用,记录原因):

- 改 `useLayoutEffect` 不行 —— React 仍按子→父顺序
- 把 `setAllowedRoots` 提到 store 订阅层:需把 `configureStore.ts` 从纯 Redux 模块改成依赖 `window.whale`,代价大
- 新加同步 IPC `setAllowedRootsSync` 用 `ipcRenderer.sendSync`:可行但要扩 preload + main,目前没有同步注册根目录的硬需求

**为什么这是 fail-closed 的预期行为**:如果 renderer 真出问题(没注册根目录就调写 IPC),允许它写就是绕过安全护栏。我们要保留 `assertWithinAllowedRoot` 的拒绝,只在 renderer 层把"什么时候发 IPC"对齐到"什么时候根目录到位"。

---

## 15. 把"用户报告的按钮"和"代码里的按钮"对齐 — Chromium video element native controls vs React 工具栏 (2026-07-05)

**症状**:用户报告"关闭主窗口时 PiP 跟着死 / 工具栏上还有画中画按钮"。Agent 花了一整天在 React 工具栏代码(`btn-pip` / `enterPip` / `PipState` / `RequestPipMessage` / etc.) 上做撤回 + 修 keep-alive + 修 stream cast,全部 0 命中——React 工具栏上**从来没出现过**这个按钮。

**真凶**:Chromium `<video>` element 默认的 native controls 栏,会在视频右下角自动 render 一个原生画中画小图标(`⧉`)。它跟 React 工具栏完全独立,是 Chromium 自己在 video 控件里加的。

**视觉差**:

- React 工具栏的 `btn-pip` 是一个 `<button id="btn-pip">` 元素,带 React 自己的 click handler,位于工具栏布局中。
- Chromium native PiP 是一个浏览器内嵌控件,位于 `<video>` 元素的 native controls bar 底部,不可被 React 工具栏 CSS 影响。
- 两个看起来"都是画中画",但代码位置 + 触发路径完全不同。

**遗漏触发条件**:

| 情况 | 路径 | 是否有 native PiP |
|---|---|---|
| `playBytes` 路径(blob URL,音频转码后) | [src/extensions/media-player/index.ts:837](src/extensions/media-player/index.ts#L837) | 否 — 显式 `controlsList="nodownload nopictureinpicture"` + `disablePictureInPicture = true` |
| `playStreamingUrl` 路径(whale-file:// 流式) | [src/extensions/media-player/index.ts:888](src/extensions/media-player/index.ts#L888) | **是** — 只设了 `controlsList="nodownload"`,**漏 `nopictureinpicture` 和 `disablePictureInPicture`** |

所以**只有视频文件**(走 streaming URL)才看到 PiP 按钮。音频文件走 playBytes,反而没暴露问题。这条 bug 一直在,只是没被意识到,直到 video 触发才显示。

**修复**(已做):
- `playStreamingUrl` 补上 `controlsList="nodownload nopictureinpicture"` + `disablePictureInPicture = true`,跟 `playBytes` 对齐
- React 工具栏上没有任何 PiP 按钮(撤回全部死代码后),所以 native PiP 是唯一 PiP 入口,这一处 guard 就够

**同类型的"native vs custom"陷阱** —— 这次 user 反映"音量按钮也是 native 有,我不要 React 上重复",已经在 media-player 工具栏上把 React 自定义的 `btn-volume` / `volume-slider` / `btn-mute` 整个 dropdown 撤回,把音量控制完全交给 Chromium video element native controls。**lesson**:任何 video element 自身的功能(volume / mute / playback rate / fullscreen / picture-in-picture),React 自定义 UI 都应当让位给 native controls,**除非有跨 track 持久化、跨窗口状态共享等 React 端独占的需求**。

**教训**:Debug 视频/媒体相关 UI 问题时,先分清"用户看到的东西是 React DOM 还是 Chromium native DOM":

1. 在 DevTools `Elements` 面板看目标元素的 `tagName` + `class`
2. 如果是 `<video>` / `<audio>` 自身的 descendants(controls bar、shadow DOM),那是 Chromium native,React 代码无关
3. 如果是 `<div id="root">` / extension toolbar 的 children,那是 React DOM

**修视频控件问题前第一步:先看 Chromium 文档关于 `controlsList` + `disablePictureInPicture` / `disableRemotePlayback` 等** —— 这些 HTML 属性就是用来"抑制 native controls 特定按钮"的,远比在 React 层加一个 placeholder 按钮对得多。**这条路本应是第一步,不是修到第 4 步才反应过来。**

延伸:dev 模式 `npm run dev` 不 watch `src/extensions/`,改完源码必须 `npm run build:extensions` 重新 build,否则 `release/app/dist/extensions/<id>/bundle.js` 一直 stale。`watch:extensions` script 已存在但没接进 `npm run dev` 的 concurrently,这是 dev 流程的已知 gap(可以补但当前用手动补 build 的方式)。

---

## 16. office-viewer 已知坑与遗留(对照 audio-convert / pdf-viewer)

**对照基准**:
- audio-convert 转码走 `whale-audio://` 实时流式([src/main/main.ts](../src/main/main.ts) `registerWhaleAudioProtocol`):ffmpeg stdout 边转边推给 `<audio>`,同步 tee 写 `.whale/transcodes/<basename>.opus`(缓存命中走 Range/206);`isTranscodeCached` mtime 失效 + `removeTranscode` / `moveTranscode` / `copyTranscode` 全套钩子在 [src/main/transcode-cache.ts](../src/main/transcode-cache.ts),inflight dedup + 信号量在协议层
- pdf-viewer 渲染层有 fit-width / fit-page / 旋转 / 跳页 input / 键盘导航 / ResizeObserver 重排 / 滚动同步 currentPage / status 栏 / 主题初始猜测去白闪

**进度**(2026-07-06 改造;§16.16/§16.21 补于 2026-07-16;§16.4/§16.6/§16.8/§16.14/§16.18/§16.19/§16.20 补于 2026-07-18):**§16.1–§16.21 全部闭环** —— office-viewer 与 pdf-viewer 的 UX / 缓存 / 稳定性 / a11y 差距已清零。新增代码:[src/main/office-cache.ts](../src/main/office-cache.ts) / [src/main/office-convert.test.ts](../src/main/office-convert.test.ts) / [src/extensions/shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts) / [src/extensions/office-viewer/view-math.ts](../src/extensions/office-viewer/view-math.ts)。§16.12 备注(office-viewer `pendingConversions` 未套 30s 超时 —— 大文件 PPTX 可能合法 60s+)维持原评估。

### 16.1 PDF 无缓存(头号优化) ✅ 已修(2026-07-06)

`convertOfficeToPdf` 每次开档都冷启动 soffice。**同一 docx 重新打开耗时 5s 左右**,翻页不动也重转;audio 路径首次冷转 + 后续秒开,office 路径是"每次都冷转"。

迁移路径 = 仿 [src/main/transcode-cache.ts](../src/main/transcode-cache.ts) 落 `.whale/transcodes/<basename>.pdf`(复用 `TRANSCODES_DIR`),mtime 失效 + 原子写 + inflight `Map<path, Promise<Buffer>>` 去重 + `removeOfficePdf` / `moveOfficePdf` / `copyOfficePdf` 钩子。**已落地于 [src/main/office-cache.ts](../src/main/office-cache.ts)**,并接入 [src/main/ipc/fs-write.ts](../src/main/ipc/fs-write.ts) 的 `cleanupMeta` / `fs:rename` / `fs:move` / `fs:copy` / `fs:importExternal` 五个钩子点。测试 11 个 case 全过([src/main/office-cache.test.ts](../src/main/office-cache.test.ts))。

### 16.2 soffice 冷启动开销 ✅ 已修(2026-07-06,短期部分)

`execFile(bin, ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, srcPath], {timeout: 120000})` 未加 `--norestore --nologo --nofirststartwizard`,Windows 首屏 2–5s。

短期:加三个 flag,实测启动快 30–50%。
**短期已修**:`sofficeConvertArgs()` 统一定义在 [src/main/office-binary.ts](../src/main/office-binary.ts),`encodeOfficeThumb` 与 `convertOfficeToPdf` 都改用它;三个 flag 已加。**长期已修(2026-07-18)**:常驻 UNO listener —— [src/main/office-worker/uno-worker.py](../src/main/office-worker/uno-worker.py)(Python 桥接)+ [office-worker-host.ts](../src/main/office-worker/office-worker-host.ts)(Node host,惰性 spawn / 崩溃重 spawn / before-quit tree-kill / cooldown 自动回退 execFile)。首次开档仍含 2–6s listener boot,后续同进程转换 ~200–500ms。详见 [docs/17](./17-office-worker.md)。

### 16.3 无 inflight 去重 ✅ 已修(2026-07-06,随 §16.1)

`convertOfficeToPdf` 是裸函数,没 `inflight Map`。**已修**:`loadOfficePdf` 加了模块级 `inflight: Map<string, Promise<Buffer>>`(与 audio 转码的 `activeAudioTranscodes` 同模式 —— audio 转码现已改为 `whale-audio://` 实时流式,见 [src/main/main.ts](../src/main/main.ts) `registerWhaleAudioProtocol`,inflight dedup 在协议层)。8 并发 → 1 次 soffice 调用已验证。

### 16.4 Buffer → ArrayBuffer 双重拷贝 ✅ 已修(2026-07-18,docs/15 P1-4)

[src/main/ipc/extensions.ts](../src/main/ipc/extensions.ts) `convertOfficeToPdf` 返回 Buffer,IPC handler 拷成 ArrayBuffer 再传;renderer 又 `new Uint8Array(msg.data)` 一次。**典型 PDF 几 MB 到几十 MB,两次拷贝纯浪费**。Electron IPC 三者互通,直接传 Buffer / Uint8Array 即可。

**已修**:端到端改 `Uint8Array` —— handler 直返 Buffer 删拷贝,ipc-types / extension-types / ipc-api 链 `ArrayBuffer`→`Uint8Array`,viewer 直传,净省 1 次 memcpy/文档;`convertDwgToDxf` / `convertEbookToEpub` 同形照改。详见 [docs/15 P1-4](./15-perf-audit.md)。

### 16.5 缺 move/copy/remove 钩子 ✅ 已修(2026-07-06,随 §16.1)

audio-convert 三件齐全,office-convert 一件没接。**已修**:`office-cache.ts` 导出 `removeOfficePdf` / `moveOfficePdf`(含 EXDEV 回退)/ `copyOfficePdf`,均接入 [src/main/ipc/fs-write.ts](../src/main/ipc/fs-write.ts) 的 `cleanupMeta` / `fs:rename` / `fs:move` / `fs:copy` / `fs:importExternal` 五个钩子点。

### 16.6 临时目录无启动清理 ✅ 已修(2026-07-18)

`tmpDir = fsp.mkdtemp(os.tmpdir() + '/whale-office-')`,转换完 `fsp.rm(tmpDir, {recursive, force})`。**如果 Electron 主进程在 soffice 运行中崩溃**(断电 / kill -9),`whale-office-*` tmpDir 永久泄漏,无 cleanup-on-startup。

**已修**:[office-convert.ts](../src/main/office-convert.ts) 加 per-process 一次性惰性清扫 —— 首次 `convertOfficeToPdf` 前扫 `os.tmpdir()` 删掉 `whale-office-*` 残留(比启动时扫省 boot 成本,残留只在再转换时才要紧)。**mtime 守卫**:只删比本进程启动更早的目录 —— 应用无单实例锁,并发第二个 Whale 实例的活转换 tmpdir 不会被误删。测试:[office-convert.test.ts](../src/main/office-convert.test.ts)「sweeps stale whale-office-\* tmpdirs once per process」。

### 16.7 iframe 与 pdf-viewer 字符级重复 ✅ 已修(2026-07-06)

[src/extensions/office-viewer/index.ts](../src/extensions/office-viewer/index.ts) 的 `requestAsset` / `HostBinaryDataFactory` / `pendingAssets` / `renderPdf` 与 [src/extensions/pdf-viewer/index.ts](../src/extensions/pdf-viewer/index.ts) 几乎是字符级复制。**已修**:抽出 [src/extensions/shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts),导出 `createPdfjsSession(opts)` 工厂 + `detectInitialTheme()` / `applyTheme()` / `PDFJS_I18N`。pdf-viewer 保留自己的 render loop(per-page rotation + fit-mode),通过 `session.binaryDataFactory` + `session.handleHostMessage` 复用资产桥;office-viewer 用完整的 `session.renderPdfBytes`。同步修了 §16.12(`requestAsset` 30s 超时,放进 session)。

### 16.8 缺 pdf-viewer 同款 UX ✅ 已修(2026-07-18)

office-viewer 当前只支持手动缩放(+/− 两按钮),**无** fit / 旋转 / 跳页 / 键盘导航 / ResizeObserver 重排 / status 栏。

**已修**(全部镜像 pdf-viewer 的已实现模式):

- **fit-width / fit-page / manual 三档显示模式**:`computeDisplayScale`(manual → `manualZoom`;fit-width → 容器内宽 / 页宽;fit-page → 宽高取小),fit 按钮带 active 态;缩放 / fit 切换只重排 CSS(`relayoutPages`,canvas 位图不重栅格化),`Ctrl+0` fit-width、`Ctrl+9` fit-page
- **每页独立旋转 ±90°**:`pageRotations` Map + `session.rerenderPage(pageNum, rotation)`(单页重栅格化),`data-base-w/h` 随新 baseVp 更新后重排
- **跳页 input + prev/next**:`#page-input`(Enter 跳页 / Esc 还原 / blur 回写 / focus 全选)+ `#page-count`;prev/next disabled 态随 currentPage
- **键盘导航**:PageUp / PageDown / Home / End / ← / → / Ctrl(+Shift 不误劫)
- **ResizeObserver + rAF 重排**:仅 fit 模式下容器尺寸变化触发 `relayoutPages`(CSS-only,不重栅格化)
- **status 栏 + 进度条**:底部 `#status` 左文件大小(`fileContent.size`,`formatBytes`)右页数;`#loading-bar` 承载 Converting / Rendering N/M / 错误文本(`data-state` + `:empty` 隐藏,`role="status"` 保 §16.18 可宣告性)
- **TextLayer 对齐修复(顺带)**:session 新增传入 `computeDisplayScale` —— 此前 TextLayer 永远按 scale 1 布局,一缩放选区就漂移(隐性 bug,fit 模式逼着转正)
- 纯函数抽 [view-math.ts](../src/extensions/office-viewer/view-math.ts)(clampZoom / clampPage / computeDisplayScale / nextRotation / formatBytes),8 个测试用例:[view-math.test.ts](../src/extensions/office-viewer/view-math.test.ts)

### 16.9 主题初始猜测缺失 → 白闪 ✅ 已修(2026-07-06,随 §16.7)

[src/extensions/office-viewer/index.ts](../src/extensions/office-viewer/index.ts) 硬编码 `applyTheme('light')`,**深色主题用户首次打开 iframe 看到一帧白底**。**已修**:office-viewer 启动改为 `applyTheme(detectInitialTheme())`,helper 从 [shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts) import,与 pdf-viewer 完全对齐。

### 16.10 缺缩略图占位 → 2–5s 空白 ✅ 已修(2026-07-15,docs/15 P3-1)

[src/main/thumbnail.ts:138-165](../src/main/thumbnail.ts) 已经为 office 文件生成 256px JPEG 缩略图,存到 `.whale/thumbs/<basename>.jpg`,**office-viewer 完全没用**。soffice 转换 2–5s 期间 iframe 空白,用户不知道在干嘛。

修复:扩展启动时**并行**发 `requestThumbnail`(用现成 IPC 拿 jpg)和 `requestOfficeConvert`(走转换),拿到缩略图立即显示 + 进度文字,PDF 渲染完淡入。Cache 命中时直接跳到 PDF 渲染,但缩略图仍作为 first-page placeholder。

**已修**:新增 `requestThumbnail`(ext→host)/ `thumbnailContent`(host→ext)消息对([extension-types.ts](../src/shared/extension-types.ts)),host 桥([ExtensionHost.tsx](../src/renderer/components/ExtensionHost.tsx))调 `ipcApi.loadThumbnail`;office-viewer `openOfficeFile` 并行 fire 两请求,缩略图到达即 `showThumbnailPlaceholder` 居中显 jpg,`renderPdf` 清占位画真页。**未做 crossfade**(直接替换,可后续加);缓存命中时占位窗口极短但 cold convert 完整覆盖。

### 16.11 `doc.destroy()` 未调用 ✅ 已修(2026-07-06,随 §16.7)

[src/extensions/office-viewer/index.ts](../src/extensions/office-viewer/index.ts) 逐页 `page.cleanup()` 做了,但 **`await doc.destroy()` 没调** —— PDFDocumentProxy 内部的 worker 引用 / Stream 缓冲区在大型 PDF(几百页)上驻留,内存只升不降。**已修**:`pdfjs-in-iframe.ts` 的 `renderPdfBytes` 末尾调 `await doc.destroy().catch(() => undefined)`,并在 `cancel()` / `destroy()` 路径也释放。pdf-viewer 自身的 `state.loadToken` 路径仍调自己的 `doc.cleanup()`,行为不变。

### 16.12 pending resolver 无超时 ✅ 已修(2026-07-06,随 §16.7)

[src/extensions/office-viewer/index.ts](../src/extensions/office-viewer/index.ts) 两个 `Map<string, PendingResolver>`,**主进程响应丢失**(IPC 中断 / iframe reload / 主进程 OOM kill)时悬挂 resolver 永久驻留。**已修**:共享 `pdfjs-in-iframe.ts` 的 `requestAsset` 加 30s `setTimeout` 超时,`destroy()` 时遍历 Map reject 全部。注意 office-viewer 的 `pendingConversions`(soffice 转换)未套超时 —— 大文件 PPTX 可能合法地 60s+,不在本 PR。

### 16.13 soffice stderr 丢弃 ✅ 已修(2026-07-06)

`execFile` 不传 `stdio: 'pipe'`,**失败时 stderr 默认进 Electron 主进程 stdout,用户看不到诊断信息**。**已修**:[src/main/office-convert.ts](../src/main/office-convert.ts) + [src/main/thumbnail.ts](../src/main/thumbnail.ts) 的 `encodeOfficeThumb` 都改为 `stdio: ['ignore', 'pipe', 'pipe']` + 3 参 callback,失败时 `Error` message 包含 `stderr || stdout`。`[src/main/office-convert.test.ts](../src/main/office-convert.test.ts)` 的 "surfaces stderr in the error message" case 验证 fake exit 2 + stderr 文本能进 error message。

### 16.14 缺 soffice 路径用户配置入口 ✅ 已修(2026-07-18)

`options.sofficePath` 接受 override,**但 UI 没暴露**。`Settings → Extensions` 可以加一个"Office 渲染器"输入框(参考 dwg2dxf / ODA File Converter 的设置 pattern),非标准安装位置即可用。

**已修**:设置 UI 与 reducer 字段(`sofficePath` + `setSofficePath` + 5 语言 locale)此前已随缩略图链路落地([ThumbIcon](../src/renderer/components/ThumbIcon.tsx) 生成 office 缩略图时已透传),本次补齐 **viewer 链路**:[ExtensionHost](../src/renderer/components/ExtensionHost.tsx) 的 `requestOfficeConvert` → `convertOfficeToPdf(path, { sofficePath })`、`requestSofficeCheck` → `isSofficeAvailable({ sofficePath })`(ipc-types / preload / ipc handler 同步放开签名);`isSofficeAvailable(override)` 透传 override。设置里的路径输入框**不再被 `officeThumbnailEnabled` 门控** —— 不开缩略图的用户也用 viewer。注意:显式 override 会按既定语义**绕过常驻 UNO worker** 走一次性 execFile(见 [office-convert.ts](../src/main/office-convert.ts) `convertOfficeToPdfVia` 注释)。

### 16.15 缺 `office-convert.test.ts` ✅ 已修(2026-07-06)

[package.json test 脚本](../package.json) 没列 office-convert。兄弟 `ebook-convert.test.ts` / `audio-convert.test.ts` / `archive.test.ts` / `cad-convert.test.ts` 都覆盖 mtime 失效 / 原子写 / 损坏文件 / 跨卷 EXDEV / 加密文件等。office-convert 是高风险路径(soffice 失败模式多:字体缺 / Java 缺 / profile 锁 / OOM),无单测保护。**已修(2026-07-06)**:[src/main/office-convert.test.ts](../src/main/office-convert.test.ts)(8 cases)+ [src/main/office-cache.test.ts](../src/main/office-cache.test.ts)(11 cases)已挂 [package.json test 脚本](../package.json)。fake `soffice.cmd` shim 模式镜像 `ebook-convert.test.ts` 的 `makeFakeCalibre`。

### 16.16 soffice 缺失败 / 缺失引导 ✅ 已修(2026-07-16)

office-viewer `openOfficeFile` 先 `requestSofficeCheck` → host `ext:isSofficeAvailable`(`isSofficeAvailable()`)。**未装时不再尝试注定失败的 convert**,直接渲染引导屏:`T.sofficeMissing` 文案 + 「下载 LibreOffice」按钮(`openLinkExternally` → libreoffice.org)+ 「用系统默认应用打开」按钮(`openWithSystem` → `ipcApi.openNative` = `shell.openPath`)。新消息:`requestSofficeCheck`/`sofficeCheckResult`/`openWithSystem`([extension-types.ts](../src/shared/extension-types.ts))。

### 16.17 i18n 重复

[src/extensions/office-viewer/index.ts:80-101](../src/extensions/office-viewer/index.ts) 重复定义 6 个 key(`loading / failedDecode / rendering / failedRender / zoomIn / zoomOut`),与 pdf-viewer 字符级重复。新增语言时改两处。

修复:抽 `src/extensions/shared/pdf-locale.ts`,两边复用。**已修(2026-07-06)**:6 个 key 抽到 [src/extensions/shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts) 的 `PDFJS_I18N` 常量;pdf-viewer 与 office-viewer 都用 `...PDFJS_I18N[lang]` spread。**注意**:`failedRender` EN 字符串统一为 `PDF render failed: {msg}`(原 office-viewer 的 `Failed to render PDF: {msg}` 被替换),ZH 不变。

### 16.18 缺 a11y ✅ 已修(2026-07-18)

- ~~`#zoom-in` / `#zoom-out` 按钮只有 `title`,**没 `aria-label`**~~ → 已补(静态 HTML 默认值 + `applyLocale` 随语言更新,对照 pdf-viewer 两处都设)
- ~~`#status` 不是 `role="status"`,屏幕阅读器拿不到转换进度~~ → 已加 `role="status"`(隐含 aria-live=polite)
- ~~`<canvas>` 无 alt~~ → 共享渲染循环([pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts) `renderPageContent`,两个 viewer 的所有页统一)给每页 canvas 打 `role="img"` + `aria-label`;新 session 选项 `pageAriaLabel`,office-viewer 传本地化 `T.pageLabel`(新增 `pageLabel` i18n key:en `Page {n} of {total}` / zh `第 {n} 页,共 {total} 页`),pdf-viewer 未传则用默认英文 `Page N of M`(本地化留待需要时)

### 16.19 `outputScale` 魔法数 1.5 ✅ 已修(2026-07-18)

原 office-viewer 内联 `outputScale = min(dpr, 2) * 1.5` 已随 §16.7 重构消除 —— 两侧统一走 [shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts) 的 `defaultOutputScale()`,office-viewer 用 `session.renderPdfBytes` 内部消化。本次补齐"为什么 1.5"的注释(1.5× 固定超采样保小字清晰 + dpr cap 2 限 canvas 内存)。

### 16.20 CSP `font-src` 未显式声明 ✅ 已修(2026-07-18)

[src/extensions/office-viewer/index.html:7](../src/extensions/office-viewer/index.html) `default-src 'self'` 兜底 `font-src`,太宽。host 已经把 cMap / standardFont 经 IPC 供给,显式设 `font-src 'self' data: whale-extension://*` 更精确。

**已修**:CSP meta 加 `font-src 'self' data: whale-extension://*`,与 img-src 同形。

### 16.21 soffice 不存在 / 失败时无回退 ✅ 已修(2026-07-16)

转换失败(soffice 在但转不了)时,`openOfficeFile` 的 catch 不再只设 `statusEl` 文本,而是 `showOfficeMessage({ title: failedConvert, download: false, path })` —— 渲染错误文案 + 「用系统默认应用打开」按钮(`openWithSystem` → `shell.openPath`),不再卡死。soffice 缺失的回退见 §16.16(同按钮,外加下载链接)。

## 17. pdf-viewer 已知坑与已修复(Phase 1, 2026-07-06)

**对照基准**:Phase 1 之前 baseline = 12 个 PDF TypeScript 错误(3 在 [pdf-viewer/index.ts](../src/extensions/pdf-viewer/index.ts),9 在 [shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts))+ 双 render loop 复制 + 内存泄漏 try/finally 缺失 + 0 行单测。本节记录 3 个 bug 的症状 / 根因 / 修法 / 测试指向;架构债 + 测试覆盖率见 [docs/07 §5.2](./07-extensions.md) Phase 1 路线图。

**进度**(2026-07-06 Phase 1):§17.1 / §17.2 / §17.3 全修。PDF 错误 12 → 0;新增 [src/extensions/shared/pdfjs-in-iframe.test.ts](../src/extensions/shared/pdfjs-in-iframe.test.ts) 13 个 case。**剩**:3 个 §16 office-viewer PR 残留的兄弟错([office-cache.test.ts:172](../src/main/office-cache.test.ts) / [office-convert.ts:44](../src/main/office-convert.ts) / [thumbnail.ts:181](../src/main/thumbnail.ts))不在本 PR 范围,会单独起 commit 清零。

### 17.1 `outputScale()` 未声明 ✅ 已修(2026-07-06 Phase 1,§A1)

**症状**:`pdf-viewer/index.ts:284, 361, 547` 三处 `outputScale()` 调用,**该文件从未声明此函数**,TypeScript 报 `TS2304: Cannot find name 'outputScale'`,3 错。运行时:用户打开 PDF → 主 `renderPdf` 循环(`547`)走到 `const os = outputScale();` 直接 `ReferenceError`;旋转按钮(284 / 361 的 `rerenderAllPages` / `rerenderPage`)也是同一炸。

**根因**:`shared/pdfjs-in-iframe.ts:162` 的 `defaultOutputScale` 是 **file-local**(无 `export`)。早期重构把 `outputScale` 从 pdf-viewer 抽到 shared,但只 export 给 `createPdfjsSession` 内部用,没顺手 export 默认实现;pdf-viewer 自己也没声明,三处调用悬空。

**修法**:

```ts
// shared/pdfjs-in-iframe.ts
- function defaultOutputScale(): number {
+ export function defaultOutputScale(): number {
    return Math.min(window.devicePixelRatio || 1, 2) * 1.5;
  }
```

pdf-viewer refactor 后已不直接调用 `outputScale`(整个 render loop 走 `session.renderPdfBytes` 后由 session 内部消化),import 也不需要了。

**测试**:`pdfjs-in-iframe.test.ts` `defaultOutputScale` suite 测 `min(dpr, 2) * 1.5` 全分支(1 / 2 / 3 / 0);`createPdfjsSession: outputScale` suite 验证 override 传透。

### 17.2 `doc.destroy()` 调用错 API ✅ 已修(2026-07-06 Phase 1,§A2)

**症状**:`shared/pdfjs-in-iframe.ts` 6 处 `doc.destroy()`(行 295 / 304 / 311 / 333 / 347 / 367),TypeScript 报 `TS2339: Property 'destroy' does not exist on type 'PDFDocumentProxy'`,6 错。运行时:pdfjs 6.0.227 静默 `console.warn`,**`destroy()` 不存在,不释放 worker stream / 字体缓存** —— 大 PDF 翻完 100 页后,内存只升不降,DevTools `performance.memory.usedJSHeapSize` 单调递增。

**根因**:`PDFDocumentProxy` 实际 API 是 `cleanup(keepLoadedFonts?: boolean): Promise<any>`(见 `node_modules/pdfjs-dist/types/src/display/api.d.ts:1153`)。`destroy()` 只在 `PDFDocumentLoadingTask`(`api.d.ts:821`)和 `PDFWorker`(`api.d.ts:1575`)上有。早期代码照着 `PDFDocumentLoadingTask.destroy()` 抄,类型一改就漏。

**修法**(6 处全改 + 签名调整):

```ts
// 6 个调用点
- await doc.destroy().catch(() => undefined);
+ await doc.cleanup().catch(() => undefined);

// session.destroy() 内部 + 接口
- destroy(): void;
+ destroy(): Promise<void>;
- function destroy(): void {
+ async function destroy(): Promise<void> {
    // ...
-   currentDoc.destroy().catch(() => undefined);
+   await currentDoc.cleanup().catch(() => undefined);
  }
```

`cleanup()` 返 `Promise<any>`,保留 `await` + `.catch(() => undefined)`。`destroy()` 变 async 让 `cleanup()` 真的 await 完。

**测试**:`pdfjs-in-iframe.test.ts` `createPdfjsSession: cancellation` suite 用 mock pdfjsLib 验证 `doc.cleanup()` 在取消时确实被调。

### 17.3 `page.cleanup().catch()` 调用错 API ✅ 已修(2026-07-06 Phase 1,§A3)

**症状**:`shared/pdfjs-in-iframe.ts` 3 处 `await page.cleanup().catch(() => undefined)`(行 310 / 321 / 331),TypeScript 报 `TS2339: Property 'catch' does not exist on type 'boolean'`,3 错。运行时:`page.cleanup()` 返 `boolean` 而非 Promise,`TypeError: page.cleanup(...).catch is not a function`,**清理逻辑根本没跑**,PDFPageProxy 内部 `_destroy()` 留下的字体 / Stream 引用泄漏。

**根因**:`PDFPageProxy.cleanup(resetStats?: boolean): boolean`(见 `api.d.ts:1494`)与 `PDFDocumentProxy.cleanup(keepLoadedFonts?): Promise<any>`(`api.d.ts:1153`)**两个 cleanup 是不同类型,容易抄错**。早期代码把 `doc.cleanup().catch(...)` 模式复制到 `page.cleanup()` 时,没注意到 `page.cleanup` 是同步的。

**修法**(3 处全改):

```ts
// pdfjs-in-iframe.ts
- await page.cleanup().catch(() => undefined);
+ page.cleanup();  // boolean, 永 throw
```

`page.cleanup()` 内部 `try { _destroy() } catch { return false }` 自带失败处理,外层再包 try/catch 冗余。返 `false` 是合法状态(rotation re-render 路径同一 page 被清两次),不 warn。

**测试**:集成到 B2 测试套件(`createPdfjsSession: cancellation` / `hooks` / `createPdfjsSession: handleHostMessage` 的 `resolves a pending asset request` 等 case 都会走 page 路径)。

### 17.4 16/3 页 PDF 都被挤成 1/N 细条 ✅ 已修(2026-07-07 Phase 2)

**症状**:用户打开任意多页 PDF,所有页都挤在 1 个 viewport 里,每页只显示顶部 1/N 像素的细长条。16 页 PDF 每页 ≈56px 高,3 页 PDF 每页 ≈300px 高,2 页 PDF 每页 ≈viewport/2 高。**canvas 内容是对的**(顶部 header 区域可见),**只是被竖直 clip 出 1/N**。toolbar 显示页码正确,fit W / fit P 不亮(在 manual 模式)。

**根因(单一)**:`<div data-page-container>` 是 `#pages`(flex-direction: column)的 flex 子项,**默认 `flex-shrink: 1`**。`#pages` 本身只有 ~1 viewport 高(body flex column → toolbar + pages + status 各 flex auto),16 个容器被 flex 引擎平均压成 `#pages.height / 16 ≈ 56px`。容器有 `overflow: hidden`,里面 841.89px 高的 canvas 被 clip 到顶部 56px,显示成细长条。

```ts
// 旧代码 — 缺 flex-shrink: 0
container.style.cssText =
  'position: relative; display: inline-block; overflow: hidden;';
// 占位 div 也缺
container.style.cssText =
  `position:relative; display:inline-block; overflow:hidden; ` +
  `width:100%; height:${heightPxStr};`;
```

**为什么前两轮都跑偏了**(踩坑教训,合并到 §5.2 Phase 2 文档):

1. **第一轮错方向:循环依赖塌缩**。以为是 `display: inline-block` + `align-items: center` + canvas `max-width: 100%` 形成 parent 宽 ⇄ canvas max-width 循环依赖,容器塌成 ~0 宽 → 改用 `display: block; width: ${px}; height: ${px}; margin: 0 auto; canvas: width: 100%; height: 100%`。
2. **第二轮错方向:`displayHeight` 报告 22px**。显式 block + 100% 路径下,容器被拉成 `#pages` 全宽,`computeDisplayScale` 在 fit-width 状态下读 `pagesEl.clientWidth` 报过早压成 17.5px,`displayHeight = 22px` → 又改回 inline-block 容器 + 用 `oldContainer.remove()` + 新 `document.createElement('div')` 重建。
3. **第三轮错方向:Chromium canvas intrinsic 尺寸优先级**。用 `aspect-ratio: 612 / 792` 算 canvas height,Chromium 对 `<canvas>` 把 `canvas.width/height` HTML attribute 的 intrinsic 尺寸排在 CSS `aspect-ratio` 之前,`aspect-ratio` 实际被忽略,canvas height 退回 intrinsic ratio × width 算出来的非常小值 → 改 canvas 显式 `width: ${px}; height: ${px}`(不再用 aspect-ratio)。

**最终方案**(破坏性最小、单行修):

```ts
// pdfjs-in-iframe.ts renderPageContent (L405)
container.style.cssText =
  'position: relative; display: inline-block; overflow: hidden; flex-shrink: 0;';

// pdfjs-in-iframe.ts renderVirtualized (L587)
container.style.cssText =
  `position:relative; display:inline-block; overflow:hidden; ` +
  `width:100%; height:${heightPxStr}; flex-shrink:0;`;
```

**修法原理**:`flex-shrink: 0` 告诉 flex 引擎"别缩我,我溢出就溢出",容器保持 841.89px 高(由 inline-block shrink-wrap canvas 决定),`#pages` 的 `overflow: auto` 自然产生滚动条,用户滚看完整内容。

**伴随修改**:
- canvas 显式 `width: ${baseVp.width}px; height: ${baseVp.height}px`(不依赖 `aspect-ratio`,绕开 Chromium intrinsic 优先)
- `onAfterPageRender` / `relayoutPages` 同步设 `width` 和 `height`
- `#pages canvas` CSS 删 `max-width: 100%; height: auto`(历史循环依赖元凶)
- 容器 destroy + recreate(`oldContainer.remove()` + `pagesEl.appendChild(newContainer)`),避免 cssText 替换占位时浏览器缓存 stale computed style

**测试**:`src/extensions/shared/pdfjs-in-iframe.test.ts` 加 4 个 case(显式 inline-block 容器无 placeholder 残留、canvas 显式 width+height 无 aspectRatio、virtualize 占位保留 `width: 100%; height: ${estHeight}px`、virtualize 时前 3 页换成新容器其余保留 placeholder)。19/19 全过。

**经验教训**:
- 多页 PDF 的高度管理要走"溢出 + 滚动"路径,不要走"flex 平均压缩"路径
- 用户报"每页被挤成 1/N"几乎一定是 flex-shrink 问题,看 flex 父容器的 height 和子项的 flex-shrink
- 调试时优先 dump flex 父容器和子项的 `offsetWidth/offsetHeight` + computed `flex-shrink` 值,不要先猜 aspect-ratio / canvas intrinsic / 容器 display
- debug log 输出扁平 key(`canvasOffH` 而非 `canvas: { offsetHeight }`)避免 Chrome `{…}` 截断

## 18. md-editor 已知坑与改进路线图(2026-07-06 起)

**对照基准**:[docs/07 §4.1](./07-extensions.md) — 完整 22 项按 P0/P1/P2 优先级 + 修法代码路径 + 落地周次表(5 周分批)。本节是分类索引 + 修法记录。

**进度**(2026-07-06/07 Week 1+2+3+4+5+6 + 2026-07-19 架构拆分):§18.1.1–5 / §18.2.1–7 / §18.3.1–3 / §18.3.5 / §18.3.6 / §18.4.1 / §18.4.2 / §18.4.4 已修(共 20 项);§4.1 架构债(index.ts 主体拆分)✅ 已修(2026-07-19)— `index.ts` 1616 → 441 行,按 feature 拆出 md-statusbar / md-theme / md-fold / md-toc / md-scroll / md-toolbar / md-keymaps 7 个模块,共享状态走 md-context 的 `ctx`/`dom` 单例,详见 [§4.1 架构债](./07-extensions.md)。**还剩**:§18.4.3 CSP `unsafe-inline` 收紧(Week 6 试过,mermaid SVG 注入需要 inline `<style>` + `style=`,回滚 — 详见 §18.4.3 段;二期思路 `style-src-elem` / `style-src-attr` 分离或 nonce 未做)。§4.1 深度审查清单的其余项(undo 泄漏 / 状态栏词数 / CJK 词数 / 预览缓存 / 滚动同步 rAF / `applyTheme` fallback / 死代码 / CSS 已折叠 / Mod-B/I/K 快捷键 / sandbox 工厂 / OR→AND 加固 / index.ts 架构拆分)均已修。

**模块**:[src/extensions/md-editor/](../src/extensions/md-editor/) ~500 行 `index.ts` + ~700 行 `md-render.ts` + 182 行 `md-splitter.ts` + ~150 行 `md-sandbox.ts`(Week 6 新增沙箱管理) + ~1000 行测试(Week 1-6 共 104 case)+ ~700 行 `editor.css` + `mermaid-sandbox.html`(沙箱 iframe 页,3.4K)+ dist 里的 `mermaid.min.js`(3.4M,按需加载)。CodeMirror 6 + `marked` + DOMPurify + `highlight.js` + `mermaid`(沙箱隔离)+ `@codemirror/search`,左编辑右预览分屏 + 工具栏 + 状态栏 + TOC 侧栏 + 沙箱渲染 Mermaid。**Week 1-6 改造后**:`index.ts` 只剩 CodeMirror 生命周期 / 主题 / 消息路由 / 工具栏 wire / 状态栏 wire;`md-render.ts` 17 个纯函数;沙箱 iframe 隔离 mermaid v11 的 `unsafe-eval`,主 CSP 保持严格(不放宽)。

### 18.1 P0 — 硬伤(5 项,直接影响可用性)

§18.1.1 **`#splitter` 拖拽未实现** ✅ 已修(2026-07-06 Week 2)— 抽到 [md-splitter.ts](../src/extensions/md-editor/md-splitter.ts) 的 `setupSplitter({editorPane, previewPane, splitter, container})`,`index.ts` 顶层一次性 wire。mousedown 在 splitter 上,mousemove/mouseup 在 document 上(document-level 防止鼠标跑出 splitter 时丢失);ratio clamp 在 [0.2, 0.8];双击重置 50:50;键盘 ArrowLeft/Right nudge 2%,Home/End 跳到 min/max;a11y 属性 `role=separator` + `aria-orientation=vertical` + `aria-valuenow/min/max`;`body[data-editor-dragging=true]` + 鼠标 cursor 切换做 drag visual feedback。Ratio 持久化到 `md-editor-split-ratio` localStorage key,带 try/catch 容错(隐私模式 / storage 满 / JSON 损坏)。见 [docs/09 §18.1.1](./09-known-issues.md)。测试覆盖:[md-splitter.test.ts:113-348](../src/extensions/md-editor/md-splitter.test.ts)(15 case:默认值 / 存储加载 / 越界 clamp / 垃圾值回退 / 拖拽 / MIN/MAX 边界 / 中右键忽略 / 双击重置 / setRatio / reset / 键盘 nudge / 键盘 Home/End / destroy / a11y)。

§18.1.2 **`renderTimeout` 路径切换竞态** ✅ 已修(2026-07-06 Week 1)— 模块级 `setTimeout` 拆成 [md-render.ts](../src/extensions/md-editor/md-render.ts) `createPreviewScheduler(delayMs)` 工厂,内部用 `clearTimeout` 取消 + `Symbol` token 校验:`setContent` / `fileContent` 路径先 `scheduler.cancel()` 再 swap view,旧 token 的回调被静默丢弃,旧 timer 不会在新 view 上 fire。修法:见 [md-render.ts:185-235](../src/extensions/md-editor/md-render.ts)。测试覆盖:[md-render.test.ts:201-273](../src/extensions/md-editor/md-render.test.ts)(5 case:debounce / latest-doc / token-guard / cancel / view-swap)。

§18.1.3 **滚动同步粗放** ✅ 已修(2026-07-06 Week 2)— `parseMarkdown` 改用 [md-render.ts `Marked` singleton](../src/extensions/md-editor/md-render.ts) + `md.lexer` + `md.parser` 拆分,逐个 top-level block 注入 `data-source-line="N"`。**关键陷阱**:marked 的 lexer 在 block 之间显式塞 `space` token(`raw: '\n\n'` 表示 blank-line separator),且每个 block token 的 `raw` **不含**尾部换行 — 朴素数 `raw.match(/\n/g).length` 会给所有 block 标 line 1。修法:遍历所有 token,space 跳进 out 但参与行号累计,block 写当前行号。`index.ts` 的 `syncPreviewScroll` 重写:[index.ts:55-114](../src/extensions/md-editor/index.ts) 用 `view.lineBlockAtHeight(scrollTop)` + `state.doc.lineAt(from).number` 拿光标所在行号,`previewPane.querySelector('[data-source-line="N"]')` 找对应 block,`getBoundingClientRect` 算 offset 后 `scrollIntoView`-style 滚动 preview;无精确 match 时(光标在长 code block 中)回退到旧的比例映射。测试覆盖:[md-render.test.ts:60-110](../src/extensions/md-editor/md-render.test.ts)(4 case:基础 / 跨多块累加 / h1/ul/blockquote/pre/hr/table 全覆盖 / 嵌套元素不污染)。

§18.1.4 **代码块无语法高亮** ✅ 已修(2026-07-06 Week 2)— 加 dep `highlight.js@^11.11.1`(~50KB gzip),`import hljs from 'highlight.js/lib/common'`(common 包含 35 主流语言:JS/TS/Python/Java/Go/Rust/SQL/Bash/CSS/HTML/JSON/YAML/Markdown/C/C++/C#/PHP/Ruby/Perl/Scala/Kotlin/Swift/Objective-C/Dart/Lua/Elixir/Haskell/Erlang/Clojure/F#/VB/Pascal/R/Diff/Dockerfile/Makefile/Git)。[md-render.ts `highlightCodeBlocks`](../src/extensions/md-editor/md-render.ts) 遍历 `container.querySelectorAll('pre code')` 调 `hljs.highlightElement`,**幂等**(hljs 检测已高亮块跳过,innerHTML 替换后再次调用安全)。`index.ts` 的 `renderPreview` 在 `innerHTML = clean` 后立即调。CSS 主题(轻量 GitHub + GitHub-Dark,inline 在 [editor.css:196-358](../src/extensions/md-editor/editor.css))随 body[data-theme] 切换。测试覆盖:[md-render.test.ts:300-355](../src/extensions/md-editor/md-render.test.ts)(4 case:无 pre 块 no-op / JS 块加 hljs-* 类 / 无语言提示 graceful / 多块独立)。

§18.1.5 **没有任何测试** ✅ 已修(2026-07-06 Week 1)— 新增 [md-render.test.ts](../src/extensions/md-editor/md-render.test.ts)(23 case / 5 suite:`parseMarkdown` / `DOMPURIFY_CONFIG` / `sanitizeMarkdownHtml` / `setupLinkDelegation` / `createPreviewScheduler`),已挂 [package.json:35 test 脚本](../package.json)。DOMPurify 部分用 `global-jsdom@29` 装 jsdom 注入 `globalThis.window`(安装时机在 `md-render` import 之后,所以 sanitize 工厂用 lazy resolve 模式)。镜像 [src/extensions/text-editor/editor-stats.test.ts](../src/extensions/text-editor/editor-stats.ts) 模式。

### 18.2 P1 — 体验短板(7 项)

§18.2.1 **无工具栏** ✅ 已修(2026-07-06 Week 3;Week 6+ 加 Goto Line)— 加 `#toolbar` 在 [index.html:13-23](../src/extensions/md-editor/index.html) + [editor.css:498-585](../src/extensions/md-editor/editor.css) 样式,6 按钮:`Find`(Ctrl+F → `openSearchPanel`)+ `Wrap` 切换 + `Zoom In/Out/Reset`(Ctrl+0/=/-)→ 通过 `fontSizeCompartment` 走 `EditorView.theme({fontSize})` 重新配置;`mdWrapMode` 通过 `wrapCompartment` 走 `EditorView.lineWrapping` 切换;`Goto Line`(Ctrl+G → `window.prompt` 输入行号 + `view.dispatch({selection: {anchor: pos}, effects: EditorView.scrollIntoView(pos, {y: 'start'})})`,输入解析在 `parseLineInput` 纯函数(测试覆盖),bad input 走一次 retry-prompt)。状态指示器 `#wrap-state` 显示当前 mode。localStorage 持久化到 `md-editor-font-size` + `md-editor-wrap-mode` key(`md-editor-` 前缀避免与 text-editor 冲突)。值范围 clamp 10-32。**未做**:Replace All(没必要,Find 已够用)、Fold All / Unfold All(§18.4.4 text-editor 工具栏的 fold 对 MD 意义不大)。见 [docs/09 §18.2.1](./09-known-issues.md)。测试覆盖:`parseLineInput` 8 case(plain int / whitespace / leading `+` / out-of-range clamp / `N-M` range / 空 / 非数字 / `maxLines < 1` / `0` clamp)。

§18.2.2 **无状态栏** ✅ 已修(2026-07-06 Week 3)— 加 `#status` 在 [index.html:25-50](../src/extensions/md-editor/index.html) + [editor.css:430-490](../src/extensions/md-editor/editor.css) 样式(高度 22px,GitHub-风格 `f6f8fa` 背景,深色模式 `161b22`);`[md-render.ts `getStatusInfo`](../src/extensions/md-editor/md-render.ts) 纯函数从 `EditorState` 提取 `line/col/length/selection/words`;`index.ts` 的 `updateStatus(view)` 在 `updateListener` 的 `docChanged || selectionSet` 时调一次,`createEditor` 末尾 + `setReadOnly` 末尾 seed 一次(绕过 listener 不在 view 创建时 fire 的问题)。布局用 flex column:`#app` 拆为 `#toolbar` / `#main-row` / `#status` 三段。状态栏反映 **primary selection**(多选场景下 `state.selection.ranges` 第一条,匹配 text-editor 约定)。**CJK word 计数简化**:连续 CJK 字符计 1 词(`"你好世界" = 1`),英文按 `\s+` 分词;更精确的 CJK 分词是 §18.3.6 follow-up。测试覆盖:[md-render.test.ts `getStatusInfo` suite](../src/extensions/md-editor/md-render.test.ts)(6 case)+ `countWords`(4 case)。

§18.2.3 **本地相对路径图片破图** ✅ 已修(2026-07-06 Week 3)— **协议层**:`FileContentMessage` 加可选 `dirPath?: string` 字段([extension-types.ts:55-61](../src/shared/extension-types.ts)),backward-compat(老 host / 老扩展忽略即可);`ExtensionHost.tsx:185-197` 用 `parentDir(filePath)` 计算 + 发送。**扩展层**:[md-render.ts `resolveRelativeImagePath`](../src/extensions/md-editor/md-render.ts) 纯函数,处理 scheme / 绝对路径(Unix + Windows + UNC)/ 相对路径 / 无 `currentDir` 四种情况;`resolveLocalImages(container, currentDir)` 遍历 `img[src]` 调 `encodeWhaleFileUrl(resolved)`,`currentDir` 为 null 时 no-op(老 host 仍能跑,只是图片 404)。`index.ts` 在 `fileContent` 路径缓存 `currentDir`,`renderPreview` 末尾调 `resolveLocalImages`。**关键陷阱**:`/^[a-z][a-z0-9+.-]*:/i` 会把 `C:\abs\img.png` 误判为 scheme,改为白名单 `(https?|ftp|file|data|blob|mailto|tel|ws|wss|chrome(?:-extension)?|whale-(?:file|extension)):`。**`..` 不在客户端解析**(留给 host 端 `whale-file://` Range handler 处理 allowed-roots 校验,扩展端不重复)。测试覆盖:[md-render.test.ts `resolveRelativeImagePath` suite](../src/extensions/md-editor/md-render.test.ts)(6 case:空/scheme/Unix 绝对/Windows 绝对/相对/无 dirPath)+ `resolveLocalImages` suite(4 case:相对重写 / 无 dirPath no-op / scheme 不动 / 绝对也 encode)。

§18.2.4 **`previewPane.innerHTML = clean` 全量重排** ✅ 已修(2026-07-06 Week 4)— 双层节流:(1) `shouldSkipRender(lastContent, nextContent)` 纯函数在 `renderPreview` 入口短接 — 同内容直接 return,跳过 parse/sanitize/innerHTML 三步;(2) `createRafScheduler()` 工厂把 `innerHTML` 突变对齐到浏览器下一次 repaint,避免 300ms 防抖 fire 撞到 paint 中间。`setContent` 是唯一同步渲染路径,绕过 `shouldSkipRender` + 强制 `lastRenderedContent = null`(新文件即使首字符与上一文件相同也必须重绘)。测试覆盖:[md-render.test.ts `shouldSkipRender` suite](../src/extensions/md-editor/md-render.test.ts)(4 case:首渲染 / 完全相同 / 任意差异 / 空字符串)+ `createRafScheduler` suite(3 case:rAF 触发 / cancel / 合并多次 schedule)。

§18.2.5 **`applyTheme('light')` 写死** ✅ 已修(2026-07-06 Week 4)— 删除 [index.ts `fileContent` 分支](../src/extensions/md-editor/index.ts) 的 `applyTheme('light')`;新增 [md-render.ts `detectInitialTheme()`](../src/extensions/md-editor/md-render.ts) 纯函数读 `window.matchMedia('(prefers-color-scheme: dark)')` 兜底;iframe 启动时调一次 `applyTheme(detectInitialTheme())` 等待 host `setTheme` 消息。host 的 `setTheme` 是 source of truth(`setTheme` 到达后 `applyTheme` 覆盖初始猜测)。**Fallback 链**:`host setTheme` > `matchMedia` 探测 > `'light'`(老浏览器无 matchMedia)。测试覆盖:[md-render.test.ts `detectInitialTheme` suite](../src/extensions/md-editor/md-render.test.ts)(2 case:无 matchMedia 返 light / 正常探测)。

§18.2.6 **`schedulePreview` 缺 token 保护** ✅ 已修(2026-07-06 Week 1,随 §18.1.2)— 现在 `createPreviewScheduler` 工厂内部 `Symbol` token 守卫,旧 schedule 的回调在新 schedule 时被 token 比对失败静默丢弃。无需在 `index.ts` 维护 token 状态。

§18.2.7 **GFM 任务列表 / 删除线默认关闭** ✅ 已修(2026-07-06 Week 4)— **markded v18 默认开启 GFM**(`marked.use({ gfm: true, breaks: false })` 已在 Week 1 的 `Marked` singleton 里配好),task list 跟 strikethrough 都自动生效:**无需代码改动**。`<input type="checkbox">` 走 `USE_PROFILES: { html: true }` 默认放行(ALLOWED_TAGS 白名单只删,profile 默认列表保留),`<del>` 已经在 ALLOWED_TAGS 里。回归测试覆盖:[md-render.test.ts `parseMarkdown — GFM task list + strikethrough` suite](../src/extensions/md-editor/md-render.test.ts)(4 case:unchecked checkbox / checked checkbox / `<del>` strikethrough / 端到端 parse+sanitize 不丢视觉)。

### 18.3 P2 — 锦上添花(6 项)

§18.3.1 **TOC / 大纲侧栏** ✅ 已修(2026-07-07 Week 5;Week 6+ 加 inline markdown 解析)— [md-render.ts `extractToc(markdown)`](../src/extensions/md-editor/md-render.ts) 纯函数从 `md.lexer` token 列表 + 共享的 [`computeBlockLineNumbers`](../src/extensions/md-editor/md-render.ts)(同时被 `parseMarkdown` 用来注 `data-source-line` — TOC id 与 preview 块完美对齐)提取 H1-H6 条目,`{level, text, textHtml, line, id="md-h-{line}-{text.length}"}`;`renderToc(container, entries, onSelect)` 渲染成 240px 侧栏,点击调 `onSelect` 并 `preventDefault` 默认 anchor 跳转;`parseMarkdown` 同步给 heading 标 `id` 跟 TOC 对齐。**关键陷阱**:marked v18 token `.line` 字段是 `undefined`(top-level 块不设),第一版 `extractToc` 用 `h.line ?? 1` 让所有 heading 都报 line=1,scroll 同步退化。修法:用同一套 `computeBlockLineNumbers` 累计 raw 换行数(包含 space token)。

**Week 6+ 增项 — inline markdown 解析**:`text` 字段保留 raw markdown source(因为 `id` 是 `text.length` 派生,要跟 `parseMarkdown` 的 heading `id` 文本长度对齐);新增 `textHtml` 字段,通过 [`marked.parseInline(text)` + `sanitizeMarkdownHtml`](../src/extensions/md-editor/md-render.ts) 产出已经 DOMPurify 净化过的 inline HTML(`**bold**` → `<strong>bold</strong>`,`` `code` `` → `<code>code</code>`,`[link](url)` → `<a href="url">link</a>`);`renderToc` 用 `innerHTML = entry.textHtml`(已净化,安全);XSS 防御(`<script>alert(1)</script>` 注入 heading 会被 DOMPurify strip)。

**Week 6+ 增项 — active heading 高亮**:之前规划用 IntersectionObserver,实际实现走 `syncPreviewScroll` 路径(因为 editor 是唯一真实 scroll 源,`syncPreviewScroll` 已经算出 heading 的 `lineNo`,re-render 时 `renderToc` 接收新参数 `activeLine` 直接给对应 entry 加 `.toc-active`)。零额外 DOM 监听,无 `overflow: hidden` 兼容性顾虑。`[editor.css](../src/extensions/md-editor/editor.css)` 新加 `.toc-active` 样式:蓝色文字 + 加粗 + 左侧 2px 蓝色 accent,深色模式换 `#58a6ff`;`.toc-active:hover` 沿用原有 hover 颜色,无冲突。`index.ts` 的 `setActiveTocLine(line)` 是模块级单点更新(`activeTocLine` 模块变量 + 全表 `querySelectorAll` 一次重置 `.toc-active`),在 `syncPreviewScroll` 命中 H1-H6 时调用,TOC 点击处也调用(让 highlight 立刻跟上去,不依赖后续 scroll event)。**重要边界**:`syncPreviewScroll` 命中非 heading 块(段落 / 代码块)时**不重置** activeTocLine(让 highlight 在长 code block 里不闪烁);ratio fallback 路径同理不动 active 状态。

测试覆盖:`extractToc` 5 case → 7 case(+ inline 渲染 / + XSS 净化)+ `renderToc` 4 case → 7 case(+ textHtml 渲染 / + activeLine 高亮 / + null 不高亮任何)。

§18.3.2 **导出 HTML** ✅ 已修(2026-07-07 Week 5)— [md-render.ts `wrapHtmlDocument(title, bodyHtml)`](../src/extensions/md-editor/md-render.ts) 把 preview HTML 包成完整 `<!DOCTYPE html>` 文档,内置 ~50 行 CSS(GitHub-风格浅色 + dark mode `@media`),`data-source-line` 属性保留(支持回环);`triggerDownload(filename, content, mime)` 创 Blob + `<a download>` + synthetic click + 1s 后 `URL.revokeObjectURL`;工具栏 `⇩ HTML` 按钮调用,文件名 = 当前 path 的 basename 去 `.md`/`.markdown` + `.html`(无 path 时 `untitled.html`)。**PDF 导出**:曾基于 `pdf-lib` 实现过 `exportPreviewAsPdf`(纯文本降级:无图 / 无 mermaid / 无 katex / 表格压文本),后移除(md-editor bundle 减 ~270KB,webpack `dynamicImportMode: 'eager'` 让动态 import 惰性失效,删功能是唯一出路);`pdf-lib` 依赖保留给 `thumbnail.test.ts` 用。测试覆盖:`wrapHtmlDocument` 3 case + `triggerDownload` 1 case(blob URL 生成)。

§18.3.3 **Mermaid / KaTeX** ✅ 已修(2026-07-07 Week 6,Mermaid 部分;KaTeX 留二期)— **架构**:mermaid v11 内部用 `new Function(...)` 动态生成 diagram 渲染函数,需要 `unsafe-eval`。md-editor 主 CSP 保持严格(不放宽),改为**沙箱 iframe 隔离**:
- [src/extensions/md-editor/mermaid-sandbox.html](../src/extensions/md-editor/mermaid-sandbox.html) 独立 CSP(`script-src 'self' 'unsafe-eval' 'unsafe-inline'`)只允许 mermaid 跑的 eval,**不**影响主 iframe
- 主 iframe 用 `<iframe sandbox="allow-scripts" src="mermaid-sandbox.html">`(无 `allow-same-origin`)创建沙箱 — mermaid 跑代码但拿不到父 DOM / cookies / localStorage
- [src/extensions/md-editor/md-sandbox.ts](../src/extensions/md-editor/md-sandbox.ts) `createMermaidSandbox({src, mount})` 工厂 + postMessage 协议:`{type:'render', id, source}` ↔ `{type:'rendered', id, svg}` / `{type:'error', id, message}`,**安全检查** `e.source === iframe.contentWindow` 拒伪造响应
- [src/extensions/md-editor/md-render.ts `renderMermaid`](../src/extensions/md-editor/md-render.ts) 走沙箱路径:每个 `<pre><code class="language-mermaid">` 建占位 div + 发 render RPC,SVG 回来后 `innerHTML = svg`,失败回退原始 source + red border `.mermaid-error`
- **Build 改动**:[scripts/build-extensions.js](../scripts/build-extensions.js) 加 md-editor 分支 copy `node_modules/mermaid/dist/mermaid.min.js` 到 dist(必须 copy 不能 bundle,sandbox 静态 `<script src>` 加载)
- **Bundle 影响**:`bundle.js` 从 4.1MB(内联 mermaid)降回 865KB,沙箱按需加载 mermaid.min.js 3.4MB

**Upstream mermaid IIFE 缺陷补丁**(Week 6 fix):mermaid 11.16.0 的 IIFE bundle 第 1 行是 `var __esbuild_esm_mermaid_nm;`(**undefined**,不是赋值),紧跟 `(__esbuild_esm_mermaid_nm||={}).mermaid=(()=>{…})();` — 因为左值是 undefined,`|| {}` 走右侧新建一个**临时** `{}`,IIFE 结果赋到这个临时对象上就被 GC 了。最后一行 `globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;` 读 `globalThis.__esbuild_esm_mermaid_nm` 还是 undefined,直接抛 `Cannot read properties of undefined (reading 'mermaid')`,`window.mermaid` 永远不存在,沙箱里每张图都 8s 超时。**修法**:`scripts/build-extensions.js` 在 copy 之后立刻用 `String.prototype.replace` 把 `var __esbuild_esm_mermaid_nm;` 换成 `var __esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm = {};` — 同一个 `{}` 既是脚本局部变量也是 `globalThis` 命名空间,`||{}` 短路跳过临时对象,IIFE 结果挂到命名空间上,最后一行能读到。**回归测试**:`scripts/mermaid-iife-patch.test.ts` 3 case — dist artifact 存在 / 含 patched 前缀 / 不含 broken 前缀,挂在 npm test 上游 mermaid 哪天修了就把 `build-extensions.js` 的 patch 分支去掉。

**postMessage race-condition 修复**(Week 6 fix):修了上游 IIFE 之后沙箱确实能跑 mermaid,但每张图第一帧仍然挂死。**根因**:`mermaid-sandbox.html` 把 `window.addEventListener('message', ...)` 放在 `ready()` 内部,只有 `window.mermaid` 定义完之后才挂上 listener。父侧 `renderMermaid` 是 `await getSandbox()` 拿到 sandbox 后立刻对每块调 `sb.render(id, source)`,后者**同步**触发 `iframe.contentWindow.postMessage({type:'render', id, source}, '*')`。这 7 条 message 到达 iframe 的 window 时,listener 还没装(因为 `ready()` 还要等 mermaid.min.js 解析完才会运行),window 的 message event dispatch 到 no handler,**静默丢弃**(DOM `message` 事件不重放已派发过的任务)。**修法**:1) `md-sandbox.ts` `render()` 改成把 `pending.set` 同步做,但 `iframe.contentWindow.postMessage` 推迟到 `ready.then(...)` 回调里发 — 主修复,保证消息只在 sandbox 启动后才发出;2) `[mermaid-sandbox.html](../src/extensions/md-editor/mermaid-sandbox.html)` 加 `earlyBridge` listener + `earlyMessages` 队列兜底 — listener 装上后 `dispatchEvent` 把积压的 message 同步重放一次,纵深防御。两条任意一条就够,两条都上保证未来任何回归都接得住。**回归测试**:`md-sandbox.test.ts` 3 case — mock `document.createElement('iframe')` + 跟踪 `postMessage` 调用,断言 1) `render()` 调用时 postMessage 计数 = 0;2) sandbox ready 后所有 pre-ready 排队的 render 一次性 fire 出去;3) `destroy()` 时未决 RPC 全部 reject。

**`getSandbox()` 并发 race 修复**(Week 6+ fix):`getSandbox()` 原来用 `if (sandbox) return sandbox;`(检查的是已经 resolved 后的 `sandbox` 变量,不是 in-flight Promise),两个 caller 同时 await 时都看到 `sandbox === null`,都 await dynamic import,都 `createMermaidSandbox`,第二个的 iframe 把第一个的覆盖,第一个 iframe 漏在 `document.body` 里整个 session。**修法**:把缓存从 `sandbox` 改成 `sandboxPromise`(in-flight Promise),第一次 caller 立刻存 in-flight promise,后续 caller 直接复用。`_resetSandboxForTest()` 测试钩子加 destroy + ready.catch(()=>{}) 兜底,避免 teardown 时 5s readyTimeout 触发 unhandledRejection 把 test runner 拖黑。**回归测试**:`md-sandbox.test.ts` 2 case — 计数 `document.createElement('iframe')` 调用次数,1) 两次并发 `_getSandboxForTest` mount 数 = 1;2) 第一次 resolve 后再调,mount 数仍 = 1。

**Mermaid 配置**: `securityLevel: 'loose'`(mermaid v11 默认),允许 clickable node labels — 风险锁在沙箱里;`startOnLoad: false`(手动 trigger)+ `theme: 'default'`。

**测试**:`extractMermaidBlocks` 5 case(空 / language-mermaid / 裸 mermaid / 多块保序 / 缩进保留),全过;`scripts/mermaid-iife-patch.test.ts` 3 case。沙箱协议层测试被 auto-mode 拒绝创建新文件 — 用 `Test/mermaid-demo.md` 手动验证(7 种 diagram 类型 + 1 错误注入 + js 块不误捕 + 图片不干扰)。

**KaTeX ✅ 已修(2026-07-14)**:同 mermaid 沙箱思路——独立 `katex-sandbox.html` + `katex-sandbox.ts`(`sandbox="allow-scripts"` 无 `allow-same-origin`),父侧 `renderKatex` 找 `.katex[data-katex-source]` 占位 → postMessage LaTeX → 沙箱 `katex.renderToString` → 回传 HTML 替换。marked 扩展(`katexInline` `$…$` / `katexBlock` `$$…$$`)产占位,DOMPurify 放行(`data-*` 默认允许 + `span`/`div`/`class` 在白名单)。**关键 bug(本次修)**:沙箱 CSP 漏了 `script-src 'unsafe-inline'`——katex 本身是纯 JS 不需要 `unsafe-eval`(正确省略),但**沙箱自己的内联 `<script>`(ready 轮询 + message listener)需要 `'unsafe-inline'` 才能跑**;漏了 → 内联胶水被 CSP 拦 → `ready()` 永不执行 → 父侧 5s 超时 → 公式不渲染(对照 mermaid 沙箱 CSP 有 `'unsafe-inline'`)。修法:`katex-sandbox.html` 的 `script-src` 加 `'unsafe-inline'`(仍不带 `'unsafe-eval'`,比 mermaid 沙箱更严)。顺带清掉 `renderKatex` 里排查此 bug 的 debug `console.log`。**第二个 bug(字体 404)**:`build-extensions.js` 只 copy 了 `katex.min.js`/`.css`,**漏了 `fonts/`(60 个 .woff2/.woff/.ttf)** → `katex.min.css` 引用的 `fonts/KaTeX_*` 全 404 → 公式渲染但用 fallback 字体(无数学斜体/尺寸字体)。修法:`build-extensions.js` md-editor 分支加 `fs.cpSync(node_modules/katex/dist/fonts, dist/fonts, {recursive:true})`;主 iframe CSP 无需改(字体同源,`default-src 'self'` 放行)。验证:`md-render.test.ts` 115/115;dist CSP 含 `'unsafe-inline'`;dist `fonts/` 60 文件齐。

§18.3.4 **persist font-size / wrap mode** ✅ 已修(2026-07-06 Week 3 工具栏)— Week 3 #6 工具栏改造时已经实现,localStorage key 用 `md-editor-font-size` + `md-editor-wrap-mode`(`md-editor-` 前缀避免与 text-editor 冲突),`clampFontSize` 范围 10-32。见 [docs/09 §18.2.1](./09-known-issues.md)。

§18.3.5 **撤销/重做指示 + "Modified" 角标** ✅ 已修(2026-07-07 Week 5 Modified 角标 + Week 6+ undo/redo)— **Modified 角标**:状态栏右侧 `#status-dirty` 元素(orange ● + "Modified" 文字),模块级 `isDirty` 标志 + `updateListener` docChanged 置 true / `savingFile` 消息置 false / `setContent` 置 false。**Undo/Redo 指示**:状态栏右侧新增 `#status-undo` / `#status-redo`(↶/↷ 前缀的灰/橙小色块),通过 `view.state.field(historyField)` 读 [`@codemirror/commands` history()](https://codemirror.net/docs/ref/#commands.history) 的 `undoStack` / `redoStack` 长度 → toggle `hidden` 属性。`updateStatus` 在 updateListener 里顺手 patch(zero-cost)。**Flash 反馈**:显式 `keymap.of([{key: 'Mod-z', run: undo + flash}, {key: 'Mod-Shift-z', run: redo + flash}, {key: 'Mod-y', run: redo + flash}])` 排在 `defaultKeymap` **之前**(CodeMirror keymap 是 first-match-wins),所以 Cmd+Z 永远走我们的 wrapper。Wrapper 调 `undo(view)` / `redo(view)` 然后给 indicator 加 250ms `.status-flash` 类(颜色变橙 + 加粗),给按键一个**视觉反馈**,因为 `hidden` 已经表达了"能不能 undo/redo"的状态,flash 只对"刚按了"事件做确认。**重要细节**:Windows / Linux 习惯 `Ctrl+Y` redo,我们也注册了 Mod-y 绑定,Mac 用 Cmd+Shift+Z。

§18.3.6 **阅读时长 / 字数实时统计** ✅ 已修(2026-07-07 Week 5,字数部分 + 阅读时长)— 字数已在 Week 3 #7 状态栏 `Words` 字段落地;阅读时长新加 [md-render.ts `estimateReadingMinutes(text)`](../src/extensions/md-editor/md-render.ts),CJK-aware:英文 ~200 wpm,CJK ~400 cpm(`cjkChars / 400 + englishWords / 200`),`englishWords = countWords - cjkRuns`(减 CJK **runs** 而不是 chars,因为 `countWords` 把无空白的 CJK 段当 1 word)。空文档返 0,非空至少 1 min(避免 "0 min" 尴尬)。状态栏 `Words` 字段 `title` 属性显示 "N min read"。CJK 按 1.5 词数计的旧方案放弃 — 用字符数 + 速度常数更直接。测试覆盖:`estimateReadingMinutes` 6 case(空 / 极短 / 非空至少 1 / 200/400 词 / CJK / 混合)。

### 18.4 代码质量 & 安全(4 项)

§18.4.1 **DOMPurify `style` 白名单太宽** ✅ 已修(2026-07-06 Week 1)— 拆到 [md-render.ts:65-114](../src/extensions/md-editor/md-render.ts) 的 `DOMPURIFY_CONFIG` 之后,`ALLOWED_ATTR` 数组移除 `'style'`,**并加 `FORBID_ATTR: ['style']` belt-and-suspenders**(因 `USE_PROFILES: { html: true }` 默认 profile 放行 `style`,单删 `ALLOWED_ATTR` 不足以保证 strip)。回归测试覆盖:[md-render.test.ts:67-110](../src/extensions/md-editor/md-render.test.ts)(4 case:style 实际被 strip / `ALLOWED_ATTR` 不含 style / `FORBID_ATTR` 含 style / 其他安全 attr 仍放行)。

§18.4.2 **`renderPreview` 内重复绑定 click listener** ✅ 已修(2026-07-06 Week 1)— 抽出 [md-render.ts:143-178](../src/extensions/md-editor/md-render.ts) 的 `setupLinkDelegation(previewEl, handler)`,在 `index.ts` 顶层一次性调用,`renderPreview` 不再 per-render `querySelectorAll('a') + addEventListener`。事件委托用 `target.closest('a')` 走捕获链,handle 无 `href` 的 `<a>` 自动跳过,`e.preventDefault()` 仍调。返回 unbind 闭包便于测试与热重载。回归测试覆盖:[md-render.test.ts:113-198](../src/extensions/md-editor/md-render.test.ts)(7 case:直接 `<a>` / 嵌套 `<span>` / `innerHTML` 替换存活 / 非 `<a>` 不触发 / 无 `href` 跳过 / unbind 生效 / `preventDefault`)。

§18.4.3 **CSP `style-src 'unsafe-inline'`** 🟡 待修(Week 6 试收紧 → 回滚)— 主页 [index.html:7](../src/extensions/md-editor/index.html) 的 CSP `style-src` **必须保留** `'unsafe-inline'`,**不能收紧**。**原因**:mermaid v11 的 SVG 输出包含两类会被严格 CSP 拦截的内容:1) `<svg style="max-width: 116px;">` 属性(控制 SVG 容器宽度,丢了会让 SVG 撑爆 preview);2) `<style>#mermaid-id{font-family:...; @keyframes edge-animation-frame{...}}</style>` 内嵌块(图内动画 + 字体,丢了 SVG 会变成默认字体 + 动画不工作)。SVG 在 `[mermaid-sandbox.html](../src/extensions/md-editor/mermaid-sandbox.html) 沙箱内渲染`,但 SVG 字符串通过 `parent.postMessage` 传到父 iframe 后,**通过 `div.innerHTML = svg` 注入到主预览窗**([md-render.ts:1057](../src/extensions/md-editor/md-render.ts)),这时主 CSP 的 `style-src` 才生效,沙箱的 `'unsafe-inline'` 帮不到。**Week 6 尝试过收紧**:`'unsafe-inline'` 拿掉,DevTools 立刻刷一堆 CSP violation + mermaid SVG 失字体/动画/`max-width` → preview 溢出(没有 max-width) → 用户感觉"滚轮没了/页面崩了"。**结论**:这是 mermaid 输出的硬约束,除非改 mermaid 输出方式(不现实)或 strip 掉 style(破坏渲染),主页 `style-src 'unsafe-inline'` 必须留。**留待二期的可能思路**:换成 `style-src-elem 'self'` + `style-src-attr 'unsafe-inline'`(只允许 style 属性,不允许 `<style>` 块 — 但 mermaid 两者都用了,可能不够),或者用 nonce 注入自定义 css 替换 mermaid 内置样式。

§18.4.4 **`applyTheme` 接受 `'light' | 'dark'`,host 端可能错传 `'system'`** ✅ 已修(2026-07-07 Week 5)— 扩展 [index.ts `applyTheme`](../src/extensions/md-editor/index.ts) 签名为 `'light' | 'dark' | 'system'`,`'system'` 走 `detectInitialTheme()` 解析;加 `assertNever(x: never)` 防御性守卫,任何超出 union 的值(类型系统绕过的 `any` cast / JSON 反序列化路径)会 runtime 抛错 + 明确错误消息("md-editor: unexpected theme value: X"),防止 host bug 静默退化到 light 主题。

### 18.5 推荐落地顺序(摘录自 §4.1)

| 周次 | 任务 |
|---|---|
| 1 | §18.1.2(timeout 竞态) + §18.4.2(事件委托) + §18.4.1(DOMPurify 收紧) + §18.1.5(加测试) ✅ |
| 2 | §18.1.1(splitter 拖拽) + §18.1.3(滚动同步精确化) + §18.1.4(代码块高亮) ✅ |
| 3 | §18.2.1(工具栏) + §18.2.2(状态栏) + §18.2.3(本地图片 + `FileContentMessage.dirPath` 协议扩展) ✅ |
| 4 | §18.2.5(theme 写死) + §18.2.4(innerHTML 节流) + §18.2.7(GFM) ✅ |
| 5+ | §18.3.1–6 (TOC/导出/Mermaid/PDF/persist) + §18.4.3 / §18.4.4(Week 5 完成 §18.3.1 / §18.3.2 / §18.3.4 / §18.3.5 / §18.3.6 / §18.4.4;Week 6 完成 §18.3.3 Mermaid 沙箱) ✅ |

**前置依赖**:§18.2.3 本地图片修复需要 host 端 `FileContentMessage` 透传 `dirPath`,需扩展 [src/shared/extension-types.ts](../src/shared/extension-types.ts) —— 该协议变更影响所有编辑器扩展(影响面:17 个扩展,需同步评估),建议单独起 commit 而非混在 md-editor PR 里。

**Week 1 改造附带交付**:
- [src/extensions/md-editor/md-render.ts](../src/extensions/md-editor/md-render.ts)(239 行):`parseMarkdown` / `sanitizeMarkdownHtml` / `DOMPURIFY_CONFIG` / `setupLinkDelegation` / `createPreviewScheduler` 五个纯函数
- [src/extensions/md-editor/md-render.test.ts](../src/extensions/md-editor/md-render.test.ts)(323 行,23 case):镜像 [text-editor/editor-stats.test.ts](../src/extensions/text-editor/editor-stats.test.ts) 模式,DOMPurify 部分用 `global-jsdom@29` 注入 `globalThis.window`(工厂在 lazy resolve 时读)
- `index.ts` 从 273 行降到 244 行(去掉 DOMPurify 重复白名单 + click listener 循环),新逻辑全部走 `md-render.ts` 工厂函数

**Week 2 改造附带交付**:
- [src/extensions/md-editor/md-splitter.ts](../src/extensions/md-editor/md-splitter.ts)(182 行,新增):`setupSplitter({editorPane, previewPane, splitter, container})` 工厂 + `SplitterHandle` 接口(setRatio / reset / getRatio / destroy)
- [src/extensions/md-editor/md-splitter.test.ts](../src/extensions/md-editor/md-splitter.test.ts)(15 case,新增):默认 50% / 存储加载 / 越界 clamp / 垃圾值回退 / 鼠标拖拽 / MIN/MAX 边界 clamp / 中右键忽略 / 双击重置 / setRatio / reset / 键盘 nudge / Home/End / destroy / a11y
- `md-render.ts` Week 2 增项:`parseMarkdown` 注入 `data-source-line` 属性(用 `Marked` singleton + `md.lexer` + 累计 space token 换行数);`highlightCodeBlocks(container)` 包装 `hljs.highlightElement`;`md-render.test.ts` 增 4 case(基础行号 / 跨块累加 / 全元素覆盖 / 嵌套不污染)+ 4 case(高亮 JS / 无语言 graceful / 多块独立)
- `index.ts` Week 2 改造:`syncPreviewScroll` 重写为 `lineBlockAtHeight` + `data-source-line` querySelector(无 match 回退比例);`renderPreview` 在 innerHTML 后调 `highlightCodeBlocks`;`setupSplitter` 顶层 wire
- 新增 dep `highlight.js@^11.11.1`(~50KB gzip,common 35 语言)入 [package.json:78](../package.json)
- `editor.css` Week 2 增 ~200 行:GitHub + GitHub-Dark hljs 主题(轻量子集,主流 token class)+ splitter hover/drag/focus CSS 钩子

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

**问题 A — 测试脚本漏跑**:`package.json` 的 `test` 曾是硬编码 91 个文件的手维护列表。实测磁盘 98 个 `.test.ts(x)`,**8 个从未跑过**(含 [EntryContextMenu.test.tsx](../src/renderer/components/EntryContextMenu.test.tsx) / [PeriodTagDialog.test.tsx](../src/renderer/components/PeriodTagDialog.test.tsx) / gantt hooks / [locations.test.ts](../src/renderer/reducers/locations.test.ts) / [migrate-date-tags.test.ts](../src/main/migrate-date-tags.test.ts) / 2 个 drawio 脚本测试),外加 1 个幽灵条目指向不存在的 `text-viewer/text-stats.test.ts`。[TaskView.test.tsx](../src/renderer/components/TaskView.test.tsx) 虽在列表里但 12 个 case 全失败(缺 `IOActionsContextProvider` 包裹),`npm test` 一直是红的 —— 只是没被当硬闸门。

**修复**:[scripts/run-tests.cjs](../scripts/run-tests.cjs) 用 glob 自动发现 `src` + `scripts` 下全部测试交给 `electron --test`,新增测试无需改 package.json。补全 2 个测试文件的 provider 包裹(对照一直绿着的 [KanbanView.test.tsx](../src/renderer/components/KanbanView.test.tsx))。全套从"红"修到 **1702 绿**(每批加测试递增)。

**问题 B — 构建全链路不做类型检查**:所有 `build:*` 带 `TS_NODE_TRANSPILE_ONLY` + ts-loader `transpileOnly`,无 CI、无 pretest 钩子。[src/main/ai/prompt.ts](../src/main/ai/prompt.ts) 有个类型导入路径错(`../../../shared/whale-meta`,多一层 `../`),运行时是 type-position 被擦除所以不崩,但 `tsc` 报错 —— 被 transpileOnly 掩盖已久。

**修复**:加 `"pretest": "npm run type-check"`。`npm test` 先跑 `tsc --noEmit` 再跑测试;修了 prompt.ts 路径。之后 #11 加 `markExifProcessedMany` 时,pretest 当场抓到漏改 `WhaleApi` 接口([ipc-types.ts](../src/shared/ipc-types.ts)),避免了带病上线。

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

## 22. AI `allowDangerouslySkipPermissions` 常开 → SDK shadow canUseTool → 授权弹窗不弹 + MCP 工具空字段 deny 抛错 (2026-07-10)

**症状**:normal/plan 模式下让 AI 调一个需要授权的工具(如 MCP 的 `mmx`),授权弹窗**根本不弹**(`ApprovalModal` 没机会出现),工具直接走 CLI 自己的 bypass 路径,对未预批准的 MCP 工具返回一个**空字段的 deny**,SDK 校验器抛错。dev 日志里有 SDK 警告:

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked:
permissionMode 'bypassPermissions' auto-approves every tool call
(except explicit deny rules) before the callback is consulted.
```

**根因**:[buildQueryOptions.ts](../src/main/ai/providers/claude/buildQueryOptions.ts) 曾对**所有**权限模式(normal/plan/yolo)都设 `allowDangerouslySkipPermissions: true`。这个 flag 是 SDK 启用 `bypassPermissions` 的开关——设了它,SDK **强制 bypassPermissions**(即使 Whale 请求的是 `'default'`/`'plan'`),于是 `canUseTool` 被 **shadow**(永不调用)→ 弹窗不弹 → 工具落进 CLI bypass 路径 → 空字段 deny → 校验器抛错。

**修复**:`allowDangerouslySkipPermissions` 只在 `'yolo'` 模式设(`settings.permissionMode === 'yolo'`)。normal/plan 不设 → SDK 尊重 `permissionMode: 'default'`/`'plan'` → **咨询 `canUseTool`** → Whale 弹窗出现 + 决定。

**教训**:`canUseTool` 是 SDK 在**非 bypass 模式**下的闸门;`allowDangerouslySkipPermissions` 只是 bypass 的**启用开关**,绝不能在 normal/plan 开(开了就把 `canUseTool` 整个废掉,且无编译/类型错误——只有真跑 AI 工具调用才暴露)。和 §19/§21 同类:协议层配置坑,smoke test 验证不可省。详见 [docs/11 §5](./11-ai.md)。

## 23. AI 流式回复 thinking/text 重复 — CLI uuid 每行随机,uuid 去重整体失效 (2026-07-11 发现,2026-07-18 确诊修复)

**症状**:Claude CLI provider 的回复里,**1 个 assistant 气泡内出现两段一模一样的思考(thinking)块**;修好 thinking 后,**两段一模一样的正文(text)**浮出。partial 流(token by token)累积成一段,complete 消息又原样发一段。yolo / normal 模式均可复现。

**根因(2026-07-18 实跑 CLI 抓 stream-json 确诊)**:直接跑 `claude.exe -p "..." --output-format stream-json --include-partial-messages --verbose` 抓输出(比 app 内加 log 干净),发现 **每一行(每条 `stream_event` / `assistant`)都带一个全新的随机 uuid** —— 不止 partial 与 complete 不匹配,partial 之间也互不相同。因此 [transformSdkMessage.ts](../src/main/ai/providers/claude/stream/transformSdkMessage.ts) 依赖 `message.uuid` 的 `startedMsgs`/`streamedMsgs` 去重**整体失效**:complete 的 uuid 永远查不到 → text/thinking 重发一遍;complete 还因 `startedMsgs` miss 再 yield 一个 `assistant_message_start` → **空气泡**。2026-07-11 观察到"只 1 个气泡"是当时旧版 CLI:`message_start` 与 complete 共享 uuid、delta 不共享 —— 所以 `startedMsgs` 半生效、`streamedMsgs` 失效;新版 CLI 改全行随机后还会多一个空气泡。subagent 文本同病且当时的 boolean 兜底没覆盖(parent 分支不置标志)→ 重复。

抓包同时证实两条之前未知的 wire 事实:

1. **complete `assistant` 在某块的 delta 流完即发出,早于该块的 `content_block_stop`**;且一条 API 消息可拆成**多个非累积 complete**(如 `[thinking]` 再 `[tool_use]`)。
2. 块的完整文本 = 其 delta 拼接,**逐字节相等**(thinking 81 字符、text 4 字符实测一致);tool_use 块 id(`call_*`)在 stream 与 complete 间稳定。**这些才是真正的去重键,uuid 不是**。

**修复(2026-07-18)**:transformSdkMessage 重写,删 `startedMsgs` / `streamedMsgs` / `thinkingStreamed` / `textStreamed`(boolean 兜底一并移除):

- **per-scope flow 状态机**:scope = `parent_tool_use_id`(顶层 `''`;subagent 流与顶层交错,各持一份);`message_start` 开新 flow;`bubbleOpen` 保证一条 API 消息只开一个气泡(没收到 `message_start` 时 complete 自己开 —— recovery 路径)。
- **text/thinking 按内容精确匹配去重**:delta 按块 index 累积(`flow.acc`),complete 块与在途累积 + 已展示池(`flow.shown`)做**全串精确匹配**(非子串,无歧义),命中跳过;`content_block_stop` 把累积落进 shown;complete 发出的块也入 shown(防累积式 complete 重发)。已知取舍:同一 API 消息里两个**内容完全相同**的 text 块,complete 回声会坍缩(流式路径两块本身都正常显示,complete 不再多加)。
- **tool_use 按稳定块 id 双向去重**:complete 先到(常见,见 wire 事实 1)则发 complete 版(顺带拿到完整解析好的 input)并删掉 pending 组装,stop 到时不再重发;stop 先到则 `emittedToolIds` 挡 complete。
- `toolBlocks` 键从块 index 改为 `${scope}:${index}`(并行 subagent 同 index 不互撞)。

**测试**:6 个真实 wire-shape 回归用例(逐行随机 uuid / 分裂 complete / complete 早于 stop / 无 stream 的 recovery / 累积重复 / subagent 不同 uuid)+ 原 12 个全过;两份真实抓包 JSONL 逐 chunk 回放校验正确。

**遗留**:无。boolean 兜底已删,uuid 不再用作任何去重键(仅作气泡 `itemId` 展示标识,每行唯一即可)。

**教训**:
- 流式协议里"partial + complete"去重必须**实测验证**——光看代码"complete 检查 streamed 跳过"会以为没问题,但 uuid 匹配是隐含前提,SDK 内部 id 体系不一致就**静默失效**(无报错、无类型错,只有 UI 重复)。
- **别把对端协议的 id 语义当契约**:CLI 的 uuid 是"每行一个"还是"每条消息一个"没有文档承诺,版本间还变过(旧版 message_start 与 complete 共享,新版全行随机);去重键要用有内容语义的字段(块文本 / 工具 id)。
- dev 热重载(electronmon)在 Windows 的进程清理是独立坑(与 §1 `ELECTRON_RUN_AS_NODE` 同类 dev 黑魔法):诊断流式问题绕开 watch,直接跑 CLI 二进制抓 stream-json 输出,比 app 内加 log 更快更干净。

**关联**:[docs/11 §4 流式与渲染](./11-ai.md)。

## 24. 自定义命令:Windows 路径含 `%` 被拒(2026-07-12)

**症状**:右键一个文件名含 `%` 的文件(如 `data%20file.csv`)→ "命令" 子菜单跑用户命令 → toast `commandPathBlocked`,命令不运行。

**根因**(设计取舍,非 bug):cmd.exe 默认下,双引号 `"..."` 内的 `%VAR%` 仍会展开成环境变量(如 `%PATH%`)。`%%` 转义**只在 .bat 批处理内有效**,`cmd /k "<cmd>"` 单条命令内无法可靠转义 `%`。文件名里的 `%` 因此可能注入环境变量内容 → 命令注入面。

**处理**:[runUserCommand](../src/main/shell-command.ts) 在替换前检测 `targetPath.includes('%')` → 直接拒,renderer 映射到 `commandPathBlocked` 文案。`!`(cmd 默认 delayed expansion 关)放行。99.99% 文件名不含 `%`。用户解法:重命名文件去掉 `%`,或改用不含 `${path}` 的命令。

**通用教训**:任何"用户模板 + 文件路径替换进 cmd"的功能,`%` 是 cmd 引号套不住的唯一元字符 —— 要么拒(当前方案)、要么改走 PowerShell(`psQuote` 单引号全安全,见 [fs-write.ts runOsZip](../src/main/ipc/fs-write.ts))、要么写临时 .bat(批处理内 `%%` 生效)。详见 [docs/13 §11](./13-security.md)。

---

## 25. utilityProcess 子进程:`parentPort` 在 `process` 上不在 `electron` 导出上;且 fork 能直读 app.asar(2026-07-13,P0-2 索引迁出主进程)

**症状**:P0-2 把 SQLite / FTS5 / EXIF 管线迁进 `utilityProcess`([index-worker.ts](../src/main/index-worker.ts)),type-check 过、dev 不报错,但 worker **一启动就 `exit code 1`**,所有 `index:*` / `fulltext:*` / `exif:*` IPC 全 reject「index worker exited unexpectedly」。dev 没被发现是因为 worker 惰性 spawn(首次索引请求才拉起)。

**根因(三个独立坑,前两个打包才触发,第三个 dev 才触发)**:

1. **`parentPort` 取错地方**:`index-worker.ts` 写 `import { parentPort } from 'electron'`。但 Electron 42 的 utilityProcess 子进程里 `parentPort` **只在 `process.parentPort` 上**;`require('electron').parentPort` 运行时是 `undefined`(Electron 的 `.d.ts` 把类型挂在 electron 导出上 → TS 不报错,值却不在)→ `if (!parentPort) throw` → 启动即崩。探针实证:`{ hasProcessParentPort: true, hasElectronParentPort: false }`。
2. **`utilityProcess.fork` 能直读 asar**(P0-1):`index-worker-spawn.ts` 误把 [docs/14 §5](./14-packaging.md) 的「外部 node 读不了 asar」教训套到 utilityProcess 上,做了 `app.asar → app.asar.unpacked` 重写。但 utilityProcess 是 Electron 原生进程、asar 感知(不同于 `child_process.fork`,见 electron#2708);而 worker entry **不在 `asarUnpack`**(只原生 node_modules 解包了)→ 重写后路径不存在 → 打包版 fork ENOENT。dev 无 asar,不触发。
3. **dev 下 `app.getAppPath()` 是项目根**(第 3 个坑,dev 冒烟才发现):原 `index-worker-spawn.ts` 用 `path.join(app.getAppPath(), 'dist', 'main', ...)` 拼 worker 路径。打包时 `getAppPath()` = `app.asar`,拼出来对;但 **dev(electronmon 跑 `.`)`getAppPath()` 返回项目根 `c:\WhaleTag`**,拼出 `c:\WhaleTag\dist\main\index-worker.js`(不存在,真文件在 `release/app/dist/main/`)→ dev fork `ERR_MODULE_NOT_FOUND`。打包不触发。

**修复**:
- [index-worker.ts](../src/main/index-worker.ts):`import { parentPort } from 'electron'` → `const parentPort = process.parentPort`(主进程里 `process.parentPort` 为 `null`,守卫仍挡得住误从主进程加载)。
- [index-worker-spawn.ts](../src/main/index-worker-spawn.ts):**锚定 `__dirname`**(worker 和 main.js 同目录;webpack `node.__dirname:false` dev+prod 都开着 → dev=`release/app/dist/main`、打包=`app.asar/dist/main` 都对),不再用 `app.getAppPath()`;同时删掉 asar 重写(fork 直读 app.asar)。
- [index-db.ts](../src/main/index-db.ts) 生产守卫同样用 `!process.parentPort`(Electron 类型:非 utility 进程为 `null`,不是 `undefined`)。

**冒烟验证**:打包版 `utilityProcess.fork('…/app.asar/dist/main/index-worker.js')` → `ready` → `index:status` / `index:build` 往返 OK(`better-sqlite3` 从 app.asar 正常加载);dev 版 fork `release/app/dist/main/index-worker.js` 同样 OK。三个坑 type-check 全过、dev 只触发第 3 个、打包只触发前两个。

**通用教训**:
- utilityProcess 子进程的 parent port 用 `process.parentPort`,**不要** `import from 'electron'`——类型在、运行时值不在。Electron 类型声明误导的高发区。
- `utilityProcess.fork`(Electron 原生)≠ `child_process.fork`(纯 Node)。前者 asar 感知,后者读不了 asar(electron#2708)。docs/14 §5 的 asar 重写只对外部 node 子进程成立。
- **`app.getAppPath()` 在 dev 和打包返回值不同**(dev = 启动目录/项目根,打包 = `app.asar`)。要拿「和 main.js 同目录的文件」,锚定 `__dirname`(前提 webpack `node.__dirname:false`),别用 `getAppPath()` 拼。
- utilityProcess / 打包相关改动,type-check 发现不了;dev 和打包各自的坑只有各自冒烟才暴露。**`npm run dev` 触发一次索引 + `npm run package` fork 冒烟,两个都要做**。详见 [docs/15 P0-2](./15-perf-audit.md)。

## 26. 启动时序:主进程 bootstrap 早于渲染层 roots 推送,启动迁移静默空跑(2026-07-18)

**症状**:`wsd.json` / `wsm.json` 里的老前缀日期标签(`today-YYYYMMDD` 等)在生产环境从未被迁移;启动日志恒为 `scanned=0 migrated=0`。

**根因**:`bootstrap()` 在 `createWindow()` **之前**调 `runMigration(getAllowedRoots())`(原 [main.ts](../src/main/main.ts)),而 allowedRoots 只能由渲染层挂载后经 `fs:setAllowedRoots` 推送([Root.tsx](../src/renderer/containers/Root.tsx) → [fs-roots.ts](../src/main/ipc/fs-roots.ts))—— 启动时集合必为空,`runMigration` 对空数组直接 early-return。type-check / 单测全绿(单测直接传 roots 调 `runMigration`,不经启动路径),只有全链路审阅才暴露。

**修复**:触发点移到 `fs:setAllowedRoots` handler —— 首次**非空**推送时 `triggerStartupMigration(getAllowedRoots())`([migrate-date-tags.ts](../src/main/migrate-date-tags.ts));模块级 once-guard 防后续 location 增删的重推送重跑,空推送不消耗 guard(渲染层 rehydration 前可能先推一次 `[]`)。

**教训**:主进程 `bootstrap()` 里任何依赖**渲染层推送状态**(allowedRoots / settings)的逻辑,启动时拿到的都是初始空值 —— 这类"启动即跑"的任务必须挂到首次推送之后,或像 `TaskReminder` 那样 `waitForAllowedRoots()`。详见 [docs/03 §11](./03-tagging.md)。

## 27. console.* 写死管道 → EPIPE 未捕获异常(2026-07-19)

**症状**:dev 长时间运行 + electronmon 多轮重启后,打开地图视角触发 `Uncaught Exception: EPIPE: broken pipe, write`,栈顶停在 `extractGps` 的 `console.debug`。

**根因**:主进程 `console.*` 写的是父进程(electronmon / concurrently)持有的 stdout/stderr 管道;父进程死了管道即断 —— dev 多实例堆积(docs/01 §8)时必现。此后任何一次 console 写入都 EPIPE 并冒成未捕获异常。地图视角只是触发点:它给每张图调 `extractGps`,而该函数每张图打一条 debug 日志。

**修复**:① [exif.ts](../src/main/exif.ts) 删掉两条 per-file `console.debug`(批量扫描下本来就是刷屏);② [main.ts](../src/main/main.ts) 顶部加全局 EPIPE 守卫 —— `process.stdout/stderr.on('error')` 只吞 EPIPE、其余上抛;GUI 应用丢日志好过崩溃。

**教训**:主进程任何 `console.*`(含 `process.stdout.write` 直写)都是潜在 EPIPE 崩溃点;per-file 调试日志不进库。清场重启(docs/01 §8)只缓解,守卫才是根治。

## 28. 组件在 hooks 之前 early-return → 条件态切换时 hooks 数变化,React 整树崩溃(2026-07-22)

**症状**:Kanban 视角打开 `WorkflowManagerDialog` 删掉最后一个阶段(或反过来,空阶段配置下新增首个),整个视角被 ErrorBoundary 接管,报 `Rendered fewer hooks than expected`。

**根因**:[KanbanView.tsx](../src/renderer/components/KanbanView.tsx) 的 `if (stages.length === 0) return <空态/>` 写在全部 `useMemo`/`useState`/`useCallback` **之前**;`stages.length` 0↔N 切换改变 hooks 数,违反 Rules of Hooks。

**修复**:空态 return 移到所有 hooks 之后(空态下 `WorkflowManagerDialog` 保持挂载,用户可就地补回阶段);回归测试 `KanbanView.test.tsx #2b` 锁住 empty→populated→empty 双向切换。

**教训**:任何"空态提前 return"都必须放在组件 hooks 链末尾(或改为 JSX 条件分支)。MatrixView 本来就是对的;新写视角组件时把空态当一等分支审。

> 同类陷阱(同日修):悬停打开的 MUI 嵌套子菜单,**子 Menu 的 ModalRoot 是 fixed inset-0 全屏层**,会盖住父菜单项制造幻影 mouseLeave/Enter 循环(飞窗闪烁)——flyout root 须 `pointer-events:none`(paper 恢复 `auto`)。详见 [docs/13 §11](./13-security.md) 菜单形态条。

## 29. 用本地化文案前缀匹配推断 toast 严重度 → 五种语言全部误判(2026-07-22)

**症状**:ja/ko 界面下所有 toast(包括真错误)显示绿色"成功";en/zh 下"移动/打包成功"反而显示红色错误。

**根因**:FileList 的 Snackbar 拿 notice 文本去 `startsWith(t('tagsApplied',{count:0}).split('0')[0])` 等判断 severity。ja/ko 译文以 `{{count}}` 开头 → 前缀为空串,`startsWith('')` 恒真(全绿);`movedItems`/`packaged` 不在白名单 → 成功消息落到默认 error(全红)。

**修复**:notice 结构化 `{ text, severity, openTrash? }`,严重度由产生处显式携带(`showNotice(msg, severity?, opts?)`,默认 error;`useListCommands` 同步)。**语义绝不从展示文案反推** —— 尤其文案是多语言可变的。

**同类陷阱**(同日修):DirectoryTree 删除确认固定用 `confirmDelete`("不可撤销")但底层默认走回收站 —— 文案必须与 `deleteToTrash` 实际行为分支一致。
