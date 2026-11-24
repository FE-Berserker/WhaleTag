← 返回 [plan.md](../plan.md)

# 07. 扩展系统

> 8 个内置扩展、manifest + iframe 沙箱 + postMessage 桥、按扩展名分发、修订历史、双层 iframe 套第三方 webapp 拓扑。

## 1. 架构总览

**目录**:

```
src/extensions/
  shared/                       # 公共共享
    extension-api.js            # i18n / onLocale / postMessage 桥
    theme.ts                    # 共享主题:detectInitialTheme + applyThemeToDocument
    i18n.ts                     # 共享语言:pickStrings / syncDocumentLocale / onLocaleChange
    csp-policy.json             # CSP 单一来源(baseline + 每扩展追加项),构建期合成 meta 与响应头策略
    format-bytes.ts             # 共享字节格式化(formatBytes)
    zoom.ts                     # 共享缩放逻辑
    keymap.ts                   # 共享按键映射
    relpath.ts                  # 相对路径工具(嵌入链接跨文件移动时重算)
    viewer-prefs.ts             # font/html 共享的带前缀偏好读写
    whale-ext.d.ts              # 扩展端全局类型
  json-viewer/ html-viewer/
  text-editor/
  image-viewer/
  heic-viewer/
  excalidraw-editor/ drawio-editor/
  font-viewer/
```

> 协议类型(`ExtensionManifest` / `HostMessage` / `ExtensionMessage` 等)统一在 [src/shared/extension-types.ts](../src/shared/extension-types.ts),不在 `shared/` 目录内。

构建产物 = `release/app/dist/extensions/<id>/`,生成 `registry.json`(主进程读,renderer 经 `ext:getRegistry` 取)与 `csp-policy.generated.json`(每扩展已预合并的 CSP 响应头策略,主进程 `protocol.handle` 读,见 §1.5)。注册表缺失 = 合法的空安装;文件存在但读取或 `JSON.parse` 失败时主进程抛错,renderer 置错误态并 `notifyApp` 提示,不再伪装成"没有扩展"。

**Manifest**(`ExtensionManifest`):

```ts
{
  id: string;                   // 'text-editor'
  name: string;                 // 'Text Editor'
  type: 'viewer' | 'editor';
  color: string;                // 主题色
  fileTypes: string[];          // ['txt','log','csv','tsv','json','js','ts','css','html','xml','yaml','yml']
  entryPoint: string;           // 相对目录的 index.html
  enabled: boolean;             // 必填
  isDefault: boolean;           // 必填;用户未指定时该扩展默认打开
}
```

**发现与注册**:[scripts/build-extensions.js](../scripts/build-extensions.js) 扫描 `src/extensions/*/manifest.json`,Webpack 打包,生成 `registry.json`。

**代码分割与产物布局**:[webpack.config.extensions.ts](../.erb/configs/webpack.config.extensions.ts) 为 8 个扩展分别创建 compiler;每个 compiler 的 `output.path` 是 `dist/extensions/<extId>/`,`output.chunkFilename` 是 `chunks/[id].[contenthash].js`、`publicPath: ''`,并使用 `parser.javascript.dynamicImportMode: 'lazy'` 与 `optimization.splitChunks: { chunks: 'async' }`。动态依赖因此留在异步 chunk 中,chunk 文件和运行时 URL 都以所属扩展的 `index.html` 为根解析到 `<extId>/chunks/`;独立 compiler 同时保证 splitChunks 只在单个扩展内去重,不会把共享 chunk 写到产物根目录。不能用多 entry + `[runtime]/chunks` 替代:webpack 的加载运行时会把它坍缩成字面 `_`,造成磁盘路径与请求 URL 不一致。扩展 TS 仍走 `createBase()` 的 CommonJS 编译,CSP、`whale-extension://` 协议与 manifest 契约均不变;`text-editor` 没有 async chunk。以 Excalidraw 为例:entry 7,777,059 → 1,314,536 B,132 个异步 chunk 合计 6,496,642 B;entry + chunk 合计 7,811,178 B,比拆分前单文件多 34,119 B(+0.4%),换来首屏只加载 entry 与按需 chunk,完整总量并未下降。验收不能只数文件,必须让真实 packaged Excalidraw / Mermaid 跑通并断言 requestfailed / pageerror / console error / 404 为空。

**Host ↔ Extension 协议**:统一 envelope `ExtensionEnvelope<T> { protocolVersion: 1, source: 'host' | 'extension', message }`,走 `window.postMessage`。

**Host → Ext 全部消息类型**(`HostMessage` 联合,`src/shared/extension-types.ts:176-186`):

| 消息 | 用途 |
|---|---|
| `fileContent` | 文件内容(含可选 `size`、`dirPath` 与 `force`)——html-viewer 用 `dirPath` 把正文里的相对图片解析为 `whale-file://`;`force: true` 表示宿主已确认要替换文档(revision 恢复),脏编辑器必须丢弃缓冲区并清 dirty |
| `savingFile` | 写盘完成回执,UI 反馈；revision-aware 编辑器回显内容版本 |
| `setTheme` / `setReadOnly` / `setLocale` | 主题 / 只读 / 语言切换 |
| `requestSave` | 触发扩展保存 |
| `heicWasm` | HEIC wasm 经 host IPC 供给(绕 iframe CSP) |
| `externalDrag` / `fileEmbed` / `siblings` | 文件夹拖入 / 嵌入 / 同级条目 |

`fileEmbed` 回传请求里的 `requestId`(老扩展不发 id,回执里也不带);`siblings` 的 `paths` 可以是空数组——宿主总是发送,空数组表示"同级里没有可导航目标",viewer 必须据此禁用上一张/下一张。

**Ext → Host 全部消息类型**(`ExtensionMessage` 联合,`src/shared/extension-types.ts`):

核心生命周期 / 编辑:`ready` / `parentSaveDocument` / `contentChangedInEditor`

资产请求:`requestHeicWasm`(heic-viewer wasm 经 host IPC 读取)

图片编辑:`requestFileEmbed` / `requestFile` / `openLinkExternally` / `error`

`requestFileEmbed` 可带 `requestId`:宿主把它登记为在途请求(60s 超时),生成完缩略图后在 `fileEmbed` 里原样回传;重复 id 直接拒绝。扩展侧只在 id 匹配时落位(无 id 回执仅在没有任何在途请求时接受,否则 warn 后丢弃),因此并发/迟到的回执不会互相顶掉坐标。`requestFile` 的 `requestId` 只用于宿主丢弃重放请求——它的"回答"是另开一个 tab,不回传 id。

`KNOWN_MESSAGE_TYPES` 与上面两个联合保持同步;曾经登记过的 `loadDefaultTextContent` / `editDocument` / `thumbnailGenerated` / `directoryDialogResult` 没有任何生产方或消费方,已从类型与运行时白名单删除。

宿主把拖入图片转为 data URL 时走 `fs:readFileBase64`:Main 先过 allowedRoots,再用 `Buffer.toString('base64')`;Renderer 不再逐字节拼十六进制或调用 `btoa`。二进制查看器/编辑器(如 heic-viewer、font-viewer)打开文件同样走 `fs:readFileBase64`:renderer 直接拿到 base64 字符串,不返回 `ArrayBuffer`,文件大小由 base64 长度换算。

**安全**:iframe sandbox = `allow-same-origin allow-scripts allow-modals allow-downloads`;Host 只接受 `event.source === iframe.contentWindow`;每个扩展 HTML 自带 CSP meta,协议响应另下发同一策略的 CSP 响应头(见下)。

CSP 不手抄在 8 份 `index.html` 里,而是由 [src/extensions/shared/csp-policy.json](../src/extensions/shared/csp-policy.json) 单一维护,分两条通道下发同一份策略:

1. **meta(兼容/声明式)**:[scripts/build-extensions.js](../scripts/build-extensions.js) 读取 baseline + 该扩展的追加项(只追加不替换),合成后替换模板里的 `content="__WHALE_CSP__"`;模板缺占位符、策略缺 baseline 或某扩展没有条目时构建直接失败,避免 dist 里留下未替换的占位符被 Chromium 当作无 CSP 丢弃。meta 强制 `object-src 'none'` / `base-uri 'none'`,并保留其余 baseline 指令(`default-src 'self'`、`img-src` 含 `whale-extension://*` 与 `whale-file:`,各扩展只在真实需要处追加 unsafe-eval 等例外);**`frame-ancestors` 由构建期从 meta 里剔除**(`META_OMITTED_DIRECTIVES`),因为 Chromium 对 meta 传递的该指令每次加载都会打印 `The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.`,而真机 smoke 对 console error 零容忍——它只由下一节的响应头下发。
2. **响应头(真实生效)**:`frame-ancestors`(以及 `sandbox`)经 meta 传递会被浏览器忽略,只能由响应头生效。构建期同时生成 `dist/extensions/csp-policy.generated.json`([src/main/extension-csp.ts](../src/main/extension-csp.ts) 的 `CSP_MANIFEST_FILENAME`),其中每个扩展的指令已合并好,只留 `"__APP_ORIGIN__"` 占位符;主进程 `protocol.handle('whale-extension', ...)` 启动时 `loadCspManifest` 读一次,对 `text/html` 响应按 host(=扩展 id)取策略,把占位符替换成**应用壳页的真实 origin**——生产父页是 `loadFile` 的 `file://`(scheme source 写作 `file:`,实测 `file://` 不是合法 host-source 会被忽略),开发是 `http://localhost:4002`——并设置 `Content-Security-Policy` 响应头。header 里的 `frame-ancestors` 为 `'self' <app-origin>`:`'self'` 保留给 drawio/excalidraw 同源内层 iframe,app-origin 允许 Whale 自己嵌扩展页(此前 `'none'` 只写在 meta 里、从未生效,扩展实际上可被任意同进程页面嵌入)。
3. **fail-closed**:清单缺失/损坏 → `console.warn` 后按内置 baseline 继续服务(不静默放行);未知扩展 id 同样回退 baseline,且每个 id 只 warn 一次;非 HTML 响应(静态资源、chunk)不带 CSP,避免把策略误加到 `script-src` 之外。

实证依据(Electron 42.11.18,独立探针):`protocol.handle` 返回的 CSP 响应头对 `whale-extension://` 文档生效(`frame-ancestors 'none'` 会以 `Framing ... violates ...` 拦下 iframe),`file:` scheme source 匹配 `file://` 父页,`*` 不匹配 file scheme。响应头策略与主窗口 CSP 仍是两套:[main.ts](../src/main/main.ts) 的 `onHeadersReceived` 继续跳过 `whale-extension://`(§6 硬约束 2),扩展页不会叠加主窗口策略。校验见 [build-extensions.test.ts](../scripts/build-extensions.test.ts) 的 "extension CSP policy" / "extension CSP header manifest" 组与 [extension-csp.test.ts](../src/main/extension-csp.test.ts)。

## 2. 8 个内置扩展清单

**确认清单**(每个 manifest 直接读出):

| id | type | fileTypes | isDefault |
|---|---|---|---|
| json-viewer | viewer | json | ✅ |
| html-viewer | viewer | html/htm | ✅ |
| text-editor | editor | txt/log/csv/tsv/json/js/ts/css/html/xml/yaml/yml | ✅ |
| image-viewer | viewer | jpg/jpeg/png/gif/webp/bmp/avif/tiff/tif/ico/svg(**11 种**) | ✅ |
| heic-viewer | viewer | heic/heif | ✅ |
| excalidraw-editor | editor | excalidraw | ✅ |
| drawio-editor | editor | drawio/dio | ✅ |
| font-viewer | viewer | ttf/otf/woff/woff2(`.eot` 不被打开) | ✅ |

**CAJ 文件**:没有 viewer。`.caj / .kdh / .nh / .caa / .teb`(`file-icon.ts:CAJ_EXT`)显示 `SchoolIcon`,双击走 `shell.openPath`(系统 CAJViewer / 浏览器),Whale 不出渲染路径。

## 3. 通用扩展行为

**打开流程**([src/renderer/services/extension-dispatch.ts](../src/renderer/services/extension-dispatch.ts)):

1. 用户双击文件 → `handleOpen`(`FileList.tsx`)
2. 目录条目 → 进入
3. 图片 / 视频 → Lightbox(非扩展)
4. 其它调 `selectExtension(entry, registry, userDefaults)` → **用户默认 > isDefault > 任意匹配 > 回退系统应用**
5. 无匹配 → `openNative`(系统默认应用)

右键菜单含「Open With…」子菜单;Settings → Extensions 可设置某扩展类型的用户默认。

**文件打开 iframe 生命周期**:

- `ExtensionHost.tsx` iframe 宿主,管理加载 / 消息桥 / 保存流程 / 工具栏;**启动看门狗**(2026-07-22):iframe 12s 内未 post `ready` → 显示可重试失败态(此前崩溃/CSP 拦截 = 永久白屏),ready 前显示加载遮罩,重试经 `retryKey` 重挂 iframe
- 扩展页本身是懒加载边界：`ExtensionViewPanel` 的 chunk 加载失败时，ErrorBoundary 保留 `ExtensionTabBar`（可切换/关闭标签）和重试按钮，重试会重建被拒绝的 lazy 组件；`Suspense` fallback 用不透明背景而不是空白。`SearchBar` 的高级搜索对话框同样在加载失败后由工具栏按钮或错误提示重试；扩展页的正常 tab 切换仍复用同一个 lazy 组件，不重挂已有 iframe
- **常驻 iframe 数量有上限**(2026-11)：此前每个 tab 各挂一个 `ExtensionHost`，只是把非活动 tab `display:none`，于是最多 8 个扩展同时常驻——drawio / Excalidraw 各是几十 MB JS heap，图片/HTML 还有解码后的位图。现在 [extension-host/tab-mount-policy.ts](../src/renderer/components/extension-host/tab-mount-policy.ts) 的 `selectMountedTabIds` 只让 `MAX_MOUNTED_TABS = 4` 个宿主存活：活动标签必挂；**dirty 标签无条件挂载**（即使超出上限——未保存缓冲区在 iframe 内，关窗 flush 也依赖该宿主注册的 save handler，卸载即丢）；余下名额按 `ExtensionTab.lastAccessed` 给最近的干净标签。未挂载的 tab 保留外层占位，再次激活时用 `tab.fileContent` 重建，走的就是"外部修改后刷新"那条路径。为此 `ExtensionHost.handleSave` 成功后调 provider 的 `markTabSavedContent(tabId, content)` 把缓存推进到磁盘字节：否则重建会用打开时的旧内容，下一次保存把旧字节写回文件（`savingFile` 里 stale 分支同样先更新缓存，因为写盘已经落地）。代价是被卸载的标签重建时扩展自身状态（滚动位置、undo 历史、未提交的表单）丢失，与外部刷新一致（§4：text-editor 刷新本来就会 `scrollTo(0)`）；活动标签与 dirty 标签不受影响。面板用"dirty 标签 id 串"的 selector 判断固定集合，打字（`dirty: true` 反复 dispatch）不会让面板重渲染
- 编辑器脏状态经 `contentChangedInEditor` 上报;Save 触发 `parentSaveDocument` → `writeFileWithRevision`。脏状态按**标签 id**（`makeTabId(filePath, extensionId)`）存放，不按文件路径：同一文件可以同时用两个扩展打开（文本编辑器 + JSON 查看器），按路径存放时两个标签会互相清除 dirty/saving，关闭其一时看起来"没有未保存修改"而丢内容。关闭确认、保存后复查、fs.watch 刷新与 flush 统一经 `isTabDirty(editState, tabId)` 读取；`pickLruEvict` 同样接收 `dirtyTabIds` 并按 `tab.id` 跳过 dirty 标签，不能只改写入端而留下按路径查询的淘汰/监听逻辑。淘汰对象是除新标签与 dirty 标签之外 `lastAccessed` 最早的那个(真按访问时间,不按列表位置;时间戳相同时偏向更早打开的标签),激活标签只更新 `lastAccessed`、不重排列表。关窗前的 flush(`extension-save-flush.ts`)永不上抛,但不再把失败吞进 console:flush 自身的 rejection 与 5s 内未 ack 的标签都会 `notifyApp` 报"保存未完成、修改仍在标签里"
- dirty 上报是**边沿触发**：text-editor 只在 `false→true` / `true→false` 时发 `contentChangedInEditor`；保存进行中继续敲键时补发一次 revision 快照，保证宿主看到的 revision 不落后，写盘回执（`savingFile`）仍能区分 stale 与当前。宿主用 `editState[tabId]?.dirty === true` 布尔派生 selector 订阅并跳过重复 dirty 报告（不 dispatch），标签栏拆成每个 tab 单独订阅 `dirty` 的按钮组件，打字不会让整条标签栏或宿主重渲染。状态栏查找计数在文档或查询变化后 debounce 200ms 重算，不再每键 `doc.toString()` + 全文正则
- text / drawio / Excalidraw 的保存消息带内容 `revision`，宿主在 `savingFile` 回显实际写盘版本；旧回执不能清除写盘期间新产生的 dirty，stale 写盘即使已落盘也返回 false 并明确提示最新编辑仍未保存。并发保存会提示先等待当前写入；宿主报告成功后 provider 还会从 store 复查权威 dirty，仍有新编辑就取消关闭并恢复焦点。Excalidraw 每次完成写入都把比较基线推进到实际快照，再按当前 scene 重算 dirty，编辑后撤销回该快照也可正确变干净；缺省 revision 的旧扩展保留原行为。dirty 改为边沿触发后编辑器不再逐键上报 revision，宿主把 `parentSaveDocument` 携带的 revision 也纳入保存基线（取最大值），保存期间漏掉的中间 revision 不会让当前回执被误判为 stale
- `fileContent` 用于真实文件切换/外部刷新，只读切换走独立 `setReadOnly`；text 同路径仍有未保存修改时不重灌旧磁盘内容，drawio 只读用 iframe `inert` 阻止继续编辑。text-editor 在同路径外部刷新（缓冲区干净、内容被替换）时也会重建 undo 历史：否则 Ctrl+Z 能撤回重载前的旧文本，下一次保存把过期内容写回刚被外部修改的文件。ExtensionHost 还记录最近一次成功写盘的内容：`fs.watch` 回读若与之逐字相同就跳过 `fileContent`，避免保存后重载编辑器（例如关掉刚插入的 Mermaid 预览）；不同内容的外部修改仍会刷新并立即作废旧自写快照（因此 B→C→B 的最后一次外部 B 不会被吞），切换文件或重试加载时也会清空这条记录；唯一的强制例外是 `fileContent.force`(revision 恢复):缓冲区再脏也重灌并清 dirty
- 多标签记录所属 `locationId`，位置只读状态变化只同步该位置的标签，其他位置的后台标签保持原权限与对象身份；关闭前直接从 store 读取权威 dirty，不依赖 effect 镜像。后台脏标签的确认框会临时聚焦目标，取消、保存失败或保存/放弃成功关闭后都恢复此前活动标签（目标已关闭时自然不再选中它）。重命名走同一套关闭路径：改名成功后先关闭旧路径的标签再打开新路径，否则旧标签仍指向旧路径，之后再保存会把旧文件名写回磁盘（`ext:writeFile` 不校验目标是否仍存在），并留下新旧两个标签
- 写盘异常、初始或请求后切换的只读状态、15 秒未收到保存响应都由 ExtensionHost 各通知一次；普通保存统一使用通用保存错误并附上具体原因，超时会明确较晚写盘仍可能完成，关闭/重试前需确认标签状态。provider 在已注册 handler 返回 false 时只恢复焦点，handler 缺失或保存成功后权威 dirty 仍为 true 时才发关闭专用通知，不再叠加 blocking alert 与 snackbar。工具栏 Save 与关闭保存交叠时可能保守地取消关闭并提示保存进行中，不会把未确认内容视为已保存
- 外部刷新优先精确路径，只有大小写/分隔符归一化后唯一匹配才回退，大小写不同且结果有歧义时绝不重载错误标签；未保存编辑仍优先于磁盘重载
- 编辑器保存前**自动备份**到 `.whale/revisions/<basename>/<timestamp>.<ext>`；文件名用单调毫秒时间戳(同毫秒的两次保存各留一份,不互相覆盖),列表按源文件自身扩展名还原时间戳(无扩展名文件不再被最后一个点截断)。备份与恢复按**字节**读写(`Buffer` + `atomicWriteBytes`,不经过 utf8 解码):GBK / 二进制文件若按 utf8 往返,非法序列会被替换成 U+FFFD,恢复时就把损坏内容写回原文件;清理遍历的根 / 子目录失败只 warn,不再让一个坏目录 reject 整批。
- 启动清理 30 天前的旧 revision(`Root.tsx` 调 `cleanupRevisions(30)`)；IPC 只接受有限、非负的 number，非法或负天数会在任何删除发生前 reject

**修订历史**:

- IPC `ext:writeFile` / `ext:listRevisions` / `ext:restoreRevision` / `ext:deleteRevision`——均过 `assertWithinAllowedRoot`(备份没有独立 IPC:保存路径直接调用主进程函数 `backupRevision`);`deleteRevision` 把 revision 路径绑定到所属文件的 `.whale/revisions/` 前缀(与 restore 相同),拒绝删除任意路径
- **恢复会先自备份**:`restoreRevision` 覆盖前先 `backupRevision(filePath)` 把当前内容写进同一修订列表(写不成就拒绝恢复并上抛)——恢复本身因此可回退,误点不会永久丢掉最新版本;UI 侧 `RevisionHistoryDialog` 的恢复按钮还带二次确认(`danger`,显示所选版本时间)
- **脏标签恢复**:标签有未保存修改时,同一条二次确认会额外说明"恢复会覆盖未保存修改";确认后 provider 重新读文件并把 `fileContent.force` 发给编辑器(text-editor 的 `shouldLoadContent` 因此为 true,丢弃缓冲区并清 dirty),读盘失败会 `notifyApp` 报错——此前恢复在脏编辑器上静默无效,下一次保存把旧缓冲写回、覆盖刚恢复的版本
- **恢复保留文件权限**:覆盖用的是 `atomicWriteBytes`(tmp + rename),临时文件带的是默认 mode;恢复前先 `fsp.stat(filePath).mode & 0o777`,有值就作为 `atomicWriteBytes` 的 `{ mode }` 传入,否则一次 `chmod 0600` 的敏感文件会被恢复动作悄悄放宽回 umask 默认(stat 失败只回退默认 mode,不阻断恢复)
- UI:`RevisionHistoryDialog`

**i18n**:host `setLocale` 推送,机制见 §8;全局类型抽到 `src/extensions/shared/whale-ext.d.ts`(扩展不再各自 `declare global`)。

## 4. 文本查看器 / 编辑器实现要点

| 扩展 | 引擎 | 关键功能 |
|---|---|---|
| json-viewer | 自研 | 折叠树 + Ctrl-F + Copy Pretty/Minified + Tree/Raw 切换 + 大文件保护(>50000 节点锁 Raw) + JSONPath 复制 |
| html-viewer | DOMPurify（注入自身 document，非 iframe） | zoom + fit-width + 源码/预览 + 打印 + 图片开关 + 相对图片解析 + 状态栏 |
| text-editor | CodeMirror 6 | 查找/替换 + 字体缩放 + Wrap + 状态栏 + 代码折叠(白名单语言) + **接管 txt/log/csv/tsv**(2026-07-06 合并自 text-viewer) |

**text-viewer 已废弃**(2026-07-06):原来的 txt/log/csv/tsv 全部归 text-editor。CSV 不再出表格视图;log 大文件不再有 banner / 虚拟化(交给 CM 自管)。text-viewer 特有的 CSV 表格视图 + autoLink + Phase 4c 虚拟化随目录删除。CodeMirror 自己能撑住 100k+ 行的 buffer;但 100MB+ 纯文本 `.log` 没有 banner 防御,直接打开可能 OOM —— 真遇到大 log 请用 `openNative` 让系统应用打开。

**跨文件切换要重置 undo**:text-editor 复用同一个 CodeMirror `view`。`fileContent` 消息换文件时若不清历史,`Ctrl+Z` 会把上一个文件的内容写进当前文件(保存即串写);程序化 `setContent` 还会把"加载"记成一笔可撤销编辑。现在 history 放进独立 `Compartment`,换文件时 `reconfigure` 成新历史,`setContent` 用 `Transaction.addToHistory.of(false)` 排除出撤销栈。顺带修正了 `switchedFile` 的判断顺序——原代码先赋值再比较,语言切换分支永远不执行。

**用户 CSS 不得绕过图片开关**:html-viewer 的图片开关同时约束 `<style>` 里的外链——关掉远程图片时,`url(https://…)`(background / cursor / `@font-face` 都会触发)与 `@import` 仍会发请求并拉取任意 CSS。现在 `stripRemoteCssRefs` 移除 `@import` 并把非 `data:` 的 `url()` 替成 `none`,开图片时才原样注入。DOMPurify 只管 HTML,管不到 `<style>` 文本,这是它之外必须单独做的一层。正文元素上的行内 `style` 走同一条清理:关图时对 sanitize 后的 `[style]` 元素逐个剥掉远程 `url()`/`@import`,local 声明(颜色、字号)保留。

**用户 CSS 作用域**:`<style>` 挂在扩展页面 `document.head`,不作用域会命中工具栏与弹窗(`body{display:none}` 曾把整个 UI 一起干掉)。注入后按 `CSSStyleSheet.cssRules` 改写选择器:按 `,` 拆分,`html`/`body`/`:root` 映射为 `#content`、以其开头的选择器换前缀,其余统一前置 `#content `;`@media`/`@supports` 递归处理,非 `CSSStyleRule` 分组(如 `@keyframes`)原样跳过;访问 `cssRules` 被浏览器拒绝时保留未作用域文本而不是丢掉整张表。

各查看器/编辑器共享 `src/extensions/shared/zoom.ts` 与 `keymap.ts`。

**相对图片解析**:html-viewer 把 sanitize 后的 HTML 直接注入自身 `document` 的 `#content`(不是 iframe);host 在 `fileContent` 里带 `dirPath`(文件所在目录),viewer 在注入后把 `img[src]` 的相对路径解析到 `dirPath` 下,再经 `encodeWhaleFileUrl` 生成 `whale-file://`,因此 CSP 的 `img-src` 增加 `whale-file:`。解析只接受 `dirPath` 内的相对路径:绝对路径、`//` / `\\` 前缀、带 scheme 的 URL、`..` 以及 `%2e%2e` 等编码后的越界一律返回 null 并保持原 src;图片开关关闭时不解析。`whale-file://` 请求由主进程 `assertWithinAllowedRoot` 守卫,只服务已配置 location roots 内的文件。

## 5. 媒体与文档类

| 扩展 | 后端 |
|---|---|
| image-viewer | 原生 `<img>` + Lightbox 缩放 / pan / 旋转 / `flipH` / `flipV`;`<` `>` `Space` 等快捷键。图像经 Blob URL 挂到 `<img>`(`object-url.ts` 跟踪当前 URL),换文件/出错/iframe 卸载时 `revokeObjectURL`:早先直接用 `data:` URL 且从不释放,一个目录里看过的每张图都会在 iframe 生命周期内常驻内存。CSP `img-src` 已含 `blob:` |
| heic-viewer | libheif-js wasm 解码;大文件同步阻塞 → iframe 显示 "Decoding…" |

✅ **pdf-viewer 已随 0.4.9 瘦身移除**(2026-09,连同 `shared/pdfjs-in-iframe.ts` 会话工厂、AI 框选提问管线 `askAi`/marquee/`aiDraftBus`/`AskQuestionDialog`、`requestFileBytes`/`fs:readFileRange` 字节桥、`requestPdfAsset` 资产服务)。PDF 文件本身仍受完整支持:**主进程**缩略图(`thumb-render.ts`,pdfjs 页 1 渲染)与全文索引(`fulltext.ts`)不依赖该扩展;`pdfjs-dist` 依赖与 `builder.json` asarUnpack 因此保留。

## 6. 双层 iframe 套第三方 webapp

`excalidraw-editor` 与 `drawio-editor` 共享这条拓扑:`ExtensionHost` (外层 iframe) → 内层 iframe 加载第三方 webapp。

**四件硬约束**(缺一不可):

1. **`registerSchemesAsPrivileged([{scheme:'whale-extension', privileges:{standard:true, secure:true}}])`** 必须在 `app.ready` 之前(`src/main/main.ts:787`);否则 origin 是 opaque,`document.cookie` 抛 `SecurityError`
2. **不要**给 `whale-extension://` 响应套**主窗口** CSP;`onHeadersReceived` 跳过该协议。扩展页的安全性由 `protocol.handle` 响应里的 per-extension CSP 头 + 各扩展 meta 治理(见 §1 "安全"/CSP 段),主窗口策略对 drawio 过严(会阻断 unsafe-eval/worker)
3. build 第三方 webapp 时**不要**过滤子目录;drawio `App.main` 同步等子资源 200,失败不发 `init`
4. 第三方 webapp 的 embed 协议经常"遗留字符串握手"+"结构化 JSON"两套;drawio 是 `proto=json` URL 参数切换

Draw.io 的本地 Link/Lightbox 会请求 `drawio-assets` 目录 URL。`extension-protocol.ts` 仅把 `drawio-editor/drawio-assets` 精确根路径（含尾斜杠变体）映射到该目录的 `index.html`,其他扩展目录仍保持 EISDIR/404,不开放通用目录索引。构建时 base/lightbox 使用无尾斜杠 URL,viewer/base/lightbox 都由独立赋值固定到本地,避免 vendor `PreConfig.js` 重置与赋值顺序影响。

**Excalidraw 字体降级边界**:`whale-extension://` 可用于文档、script 与 chunk,但当前 Electron 的 `supportFetchAPI` 未开启;Excalidraw 的字体加载器先尝试随包 `EXCALIDRAW_ASSET_PATH`,本地 `fetch` 失败后还会尝试上游 esm.sh URL,随后被扩展 CSP 的 `font-src 'self' data: whale-extension://*` 阻止并回退系统字体。这是既有离线/字体取舍,不是 async chunk 失败。打包冒烟应单独归类这组精确匹配的字体 CSP 错误,继续对其它 console error、pageerror、requestfailed 和 404 零容忍,不能用全局忽略字体或全部 console 来掩盖 chunk 回归。

上游 `drawio-offline` 包不包含 `embed-static.min.js` 或 `embed.js`(只有 `embed.dev.js`),所以 `EditorUi.getHtml` 的 HTML-embed 仍有上游资源缺口；本地 Link/Lightbox 与 viewer-static 可服务不等于 HTML-embed 已修复。不要简单把 `embed.dev.js` 改名冒充正式 bundle。

**excalidraw**:直接 `@excalidraw/excalidraw` 嵌入,scene restore + dirty 跟踪 + 从目录树拖文件嵌入(图片经原生嵌入;非图片插入带链接的缩略图,点击用系统程序打开)。0.18.1 的 API 可能早于异步 `initializeScene` 暴露,此时立刻 `updateScene` 会被随后初始化的空场景覆盖;现在首份 `fileContent` 不直接写 API,而是 resolve 进一次性 Promise,由 `<Excalidraw initialData>` 参与初始化并原子恢复,`consumed` 之后的刷新才走 `applyScene`。非空内容先经 `parseExcalidrawScene` 验证 `type==='excalidraw'` 且 `elements` 缺省或为数组,避免上游 total `restore` 把 `{}`、library export 等合法 JSON fail-open 成空场景。恢复失败会向宿主 post `{type:'error',fatal:true,path}` 后重新抛出,不再静默 `restore({})` 用空白场景吞掉错误;扩展不设置可保存路径且内部 Save 被 `restoreFailedRef` 阻断,宿主同时禁用 Save 并显示带 Retry 的错误界面,避免空场景覆盖源文件。失败时关闭保存立即返回 false,不再白等 15 秒;Retry 重挂 iframe 时清空旧 revision 与自写回读快照,成功恢复后强制上报 dirty=false 对账。

**drawio**(`useWhaleBridge.ts` + `drawio-bridge.ts`):

- `drawio-offline` webapp + `?proto=json` 结构化协议
- `EMPTY_DRAWIO` 单行占位符(`<diagram>` 紧跟 `<mxGraphModel>`,零空白),避免 `parseDiagramNode` children 分支失败
- Drawio 保存实测走 `export` action event(不是 `autosave`/`save`);bridge 只对 `export` 调用 `getXml` 并映射为 `{kind:'xml',xml}`，`autosave`/`save` 仅触发 `onChange`，不额外生成 XML 保存消息
- drawio `editor.modified` 默认 false(画了 shape + 1.5s autosave timer 后才翻 true),工具栏 Save 不依赖 dirty 直接允许(未修改 = no-op 写盘)
- unmount 会注销 save/message handler、清 XML timer 并 reject pending requests；销毁后不再 postMessage，异步保存与图片插入也不得继续更新已卸载组件。`fileContent` 刷新只重绑 handler，不取消已经开始的保存或图片插入；若切换到另一文档，尚未完成的图片插入会在写 XML 前中止，避免把旧文档的拖入内容写进新文档。图片插入是 read→append→loadXml 的读改写：**读不到当前图表时中止并提示，不加载任何替换文档**（旧兜底会用一个单 cell 文档覆盖整张图）。并发拖入改走 promise 链**串行**：旧实现的 in-flight 早退会静默丢掉第二个文件（调用方收不到错误，文件就是不出现）。非图片 drop 的标签在 `html=1` 下按 HTML 渲染，文件名先做 HTML 转义再做 XML 转义（双层是刻意的：XML 解码后仍是 `&lt;…&gt;` 文本），否则名为 `<img src=x onerror=…>` 的文件会被 drawio 当标记渲染。

## 7. 扩展 i18n 与主题

- host 语言变化 → push `setLocale` → `extension-api.js` 集中 `onLocale()` + `t(I18N)` → 工具栏 / 状态栏 / 菜单文案刷新
- 6 个 DOM 型 viewer/editor 不再各抄一份桥接代码,统一走 [src/extensions/shared/i18n.ts](../src/extensions/shared/i18n.ts):`pickStrings(I18N)` 取当前语言文案、`syncDocumentLocale()` 设 `document.documentElement.lang`、`onLocaleChange(handler)` 包装 `window.whaleExt.onLocale`;各扩展只保留自己的 `interface Strings + I18N: Record<string, Strings> + applyLocale()` 文案表(文案不同,不合并)。html-viewer / text-editor 的 locale 回调还要刷新状态栏与 CM 里已渲染的 UI,所以传的是本地包装函数
- 扩展文案表目前只有 `en` / `zh` 两套:6 个 DOM 扩展的 `I18N` 都只有这两个键,`extension-api.js` 的 `t()` 按「当前 locale → 基础语言(`zh-TW` → `zh`)→ `en`」回落,所以 zh-TW 看到简体、ja / ko 看到英文;drawio 桥同样只传 `zh` / `en`(`drawio-bridge.ts` 的 `lang: lang.startsWith('zh') ? 'zh' : 'en'`)。主应用的 5 语言不覆盖扩展内部文案
- 主题同样收口到 [src/extensions/shared/theme.ts](../src/extensions/shared/theme.ts):`detectInitialTheme()`(首帧 matchMedia,失败兜底 light)+ `applyThemeToDocument(theme)`(设 body `data-theme`)。此前 `detectInitialTheme` 有 5 份逐字相同的副本、image-viewer 首帧还硬编码 `light`,暗色主题下会闪一下。text-editor 的本地 `applyTheme` 只保留必需的 CodeMirror `themeCompartment.reconfigure`,body 属性仍交给共享函数;drawio / excalidraw 是 React 应用、不用 `data-theme`,仅用 `detectInitialTheme()` 作为 theme state 的初值(运行时仍由 `setTheme` 驱动)

## 8. 已知坑(在本模块反复踩)

详见 [docs/09-known-issues.md](./09-known-issues.md)。重点:

- `BINARY_EXT` 误加 `drawio` / `dio` → host 按 base64 注入 → `loadXml` 报 "Start tag expected"(mxfile 是 UTF-8 文本)
- drawio `readFirstDiagramXml` 对无 `%` 前缀的 body 盲目 inflate → "invalid bit length repeat"
- drawio `export` action event(不是 `autosave`/`save`)才调用 `getXml`；`autosave`/`save` 只触发 `onChange`
- drawio `editor.modified` 默认 false → Save 按钮不能依赖 dirty
- drawio embed 默认 `parent.postMessage('ready', '*')` 字符串握手 → 加 `?proto=json` 切到结构化协议
- `pdfjs-dist` `cMapUrl` / `standardFontDataUrl` 必须是**纯文件系统路径 + 结尾 `/`**(主进程路径,不是 `file://` URL;缩略图 / 全文索引管线同样适用)
- `pdfjs-dist` `cmaps/ standard_fonts/ wasm/` 已加进 `builder.json` `asarUnpack`
- 编辑器(CodeMirror) Compartment 切换不触发 `contentChangedInEditor`(vs. drawio 教训)；dirty 现为边沿触发，宿主在 `parentSaveDocument` 携带 revision 时以其为保存基线，不依赖逐键消息
- Edit 工具在 Windows 偶发写入 `\0` null 字节 → grep 报 binary file → 用 Write 重写干净

## 9. 架构审阅遗留(2026-07-18)

- ✅ **god-switch 已拆**(2026-07-18):`request* → reply` 类 RPC 消息下沉到 [extension-host/rpc-cases.ts](../src/renderer/components/extension-host/rpc-cases.ts) —— 通用 `forwardRpc` helper 负责 ipcApi 调用 → 成功回包 / 错误回包,各 case 只给 reply 构造器;`createRpcHandler` 返回"是否处理"判别,非 RPC 消息回落组件内 switch。当前唯一走该通道的是 `requestHeicWasm`(HEIC wasm 读取),测试见 [rpc-cases.test.ts](../src/renderer/components/extension-host/rpc-cases.test.ts)(reply 形状 / 错误兜底 / 非 RPC 回落)。
- **postMessage `targetOrigin: '*'`**(ExtensionHost / extension-api.js 双向):接收端有 `event.source === iframe.contentWindow` 校验所以不算漏洞,但 `whale-extension://` 是特权 scheme,发往 iframe 的消息对同窗口任何 message 监听者可见,应收窄为具体 origin。
- **扩展页 CSP 分两条通道**(2026-11-23):`frame-ancestors` / `sandbox` 只能经响应头生效,所以 `csp-policy.generated.json` 与 `extension-csp.ts` 是真正执行面;**meta 不再带 `frame-ancestors`**(Chromium 每次加载都会对该指令打 console error,真机 smoke 断言 console 零错误),meta 只保留其余指令。取舍是 **fail-closed**:清单缺失或扩展 id 未知时退回内置 baseline 并 `console.warn`——此时 unsafe-eval 类追加项(仅 drawio/heic 需要)会丢失,这两个扩展可能加载失败,宁可白屏也不静默放行任意嵌入;因此 dist 扩展产物与主进程必须同版本发布(构建脚本与 `main.ts` 读同一文件名,`build-extensions.test.ts` 断言两者一致)。
