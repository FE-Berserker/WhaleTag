← 返回 [plan.md](../plan.md)

# 07. 扩展系统

> 15 个内置扩展、manifest + iframe 沙箱 + postMessage 桥、按扩展名分发、修订历史、双层 iframe 套第三方 webapp 拓扑。

## 1. 架构总览

**目录**:

```
src/extensions/
  shared/                       # 公共共享
    extension-api.ts            # i18n / onLocale / postMessage 桥
    extension-types.ts          # 注意:协议类型在 src/shared/extension-types.ts
    zoom.ts                     # 共享缩放逻辑
    keymap.ts                   # 共享按键映射
    whale-ext.d.ts              # 扩展端全局类型
    registers.ts                # 共享注册
  json-viewer/ html-viewer/
  text-editor/ md-editor/
  image-viewer/
  heic-viewer/ pdf-viewer/ media-player/
  office-viewer/ ebook-viewer/ archive-viewer/
  excalidraw-editor/ drawio-editor/
  cad-viewer/ font-viewer/
```

构建产物 = `release/app/dist/extensions/<id>/`,生成 `registry.json`(主进程读,renderer 经 `ext:getRegistry` 取)。

**Manifest**(`ExtensionManifest`):

```ts
{
  id: string;                   // 'text-editor'
  name: string;                 // 'Text Editor'
  type: 'viewer' | 'editor';
  color: string;                // 主题色
  fileTypes: string[];          // ['txt','log','csv','tsv','json','js','ts','css','html','xml','yaml','yml']
  entryPoint: string;           // 相对目录的 index.html
  enabled?: boolean;
  isDefault?: boolean;          // 用户未指定时该扩展默认打开
}
```

**发现与注册**:`scripts/build-extensions.ts` 扫描 `src/extensions/*/manifest.json`,Webpack 打包,生成 `registry.json`。

**Host ↔ Extension 协议**:统一 envelope `ExtensionEnvelope<T> { protocolVersion: 1, source: 'host' | 'extension', message }`,走 `window.postMessage`。

**Host → Ext 全部消息类型**(`HostMessage` 联合,`src/shared/extension-types.ts:250-274`):

| 消息 | 用途 |
|---|---|
| `fileContent` | 文件内容(含可选 `size`)|
| `savingFile` | 正在保存,UI 反馈 |
| `setTheme` / `setReadOnly` / `setLocale` | 主题 / 只读 / 语言切换 |
| `requestSave` | 触发扩展保存 |
| `pdfAsset` / `cadWasm` / `heicWasm` | PDF cmap/字体 + CAD wasm 经 host IPC 供给(绕 iframe CSP) |
| `dwgConvertedContent` / `officePdfContent` / `ebookConvertedContent` | 主进程 CLI 转换结果(office / dwg / ebook) |
| `thumbnailContent` | office-viewer 缩略图占位(host `loadThumbnail` 回的 jpg data URL,docs/15 P3-1) |
| `archiveList` / `archiveEntryContent` / `archiveExtracted` | 主进程 archive 解码结果(7zip-bin) |
| `directoryDialogResult` | 目录选择对话框结果 |
| `externalDrag` / `fileEmbed` / `siblings` | 文件夹拖入 / 嵌入 / 同级条目 |
| `ebookAnnotations` | 阅读高亮注释 |
| `requestSelection` / `applyReplacement` | AI inline-edit 桥(host ↔ CodeMirror) |
| `streamingUrl` | 媒体流式 URL(host 按扩展名选协议:原生/视频走 `whale-file://`,转码音频 APE/WMA/… 走 `whale-audio://` 主进程实时 Opus 转码) |

**Ext → Host 全部消息类型**(`ExtensionMessage` 联合,`src/shared/extension-types.ts`,28 种):

核心生命周期 / 编辑:`ready` / `loadDefaultTextContent` / `parentSaveDocument` / `contentChangedInEditor` / `editDocument`

资产 / 转换请求:`requestPdfAsset` / `requestCadWasm` / `requestHeicWasm` / `requestDwgConvert` / `requestOfficeConvert` / `requestThumbnail` / `requestEbookConvert` / `requestStreamingUrl`(媒体用,host 按扩展名回 `whale-file://` 或 `whale-audio://`)/ `requestArchiveList` / `requestArchiveEntry` / `requestArchiveExtract` / `requestDirectoryDialog`

图片编辑:`saveImageEdit` / `copyImageToClipboard` / `saveImageComposite` / `requestFileEmbed` / `requestFile`

笔记与媒体:`requestReadEbookAnnotations` / `requestWriteEbookAnnotations` / `playbackEnded` / `thumbnailGenerated` / `openLinkExternally` / `error`

**安全**:iframe sandbox = `allow-same-origin allow-scripts allow-modals allow-downloads`;Host 只接受 `event.source === iframe.contentWindow`;每个扩展 HTML 自带严格 CSP meta。

## 2. 15 个内置扩展清单

**确认清单**(每个 manifest 直接读出):

| id | type | fileTypes | isDefault |
|---|---|---|---|
| json-viewer | viewer | json | ✅ |
| html-viewer | viewer | html/htm | ✅ |
| text-editor | editor | txt/log/csv/tsv/json/js/ts/css/html/xml/yaml/yml | ✅ |
| md-editor | editor | md/markdown | ✅ |
| image-viewer | viewer | jpg/jpeg/png/gif/webp/bmp/avif/tiff/tif/ico/svg(**11 种**) | ✅ |
| heic-viewer | viewer | heic/heif | ✅ |
| pdf-viewer | viewer | pdf | ✅ |
| media-player | viewer | **10 视频**(mp4/mov/mkv/webm/m4v/avi/3gp/ogv/wmv/flv)+ **16 音频**(mp3/ogg/wav/flac/aac/m4a/opus/ape/wma/aiff/amr/ac3/dts/mpc/wv/dsf) | ✅ |
| office-viewer | viewer | doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp | ✅ |
| ebook-viewer | viewer | epub/fb2/cbz/mobi/azw/azw3 | ✅ |
| archive-viewer | viewer | **9 种**:zip/tar/tgz/tbz2/txz/gz/bz2/xz/7z | ✅ |
| excalidraw-editor | editor | excalidraw | ✅ |
| drawio-editor | editor | drawio/dio | ✅ |
| cad-viewer | viewer | **stl/obj/glb/gltf/ply**(Tier 0)+ **dxf**(Tier 1)+ **step/stp/iges/igs/brep**(Tier 1.5)+ **dwg**(Tier 2) | ✅ |
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
- 编辑器脏状态经 `contentChangedInEditor` 上报;Save 触发 `parentSaveDocument` → `writeFileWithRevision`
- 编辑器保存前**自动备份**到 `.whale/revisions/<basename>/<timestamp>.<ext>`
- 启动清理 30 天前的旧 revision(`Root.tsx` 调 `cleanupRevisions(30)`)

**修订历史**:

- IPC `ext:backupRevision` / `ext:writeFile` / `ext:listRevisions` / `ext:restoreRevision`
- UI:`RevisionHistoryDialog`

**i18n**:扩展语言切换经 host `setLocale` 消息,`extension-api.js` 集中 `onLocale()` / `t(I18N)`;全局类型抽到 `src/extensions/shared/whale-ext.d.ts`(扩展不再各自 `declare global`)。pdf-viewer / office-viewer 已接入 en/zh;其他扩展无 chrome 文案。

## 4. 文本查看器 / 编辑器实现要点

| 扩展 | 引擎 | 关键功能 |
|---|---|---|
| json-viewer | 自研 | 折叠树 + Ctrl-F + Copy Pretty/Minified + Tree/Raw 切换 + 大文件保护(>50000 节点锁 Raw) + JSONPath 复制 |
| html-viewer | DOMPurify iframe | zoom + fit-width + 源码/预览 + 打印 + 图片开关 + 状态栏 |
| text-editor | CodeMirror 6 | 查找/替换 + 字体缩放 + Wrap + 状态栏 + 代码折叠(白名单语言) + **接管 txt/log/csv/tsv**(2026-07-06 合并自 text-viewer) |
| md-editor | CodeMirror 6 | 分屏左编辑 / 右预览 + **工具栏**(Find / Wrap / Zoom) + **状态栏**(Ln/Col/Length/Sel/Words/UTF-8/Read-Only)+ 滚动同步 + 语法高亮 + 本地图片解析;`requestSelection` / `applyReplacement` AI 编辑桥 |

**text-viewer 已废弃**(2026-07-06):原来的 txt/log/csv/tsv 全部归 text-editor。CSV 不再出表格视图;log 大文件不再有 banner / 虚拟化(交给 CM 自管)。text-viewer 特有的 CSV 表格视图 + autoLink + Phase 4c 虚拟化随目录删除。CodeMirror 自己能撑住 100k+ 行的 buffer;但 100MB+ 纯文本 `.log` 没有 banner 防御,直接打开可能 OOM —— 真遇到大 log 请用 `openNative` 让系统应用打开。

各查看器/编辑器共享 `src/extensions/shared/zoom.ts` 与 `keymap.ts`。

### 4.1 md-editor 当前实现要点与改进路线图

`src/extensions/md-editor/`:~500 行 `index.ts` + ~700 行 `md-render.ts`(16 个纯函数:parseMarkdown / sanitizeMarkdownHtml / setupLinkDelegation / createPreviewScheduler / createRafScheduler / highlightCodeBlocks / getStatusInfo / countWords / estimateReadingMinutes / shouldSkipRender / resolveLocalImages / resolveLocalImages / detectInitialTheme / extractToc / renderToc / wrapHtmlDocument / triggerDownload / computeBlockLineNumbers) + 182 行 `md-splitter.ts` + ~1000 行测试(Week 1-5 共 99 case)+ ~700 行 `editor.css`(GitHub + GitHub-Dark hljs 主题 + toolbar / status / splitter a11y / TOC 侧栏)。CodeMirror 6 + `marked`(GFM 默认开) + DOMPurify + `highlight.js` + `@codemirror/search`,左编辑右预览分屏 + 工具栏(Find/Wrap/Zoom/TOC/Export) + 状态栏(Ln/Col/Length/Sel/Words/Reading/Modified/Read-Only/UTF-8) + TOC 侧栏。**Week 1-5 改造后**:`index.ts` 只剩 CodeMirror 生命周期 / 主题 / 消息路由 / 工具栏 wire / 状态栏 wire;`md-render.ts` 已经积累 16 个纯函数;splitter 拖拽逻辑走独立 `md-splitter.ts`;`FileContentMessage` 协议加可选 `dirPath` 字段。

**管线**:

```
双击 .md / .markdown
  → ExtensionHost postMessage fileContent(path + content)
  → handleMessage → setContent → scheduler.cancel() + view.dispatch(replace) + renderPreview
  → 编辑修改 → scheduler.schedule(getDoc, onRender)  (300ms 防抖 + Symbol token 守卫)
    → marked.parse → DOMPurify.sanitize → previewPane.innerHTML
  → 编辑修改 → contentChangedInEditor 通知 host(脏状态)
  → Mod-s / requestSave → parentSaveDocument → 主进程写盘 + revision
```

**iframe**([src/extensions/md-editor/index.ts](../src/extensions/md-editor/index.ts) + [src/extensions/md-editor/md-render.ts](../src/extensions/md-editor/md-render.ts)):

- CodeMirror 6 基础套件:lineNumbers / highlightActiveLineGutter / history / markdown language / oneDark compartment / readOnly compartment
- `parseMarkdown` + `sanitizeMarkdownHtml` 走 `md-render.ts`,后者用 lazy 工厂模式(检测 `(DOMPurify as any).sanitize` 是否存在)在 browser 拿 instance / Node 拿 factory(window))
- 链接委托走 `setupLinkDelegation`(在 `index.ts` 顶层一次性 bind,`renderPreview` 不再 per-render `querySelectorAll`)
- 防抖调度走 `createPreviewScheduler(300)` 工厂(`schedule()` 每次 mint 新 `Symbol` token + `clearTimeout` 旧 timer;`setContent` / `fileContent` 路径先 `cancel()`)
- 滚动同步:editor `scroll` 事件触发 `syncPreviewScroll`,按比例 `previewMax = scrollHeight - clientHeight` 映射(Week 2 改为 source-line 对齐)
- 主题切换走 Compartment 重配;只读切换走 `EditorView.editable.of(...)`
- `applyTheme('light')` 在 `fileContent` 处理中写死(Week 4 改为 `detectInitialTheme` 兜底)
- 协议桥接:`ready` / `contentChangedInEditor` / `parentSaveDocument` / `editorSelection` / `openLinkExternally`

**已知取舍 / 遗留**:

**🔴 P0 — 硬伤**

1. **`#splitter` 拖拽未实现** ✅ 已修(2026-07-06 Week 2)— 抽到 [md-splitter.ts](../src/extensions/md-editor/md-splitter.ts) `setupSplitter({editorPane, previewPane, splitter, container})`,`index.ts` 顶层 wire。mousedown 在 splitter 上 + mousemove/mouseup 在 document 上(ratio clamp 0.2-0.8 + 双击 50:50 重置 + 键盘 Arrow/Home/End nudge + `role=separator` a11y + `body[data-editor-dragging=true]` visual feedback + localStorage 持久化到 `md-editor-split-ratio`)。见 [docs/09 §18.1.1](./09-known-issues.md)
2. **`renderTimeout` 路径切换竞态** ✅ 已修(2026-07-06 Week 1)— 拆成 [md-render.ts](../src/extensions/md-editor/md-render.ts) `createPreviewScheduler(delayMs)`,`schedule()` 内部 `clearTimeout` + `Symbol` token 校验;`setContent` / `fileContent` 路径先 `cancel()`。见 [docs/09 §18.1.2](./09-known-issues.md)
3. **滚动同步粗放** ✅ 已修(2026-07-06 Week 2)— `parseMarkdown` 改用 `Marked` singleton + `md.lexer` + `md.parser` 拆分,逐个 top-level block 注入 `data-source-line`;`syncPreviewScroll` 用 `view.lineBlockAtHeight` + `state.doc.lineAt` 找光标行号,`previewPane.querySelector('[data-source-line="N"]')` 定位,无 match 时回退比例。**关键陷阱**:marked lexer 显式塞 `space` token 表示 blank-line separator,朴素数 `raw.match(/\n/g).length` 会给所有 block 标 line 1。见 [docs/09 §18.1.3](./09-known-issues.md)
4. **代码块无语法高亮** ✅ 已修(2026-07-06 Week 2)— 新增 dep `highlight.js@^11.11.1`(~50KB gzip,common 35 语言),`md-render.ts` `highlightCodeBlocks(container)` 包装 `hljs.highlightElement`(幂等);`index.ts` `renderPreview` 在 innerHTML 后调;CSS 主题(轻量 GitHub + GitHub-Dark,inline `editor.css`)随 body[data-theme] 切换。见 [docs/09 §18.1.4](./09-known-issues.md)
5. **没有任何测试** ✅ 已修(2026-07-06 Week 1)— 新增 [md-render.test.ts](../src/extensions/md-editor/md-render.test.ts)(23 case / 5 suite),挂 `package.json:test`。见 [docs/09 §18.1.5](./09-known-issues.md)

**🟡 P1 — 体验短板**

6. **无工具栏** ✅ 已修(2026-07-06 Week 3)— 加 `#toolbar` 在 index.html + editor.css,5 按钮:Find (Ctrl+F, `openSearchPanel`)+ Wrap 切换 + Zoom In/Out/Reset (Ctrl+0/=/-,`fontSizeCompartment` 走 `EditorView.theme`)+ 状态指示 `#wrap-state`。localStorage 持久化 `md-editor-font-size` / `md-editor-wrap-mode`(`md-editor-` 前缀避免与 text-editor 冲突)。**未做**:Replace All / Fold / Goto Line(Week 5+ 候选)。见 [docs/09 §18.2.1](./09-known-issues.md)
7. **无状态栏** ✅ 已修(2026-07-06 Week 3)— 加 `#status`(22px 高度,GitHub-风格浅色 / `161b22` 深色),`md-render.ts` 纯函数 `getStatusInfo(state)` 提取 `line/col/length/selection/words`,`updateStatus(view)` 在 `EditorView.updateListener` 的 `docChanged || selectionSet` 时调;CJK 词数简化(连续 CJK 计 1 词)。`createEditor` 末尾 + `setReadOnly` 末尾 seed 一次(绕过 listener 不在 view 创建时 fire)。见 [docs/09 §18.2.2](./09-known-issues.md)
8. **本地相对路径图片破图** ✅ 已修(2026-07-06 Week 3)— **协议层**:`FileContentMessage` 加可选 `dirPath?: string`(backward-compat),`ExtensionHost.tsx` 用 `parentDir(filePath)` 透传。**扩展层**:`md-render.ts` 加 `resolveRelativeImagePath`(处理 scheme / Unix 绝对 / Windows 绝对 / UNC / 相对 / 无 dirPath)+ `resolveLocalImages(container, currentDir)`,后者先 `decodeURI` 还原 marked 对 src 的百分号编码(`./截图/x.png` 被 marked 编成 `./%E6…`;不还原的话 `encodeWhaleFileUrl` 会把 `%` 再编成 `%25E6`,主进程只解一层 → fs 去找字面 `%E6…` 文件名 → CJK / 空格图片 404),再调 `encodeWhaleFileUrl` 转 `whale-file://<encoded>`。**陷阱**:scheme 正则 `/^[a-z][a-z0-9+.-]*:/i` 会把 `C:\` 误判,改为白名单。**`..` 不客户端解析**(留给 host 端 whale-file:// handler 校验 allowed-roots)。见 [docs/09 §18.2.3](./09-known-issues.md)
9. **`previewPane.innerHTML = clean` 全量重排** ✅ 已修(2026-07-06 Week 4)— 双层节流:[md-render.ts `shouldSkipRender(lastContent, nextContent)`](../src/extensions/md-editor/md-render.ts) 纯函数在 `renderPreview` 入口短接同内容;`createRafScheduler()` 工厂把 `innerHTML` 突变对齐到浏览器 repaint。`setContent` 路径绕开 short-circuit + 强制 `lastRenderedContent = null`(新文件首字符相同也重绘)。见 [docs/09 §18.2.4](./09-known-issues.md)
10. **`applyTheme('light')` 写死** ✅ 已修(2026-07-06 Week 4)— 删 [index.ts `fileContent` 分支](../src/extensions/md-editor/index.ts) 的 `applyTheme('light')`;新增 [md-render.ts `detectInitialTheme()`](../src/extensions/md-editor/md-render.ts) 读 `window.matchMedia` 兜底;启动时 seed 一次。host `setTheme` 始终是 source of truth。见 [docs/09 §18.2.5](./09-known-issues.md)
11. **`schedulePreview` 缺 token 保护** ✅ 已修(2026-07-06 Week 1,随 #2)— `createPreviewScheduler` 工厂内部 Symbol 守卫,旧 token 自动失效
12. **GFM 任务列表 / 删除线默认关闭** ✅ 已修(2026-07-06 Week 4)— **marked v18 默认开启 GFM**(`marked.use({gfm: true, breaks: false})` 已在 Week 1 配好),task list `<input type="checkbox">` + `<del>` strikethrough 自动生效,`<input>` 走 HTML profile 默认白名单。**无需代码改动**,只补 4 case 回归测试。见 [docs/09 §18.2.7](./09-known-issues.md)

**🟢 P2 — 锦上添花**

13. **TOC / 大纲侧栏** ✅ 已修(2026-07-07 Week 5)— 抽 [`extractToc(markdown)`](../src/extensions/md-editor/md-render.ts) 纯函数(共享 `computeBlockLineNumbers` 跟 `parseMarkdown` 对齐行号)+ [`renderToc(container, entries, onSelect)`](../src/extensions/md-editor/md-render.ts) DOM 渲染;工具栏 `≡ TOC` 按钮 toggle `#toc-sidebar` hidden(240px 宽,按 `level` indent 12px/级);点击 anchor 调 `onSelect` 滚动 preview 到 `data-source-line` 块。`parseMarkdown` 同步给 heading 标 `id="md-h-{line}-{textLen}"` 跟 TOC 对齐。见 [docs/09 §18.3.1](./09-known-issues.md)
14. **导出 HTML** ✅ 已修(2026-07-07 Week 5)— [`wrapHtmlDocument(title, bodyHtml)`](../src/extensions/md-editor/md-render.ts) 包成完整 HTML 文档(~50 行 GitHub-风格 CSS,内联 `data-source-line` 保留) + [`triggerDownload(filename, content, mime)`](../src/extensions/md-editor/md-render.ts) 创 Blob + `<a download>` + synthetic click + 1s 后 `URL.revokeObjectURL`;工具栏 `⇩ HTML` 按钮,文件名 = path basename 去 `.md`/`.markdown` + `.html`。**PDF 导出**已移除(曾基于 pdf-lib 实现过 exportPreviewAsPdf,后移除以减 md-editor bundle ~270KB;pdf-lib 依赖保留给 thumbnail.test.ts 用)。见 [docs/09 §18.3.2](./09-known-issues.md)
15. **Mermaid / KaTeX** ✅ 已修(Mermaid 2026-07-07;KaTeX 2026-07-14)— mermaid v11 内部用 `new Function(...)`,需要 `unsafe-eval`,但**不放宽主 CSP** — 改用**沙箱 iframe 隔离**([src/extensions/md-editor/mermaid-sandbox.html](../src/extensions/md-editor/mermaid-sandbox.html))。沙箱 CSP 单独允许 `unsafe-eval`;主 iframe 用 `<iframe sandbox="allow-scripts" src="mermaid-sandbox.html">`(无 `allow-same-origin`)创建 — mermaid 跑代码但拿不到父 DOM / cookies / localStorage。[src/extensions/md-editor/md-sandbox.ts](../src/extensions/md-editor/md-sandbox.ts) `createMermaidSandbox()` 工厂管理 postMessage 协议,`e.source === iframe.contentWindow` 拒伪造响应。`renderMermaid` 走沙箱路径:占位 div + RPC → SVG 替换,失败回退原始 source + red border。Build 脚本加 [scripts/build-extensions.js](../scripts/build-extensions.js) md-editor 分支 copy `mermaid.min.js`(静态 `<script src>` 加载,不能 bundle)。Bundle 影响:`bundle.js` 从 4.1MB(内联)降回 865KB,沙箱按需加载 3.4MB。手动测试文件 [Test/mermaid-demo.md](../../Test/mermaid-demo.md) 覆盖 7 种 diagram + 错误注入 + js 不误捕 + 图片不干扰。**KaTeX** ✅ 同沙箱思路(独立 KaTeX iframe + postMessage + KaTeX 字体)。`$…$` inline 与 `$$…$$` block 均支持;**表格单元格 / 段中 `$$…$$`**(2026-07-20)由 [`katexInline`](../src/extensions/md-editor/md-render.ts) 的 display 分支接手 —— `katexBlock` 仅在行首触发,非行首的 `$$` 原本落到 inline 被错误拆成 `$` + inline + `$`,现统一渲染成 display placeholder(`data-katex-display="block"`),复用同一 `extractKatexBlocks` + `renderKatex` 管线(行首独占 `$$…$$` 仍走 block 优先)。见 [docs/09 §18.3.3](./09-known-issues.md)

16. **HTML 代码块静态预览**(2026-07-19)— ```` ```html ```` 块在预览区渲染为静态页面,不只是高亮源码:[md-render.ts](../src/extensions/md-editor/md-render.ts) `renderHtmlBlocks` 把 `pre:has(> code.language-html)` 换成 `<iframe sandbox="">` + srcdoc 载**剥离活动内容后的**源码(`stripActiveContent`:DOMParser 删 `<script>` / `on*` 属性 / `javascript:` URL —— 空 sandbox 反正全拦,先删掉免得 Chromium 每次刷一条 "Blocked script execution" 控制台报错;渲染结果不变)。**空 sandbox = 最强锁定:JS 一律不跑**(产品决策:只渲染不执行)。这同时终结了前两版方案的失败模式:① `allow-scripts` + srcdoc —— srcdoc 继承嵌入方 CSP(`script-src 'self'`),内联 JS 本来就死;② 沙箱页 `html-sandbox.html` + `document.write` —— JS 能跑,但测高 ResizeObserver 回路导致 iframe 不停拉伸(已回退并删除沙页)。禁脚本后两条路都无需再走;内联样式 / 布局 / 图片正常,表单与链接惰性。框高固定 240px + `resize: vertical` 可手拖加高,超高块内自滚 —— 无测高脚本、无反馈回路。hljs 选择器同步排除 `language-html`(与 mermaid 同款提前跳过)。wrapper 带「HTML」角标(与 `.code-lang` 同款视觉)。测试:md-render.test.ts `renderHtmlBlocks` 4 例(空块跳过 / 替换为空 sandbox iframe + srcdoc 带原始源且无 report 脚本 / 多块独立 / 活动内容剥离);手动用例 [Test/md-editor-showcase.md](../../Test/md-editor-showcase.md) 八节。
16. **persist font-size / wrap mode** ✅ 已修(2026-07-06 Week 3 工具栏)— `md-editor-font-size` + `md-editor-wrap-mode` localStorage key,`clampFontSize` 范围 10-32
17. **撤销/重做指示 + "Modified" 角标** ✅ 已修(2026-07-07 Week 5,Modified 角标部分)— 状态栏右侧 `#status-dirty` 元素(orange ● + Modified),`updateListener` docChanged 置 true,`savingFile` 消息置 false,`setContent` 置 false。**撤销/重做红点**未做(Week 6+ 候选)
18. **阅读时长 / 字数实时统计** ✅ 已修(2026-07-07 Week 5)— 字数在 Week 3 #7 状态栏 `Words` 字段;阅读时长 [`estimateReadingMinutes(text)`](../src/extensions/md-editor/md-render.ts) CJK-aware(英文 200 wpm + CJK 400 cpm),`englishWords = countWords - cjkRuns`,空 0 非空至少 1。状态栏 `Words.title` 显示 "N min read"

**callout(Obsidian / GitHub Alerts)+ 内嵌 HTML 标签**(2026-07-18 新增)— `> [!TYPE]` 渲染成带图标 / 颜色 / 可折叠的提示框(`note` / `tip` / `warning` / `danger` / `info` / `success` / `question` / `bug` / `important` / `caution` / `example` / `quote` / `abstract` / `failure` / `todo` 共 15 种 + 未知类型 fallback 到默认图标 + `callout-{type}` class)。支持自定义标题(空格 `> [!TYPE] 标题` Obsidian 风格,或冒号 `> [!TYPE]: 标题`)+ 折叠(`> [!info]-` 收起 / `+` 展开,标记须紧跟 `]`,故 `[!note] -5 度` 是标题而非折叠;用原生 `<details>` 无需 JS)。由 [`transformCallouts`](../src/extensions/md-editor/md-render.ts) 在 `parseMarkdown` 阶段把 `> [!TYPE]` blockquote 转成 callout(复用 DOMParser,保留 `data-source-line` 供 TOC / 滚动同步定位)。DOMPurify allow-list 同时扩展 `details` / `summary` / `kbd` / `mark` / `sub` / `sup` / `ins` / `del`,内嵌 HTML 渲染更丰富(`<style>` 仍禁)。

**块插入快捷键**(2026-07-19)— `Mod-Q`(Windows/Linux 为 Ctrl+Q,macOS 为 Cmd+Q)插入默认 `NOTE` callout;有选区时逐行转换为 callout 正文。`Mod-T` 打开 Typora 风格的表格尺寸弹窗,可输入 1–100 行、1–20 列,确认后插入 GFM 表格并把光标放进首个表头单元格。两项都进入 Settings 的 Markdown 快捷键配置,可重绑定或清除。表格弹窗按钮使用直接 click handler,不走原生 form submission,避免扩展 iframe 未开放 `allow-forms` 时提交被 sandbox 拦截。

**预览区域表格可编辑**(同日)— 每个 `<th>`/`<td>` 标 `contenteditable`,输入即时回写 CodeMirror 的对应行(`replaceTableCellInEditor` 通过 `replaceMarkdownTableCellText` 精确替换该列的源区间,转义裸 `|`(不再双重转义 `\` —— 否则 `$\frac{}$` 之类 LaTeX 命令会被写成 `\\frac`、KaTeX 当换行处理,公式坏掉)、合并空白、丢弃换行以保持表格合法)。Tab / Shift+Tab 在单元格间移动焦点,Enter 跳到下一行同列,↑/↓ 上下导航,Esc 失焦。`ctx.previewCellEditing` 在 cell focus/blur 期间屏蔽 `schedulePreview`,避免每次按键都重排预览并夺走光标;`addTableInteractivity` 的 `onCellBlur` 回调触发一次 rAF 重渲染以让文档其余部分同步。HTML 标签 `pre`/`code` 块不在范围内(继续用 hljs 高亮+Copy 按钮)。

**渲染主题预设**(2026-07-18)— [editor.css](../src/extensions/md-editor/editor.css) 全量变量化(35 个 `--md-*` 变量,6 组:基础 / chrome 交互 / code / mark / callout / hljs),`body[data-theme]` = 预设名。**9 个预设**:`github-light`(`:root` 默认)/ `github-dark` / `solarized-light` / `solarized-dark` / `dracula` / `nord` / `gruvbox` / `one-dark` / **`latex`(论文风,唯一带选择器版式规则:CJK 优先宋体正文(Noto Serif CJK → Songti → SimSun,Times 靠后防中文回退发虚)15px / 1.5 行距 / 两端对齐 + hyphens / 首行缩进 2em(列表/引用/callout/表格/脚注豁免);h1 黑体居中(四号),h2+ 宋体加粗左对齐无下框线 —— 中文论文「黑体一级居中 + 宋体加粗二三级」与 LaTeX article「全文同一衬线族」两条规范的合成;760px 居中栏;**表格走三线表**:顶/底 1.5px 粗线 + 表头下 0.75px 细线,无竖线无行线无底色,内容宽居中**);其余每个 = 一个纯变量覆盖块(Solarized / Dracula / Nord / Gruvbox / One-Dark 取各自官方调色板;hljs token 映射手填,因 highlight.js 只装了 github 系)。md-editor 主题**独立于 WhaleTag 全局 MUI 主题**:host `setTheme('light'|'dark')` 经 [index.ts `applyTheme`](../src/extensions/md-editor/index.ts) 记 `hostMode` → `resolvePreset()`/`applyPreset()`(默认映射 github-light/dark);工具栏 `<select id="select-theme">` 让用户固定预设(localStorage `md-editor-theme`,`auto` = 删 key)。`presetMode`:github-light / solarized-light / latex → light(默认 CM token),其余 → dark(CodeMirror `oneDark` token)。callout 6 组 + hljs token 随主题变量自动切换,无独立配置 UI。

**编辑区 CodeMirror 跟主题**(2026-07-18)— 两层:
- **结构色**(`.cm-editor` / `.cm-gutters` / `.cm-cursor` / `.cm-selectionBackground` / `.cm-activeLine` / `.cm-panels` / `.cm-searchMatch`)由 editor.css 的 `body[data-theme] .cm-*` 段用 `--md-*` 变量驱动(`body[data-theme]` 前缀盖过 oneDark 硬编码)。
- **markdown / 代码 token 色**(标题 / 链接 / 强调 / 引用 / keyword / string / number / comment)由 [`buildMdHighlightFromCss`](../src/extensions/md-editor/index.ts) 在运行时 `getComputedStyle` 读当前预设的 `--md-*` 值生成 `HighlightStyle.define`,`highlightCompartment` 在每次 `applyPreset` 重建(`data-theme` 设定后再读,拿到新预设的值)。`themeExtension` 因此改用 `oneDarkTheme`(只结构,不再用 oneDark 自带的 highlight)。此版 `@codemirror/language` 无 `classHighlightStyle`,故用动态 HighlightStyle(读 CSS 变量)代替语义 class + CSS 覆盖。
消除"选 Solarized/Dracula 时预览换色、左侧编辑区仍 github/oneDark"的左右割裂(token 也跟主题)。

**导出 HTML 跟主题**(同日)— [`wrapHtmlDocument`](../src/extensions/md-editor/md-render.ts) 的 `EXPORT_CSS` 全变量化(含 callout + hljs),签名加可选 `themeRootVars`;`exportPreviewAsHtml` 经 `readMdThemeVars()`(`getComputedStyle(document.body)` 读 35 变量)注入 `:root{...}` 块 → 导出文档带当前主题(移除原 `prefers-color-scheme` 媒体查询,导出固定为选中预设)。

**代码折叠**(2026-07-18)— `foldGutter()` + `foldKeymap`(`Mod-Alt-[` 折叠 / `Mod-Alt-]` 展开;Win/Linux = Ctrl-Alt、Mac = Cmd-Alt)+ 自定义 markdown heading `foldService`([`foldMarkdownHeading`](../src/extensions/md-editor/index.ts):折叠 `#` 标题到下一同级/更高级标题前;`lang-markdown` 不自带 heading fold)。markdown 总可折叠(无需 text-editor 的 `supportsFolding` 按文件判断)。无 Fold All 按钮(工具栏空间有限),靠 gutter marker + 快捷键。

**折叠预览联动**(2026-07-18)— [`applyFoldToPreview`](../src/extensions/md-editor/index.ts) 把编辑区的折叠同步到预览:`updateListener` 监听 CodeMirror `foldState` 变化(前后 `field` 引用 `!==`)→ 读 folded ranges 的起止行 → 预览区按 `data-source-line` 给**严格落在范围内**的 top-level block 加 `.fold-hidden`(`display:none`);标题 block 本身(`fromLine`)保留,折叠章节标题仍可见。`renderPreview` 末尾也调,新内容应用当前 fold 状态。TOC 不联动(保持全条目供导航)。

**代码块复制按钮**(2026-07-18)— [`addCodeCopyButtons`](../src/extensions/md-editor/md-render.ts) 给预览区每个 `<pre>` 加 hover 显示的 Copy 按钮,点击经 `navigator.clipboard.writeText` 复制代码(`whale-extension://` 是 privileged secure scheme,Clipboard API 在 iframe 内可用),1.5s "Copied!" 反馈。幂等(`:scope > .code-copy-btn` 去重,防重渲染双加)。`renderPreview` 在 `highlightCodeBlocks` 后调用。

**图片 Lightbox**(2026-07-18)— [`attachImageLightbox`](../src/extensions/md-editor/md-render.ts) 给预览区 `<img>` 加 click → [`openImageLightbox`](../src/extensions/md-editor/md-render.ts) 全屏暗色 overlay 放大查看;滚轮缩放(0.2–8×)、`R` 旋转 90°、`Esc` / 点 backdrop 关闭。自建 DOM + 自管 listener(关闭时 teardown)。幂等(`data-lightbox="1"` flag)。`renderPreview` 在 `resolveLocalImages` 后调用(此时 `img.src` 已是 `whale-file://`)。

**右键菜单 + 剪贴板粘贴桥**(2026-07-19)— [md-contextmenu.ts](../src/extensions/md-editor/md-contextmenu.ts) 扩展内自绘 DOM 菜单(不走 Electron native —— native 每条目状态都要 IPC 往返,自绘菜单打开时惰读 `ctx.view` 求值,样式复用 editor.css 的 `--md-*` 变量,菜单文案英文同 chrome 决策)。编辑区全菜单:Undo/Redo | Cut/Copy/Paste/Select All | Bold/Italic/Link/Heading(H1–3 + 增/减级子菜单) | Insert Callout/Insert Table… | Find & Replace/Go to Line | Word Wrap(勾选态)/Zoom In/Out/Reset | Export as HTML;预览区小菜单(Copy 选中文本 / Export as HTML)。**每次打开惰性求状态**:readOnly 禁全部编辑项(Undo/Redo/Cut/Paste/Bold/Italic/Link/Heading/Insert*),空选区禁 Cut/Copy。**粘贴无 iframe 原生通道**(Clipboard API 读文本被 Permissions-Policy 挡),走主进程桥:`requestClipboardText`(带 requestId)→ [rpc-cases.ts](../src/renderer/components/extension-host/rpc-cases.ts) forwardRpc → 主进程 `ext:readClipboardText`(Electron `clipboard.readText()`)→ `clipboardText` 回包,扩展侧 pending Map 按 requestId 解析插入光标处。菜单位置由纯函数 `computeMenuPosition` 做视口边缘钳制(4px margin);Esc / 外侧 mousedown / 动作触发后关闭。测试:[md-contextmenu.test.ts](../src/extensions/md-editor/md-contextmenu.test.ts) 8 例(构建 + 分组分隔符 / Heading 子菜单 / readOnly 禁用 / 空选区禁用 / 动作后关闭 / Esc + 外侧点击 / 边缘钳制 / 粘贴 round trip)。

**🛠️ 代码质量 & 安全**

19. **DOMPurify `style` 白名单太宽** ✅ 已修(2026-07-06 Week 1)— `DOMPURIFY_CONFIG` 拆到 [md-render.ts](../src/extensions/md-editor/md-render.ts),`ALLOWED_ATTR` 删 `style` **并加 `FORBID_ATTR: ['style']` belt-and-suspenders**(`USE_PROFILES: { html: true }` 默认放行 style,单删 `ALLOWED_ATTR` 不够)。见 [docs/09 §18.4.1](./09-known-issues.md)
20. **`renderPreview` 内重复绑定 click listener** ✅ 已修(2026-07-06 Week 1)— 抽 `setupLinkDelegation` 到 [md-render.ts](../src/extensions/md-editor/md-render.ts),`index.ts` 顶层一次性 bind,`renderPreview` 不再 per-render `querySelectorAll('a') + addEventListener`。见 [docs/09 §18.4.2](./09-known-issues.md)
21. **CSP `style-src 'unsafe-inline'`** 🟡 待修 — 配合 #19,移除 inline style,样式全交给 `editor.css` 选择器
22. **`applyTheme` 接受 `'light' | 'dark'`,但 host 端类型系统可能错传 `'system'`** ✅ 已修(2026-07-07 Week 5)— 扩 `applyTheme` 签名为 `'light' | 'dark' | 'system'`,`system` 走 `detectInitialTheme()`;加 `assertNever(x: never)` 防御守卫,任何 union 外值抛错 + 明确错误消息。

**推荐落地顺序**:

| 周次 | 任务 | 价值 |
|---|---|---|
| 1 | #2(timeout 竞态) + #20(事件委托) + #19(DOMPurify 收紧) + #5(加测试) | 改 4 处修 4 类 bug,无 UI 改动 ✅ |
| 2 | #1(splitter 拖拽) + #3(滚动同步精确化) + #4(代码块高亮) | 用户最直观感知 3 项 ✅ |
| 3 | #6(工具栏) + #7(状态栏) + #8(本地图片 + `FileContentMessage.dirPath` 协议扩展) | 复制 text-editor 经验,工作小收益大 ✅ |
| 4 | #10(theme 写死) + #9(innerHTML 节流) + #12(GFM) | 稳定性 + 渲染收尾 ✅ |
| 6 | #15(Mermaid 沙箱架构)✅ | KaTeX ✅(2026-07-14,同沙箱思路) |

**修法备注**:

- #1 splitter:`mousedown` → 监听 `mousemove` 调 `editorPane.style.flex = …` + `localStorage` 持久化比例
- #2 timeout ✅ → 见 [md-render.ts `createPreviewScheduler`](../src/extensions/md-editor/md-render.ts)
- #3 滚动同步:marked `walkTokens` 给每块加 `data-source-line`,scroll 时反查 `view.lineBlockAtHeight` 找最近行号,`scrollIntoView` 对应节点
- #4 代码块:集成 `highlight.js` 通用包,遍历 `previewPane.querySelectorAll('pre code')` 调 `hljs.highlightElement`
- #5 测试 ✅ → 见 [md-render.test.ts](../src/extensions/md-editor/md-render.test.ts)(23 case)
- #8 本地图片:DOMPurify 后遍历 `img[src]`,`img.src = encodeWhaleFileUrl(resolve(currentDir, src))`,复用 `src/shared/whale-file-url.ts`;**需 host 透传 `dirPath`** — `FileContentMessage` 当前只有 `path/content/encoding/readOnly/size`,需扩展 `src/shared/extension-types.ts` 加可选 `dirPath` 字段
- #9 innerHTML 节流:`requestAnimationFrame` + `DOMParser` Node 走 `replaceChildren`,或 diff patch(高门槛)
- #10 theme 写死:删 `applyTheme('light')`,等 host `setTheme` 消息;或读 `window.matchMedia('(prefers-color-scheme: dark)')` 兜底
- #11 token 保护 ✅ → 已并入 #2,见 `createPreviewScheduler`
- #12 GFM:`marked.use({ gfm: true, breaks: false })`
- #19 DOMPurify ✅ → `ALLOWED_ATTR` 删 `style` + `FORBID_ATTR: ['style']`
- #20 事件委托 ✅ → 见 `setupLinkDelegation`

**深度审查待优化(2026-07-18)** — 通读 index.ts(1459 行)/ md-render.ts(1883 行)/ md-sandbox.ts + katex-sandbox.ts / md-splitter.ts 后的待办清单(逐项对照过源码,非臆测;按收益排序):

> **进度(2026-07-18)**:🔴 四项已修 —— #1(`setContent` 加 `Transaction.addToHistory.of(false)`,切文件不进 undo 栈)、#2(状态栏拆 `updateCursorStatus` O(1) + `updateWordCount` debounced,光标移动不再跑全文词数)、#3(`countWords` CJK 按字符算 + 抽 `countCjkAndLatin` 与 `estimateReadingMinutes` 共用)、#4(mermaid / katex / hljs 全按 source 缓存:mermaid 用 `MERMAID_CACHE`,katex 用 inline/block 两个 Map,hljs 用 `JSON([className, source])` → 高亮 outerHTML;均 LRU cap 200)。**第二批**:🟠 #5(滚动同步 `scheduleSyncPreviewScroll` rAF 节流 + `previewLineMap` O(1) 查,`renderPreview` 末尾建图;配合预览区 wheel 转发到编辑区 scroller)、#6(`applyTheme` default 回退 `detectInitialTheme` + warn,删 `assertNever`,host 传坏值不再崩);🟡 #11(删 `md-sandbox.ts` + `katex-sandbox.ts` 死代码 `idCounter`)、#9(`editor.css` `'已折叠'` → `'collapsed'`,chrome 文案统一英文)。md-render 123 测试 + build:extensions 通过(type-check 仅剩 pre-existing 的 `src/renderer/domain/*.test.ts` import 路径错,与 md-editor 无关)。

> **第三批(2026-07-19)**:🟡 Mod-B/I/K 格式化快捷键已实现([`markdownFormattingKeymap`](../src/extensions/md-editor/index.ts) + `wrapSelection`,加粗/斜体/链接);🟠 sandbox 镜像重复已抽 [`md-sandbox-factory.ts`](../src/extensions/md-editor/md-sandbox-factory.ts) 的 `createPostMessageSandbox`(mermaid + katex 共用,`md-sandbox.ts` 150→63 行);🟡 沙箱 postMessage OR→AND 加固(factory messageHandler 要求 source 匹配 **且** shape 匹配,纵深防御)。md-editor 测试 143/143 过。**仍未做**:`index.ts` 主体拆分(1616 行,8 类关注点 → `md-toolbar`/`md-statusbar`/`md-theme`/`md-fold`)、§18.4.3 CSP `unsafe-inline` 收紧(mermaid 硬约束,接受现状)。注:本清单 🔴/🟠 各项(undo 泄漏 / 状态栏词数 / CJK 词数 / 预览缓存 / 滚动同步 rAF / `applyTheme` fallback / 死代码 / CSS 已折叠)的逐条 ✅ 修法记录见 [docs/09 §18](./09-known-issues.md),以彼为准。

**🔴 高(真 bug / 真 bottleneck)**

- **切文件 undo 跨文件泄漏**:[index.ts `setContent`:1339](../src/extensions/md-editor/index.ts#L1339) `view.dispatch({changes})` 没加 `Transaction.addToHistory.of(false)`,该 transaction 进 history;`fileContent` 复用 view([:1378](../src/extensions/md-editor/index.ts#L1378))。编辑 A → 切 B → 在 B 里 Ctrl+Z 会一路退回 A 内容。**修**:setContent 的 dispatch 加 `addToHistory.of(false)`,或 path 变化时 `view.setState(EditorState.create({...}))` 重建 state。
- **状态栏光标移动跑全文词数**:[index.ts:1106](../src/extensions/md-editor/index.ts#L1106) `selectionSet` 也触发 `updateStatus`;[md-render.ts `getStatusInfo`:748](../src/extensions/md-editor/md-render.ts#L748) 里 `doc.toString()` + `countWords` + `estimateReadingMinutes` 全 O(n) 全文扫描。大文档按方向键每次重扫。**修**:`selectionSet` 只更新 line/col/selection(廉价),`docChanged` 走 debounce 跑 word count。
- **CJK 词数不工作**:[md-render.ts `countWords`:743](../src/extensions/md-editor/md-render.ts#L743) 纯 `split(/\s+/)`,中文连续段落整段算 1 词(5000 字笔记状态栏 "Words: 1")。`estimateReadingMinutes` 已 CJK-aware,只有词数错(注释自标 §18.3.6 follow-up)。**修**:`countWords` 给 CJK 按字符算,阅读时间复用同一 helper 消重复正则。
- **预览每次编辑全量重跑 hljs/mermaid/katex**:[index.ts `renderPreview`:1012](../src/extensions/md-editor/index.ts#L1012) innerHTML swap 后节点全新,mermaid `data-mermaid="processed"` / katex marker / hljs `data-highlighted` 全丢 → 每个 debounce 停顿全量重发 sandbox;20 张 mermaid 图每次停 300ms 全量重渲染。**修**:按 source hash 缓存 `Map<hash, svg/html>`(WeakMap 键到节点),命中直接 innerHTML 缓存、不发 sandbox;沙箱端无需改。

**🟠 中**

- **滚动同步未 rAF 节流 + 强制布局抖动**:[index.ts `syncPreviewScroll`:552](../src/extensions/md-editor/index.ts#L552) scroll 回调里 `querySelector`(O(blocks))+ 两次 `getBoundingClientRect`(强制 layout),大文档掉帧。**修**:scroll 进 rAF + 渲染后建 `Map<lineNo, blockEl>` O(1) 查 + 用 `offsetTop` 替代 getBoundingClientRect。
- **`applyTheme` 未知值 `assertNever` 抛错**:[index.ts:849](../src/extensions/md-editor/index.ts#L849) host 传非 `light|dark|system`(运行时类型不保证)整个 md-editor iframe 崩、文件打不开。**修**:`default` 回退 `detectInitialTheme()` + `console.warn`;exhaustiveness 只做 TS 编译期、运行时不抛。零风险。
- **架构债** ✅ 已修(2026-07-19)— sandbox 镜像抽 [`md-sandbox-factory.ts`](../src/extensions/md-editor/md-sandbox-factory.ts) `createPostMessageSandbox`;[index.ts](../src/extensions/md-editor/index.ts) 主体 1616 → 441 行,8 类关注点按 feature 拆成 7 个模块,共享状态走 [`md-context.ts`](../src/extensions/md-editor/md-context.ts) 的 `ctx`/`dom` 单例:[md-statusbar](../src/extensions/md-editor/md-statusbar.ts)(109 行)/ [md-theme](../src/extensions/md-editor/md-theme.ts)(208)/ [md-fold](../src/extensions/md-editor/md-fold.ts)(136)/ [md-toc](../src/extensions/md-editor/md-toc.ts)(123)/ [md-scroll](../src/extensions/md-editor/md-scroll.ts)(164)/ [md-toolbar](../src/extensions/md-editor/md-toolbar.ts)(233)/ [md-keymaps](../src/extensions/md-editor/md-keymaps.ts)(124)。`index.ts` 只剩 iframe boot + `createEditor` 骨架(`updateListener` + extensions 组装 + `new EditorView` + 各 `setup*()`)+ `setContent`/`handleMessage`/`renderPreview` 编排。每 Phase 经 tsc + `build:extensions` + 143 测试兜底,零行为变更。

**🟡 低 / 加固**

- **沙箱 postMessage 用 OR 而非 AND** ✅ 已修(2026-07-19)— [`md-sandbox-factory.ts:98`](../src/extensions/md-editor/md-sandbox-factory.ts#L98) messageHandler 改 AND:要求 `e.source === contentWindow` **且** shape 匹配才放行(纵深防御;现代 Chromium `e.source` 比对可靠,shape 从"兜底"变"第二道闸")。原 OR 为兼容旧 Chromium `e.source` 不可靠,实际风险本有限(`data.id` 仍须匹配 pending RPC)。
- **CSS 硬编码中文 "已折叠"**:[editor.css:1328](../src/extensions/md-editor/editor.css#L1328) `content: '▸ ' attr(data-lang) ' · 已折叠'`,其他 chrome 全英文,不一致 → 改 `' · collapsed'`。
- **缺 Markdown 格式化快捷键** ✅ 已修(2026-07-19)— [`index.ts:1290`](../src/extensions/md-editor/index.ts#L1290) `markdownFormattingKeymap` + `wrapSelection(view, before, after)` 围绕选区包裹:Mod-B → `**…**`、Mod-I → `*…*`、Mod-K → `[…](url)`(`preventDefault` 拦浏览器原生 Mod-B/I)。CodeMirror `lang-markdown` 不带,自写。
- **死代码**:[md-sandbox.ts:92](../src/extensions/md-editor/md-sandbox.ts#L92) + [katex-sandbox.ts:73](../src/extensions/md-editor/katex-sandbox.ts#L73) `const idCounter = 0` 从不引用(实际用 `newMermaidId()` / `newKatexId()`),直接删。

**推荐落地**:先 🔴 #1(undo)+ #3(CJK)+ #2(状态栏)—— 真问题、改动小、纯函数好测;再 🔴 #4(预览缓存,收益最大工作量也最大,单独一轮);🟠 架构重构 + 🟡 安全加固最后。

## 5. 媒体与文档类

| 扩展 | 后端 |
|---|---|
| image-viewer | 原生 `<img>` + Lightbox 缩放 / pan / 旋转 / `flipH` / `flipV`;`<` `>` `Space` 等快捷键 |
| heic-viewer | libheif-js wasm 解码;大文件同步阻塞 → iframe 显示 "Decoding…" |
| pdf-viewer | 扩展 iframe 内 pdfjs 浏览器版 + `HostBinaryDataFactory`(经 host IPC 拿 cmap / 标准字体 / wasm)+ `<canvas>` 渲染 + fit W/P + 旋转 + 状态栏;CJK 字体自动回退系统。**大文件字节桥**(2026-07-18):host 不再 base64 整份 PDF(旧路径渲染进程逐字节 O(n²) 拼接 + IPC 膨胀 33% + iframe 再解码,峰值 ~3× 内存、主线程长阻塞),改为 host 经 `requestFileBytes`/`fileBytes` 读文件回传 `Uint8Array`(postMessage 结构化克隆,一次 memcpy,无 base64)→ `session.renderPdfBytes`;可选真 worker(`USE_PDFJS_WORKER`,`pdf.worker.mjs` 经 `whale-extension://` 加载)把解析移出主线程。office-viewer 仍走内存 bytes(LibreOffice 转换产物) |
| media-player | `<video>` / `<audio>` 流式播放;10 视频 + 16 音频。原生 / 视频 → `whale-file://`(主进程 Range 206 响应);**APE/WMA/AIFF/AMR/AC3/DTS/MPC/WV/DSF → `whale-audio://`**:主进程实时 ffmpeg → Opus 流式推给 `<audio>`(首播 ~1s 出声,不先把整份转码完),输出同步 tee 写入 `.whale/transcodes/<basename>.opus`,播完后即缓存,再开秒开 + 可拖动;`.opus` MIME `audio/opus`;playlist + 循环 + 速度 + 随机 + 进度记忆 |
| office-viewer | `requestOfficeConvert` → 主进程 `soffice --headless --convert-to pdf` → `officePdfContent` 推回 → iframe 内 pdfjs 浏览器版渲染到 `<canvas>`;fake worker + `HostBinaryDataFactory` 与 pdf-viewer 同款;**每次开档冷启动 soffice**(P3-1:冷转码 2-5s 期间并行 `requestThumbnail` 取缓存 jpg 当首页占位,不再空白);**UX 已与 pdf-viewer 对齐(§16.8)**:fit-width / fit-page / 手动缩放三档 + 每页独立旋转 + 跳页 input + prev/next + 键盘导航(PageUp/Down/Home/End/←/→/Ctrl+0/9/+/-)+ ResizeObserver CSS 重排 + rAF scroll 同步当前页 + 大小/页数 status 栏 + loading 进度条 |
| archive-viewer | 主进程 `archive.ts` + `7zip-bin` 二进制解码 9 种格式(zip / tar / tgz / tbz2 / txz / gz / bz2 / xz / 7z);双栏(文件树 + 预览);文本 utf-8 + 1MB 截断;图片 Blob URL;HTML 沙箱 iframe(无 `allow-same-origin`);二进制 hex head + 字节数;`__MACOSX/` 与 `.DS_Store` 过滤;> 50,000 entries 视为 zip-bomb 拒绝 |
| cad-viewer | WebGLRenderer + OrbitControls;Tier 0 (stl/obj/glb/gltf/ply) + Tier 1 (dxf,2D/3D) + Tier 1.5 (step/stp/iges/igs/brep 经 occt-import-js wasm) + Tier 2 (dwg 经 dwg2dxf / ODA File Converter) |
| ebook-viewer | fflate 解 EPUB/CBZ;FB2 XML 解析;MOBI/AZW/AZW3 经 Calibre CLI 转 EPUB;annotations JSON 存 `.whale/ebook-annotations/<basename>.json`;阅读进度 + 选区高亮 + Ctrl-F 跨章搜索 + 主题 |

### 5.1 office-viewer 当前实现要点

**管线**(端到端):

```
双击 .docx
  → ExtensionHost postMessage fileContent(只带 path)
  → openOfficeFile(path)
  → window.whaleExt.postMessage {type:'requestOfficeConvert', requestId, path}
  → 主进程 ExtensionHost.tsx 收 → ipcApi.convertOfficeToPdf(path)
  → ipcMain ext:convertOfficeToPdf → convertOfficeToPdf (office-convert.ts)
  → soffice --headless --convert-to pdf --outdir <whale-office-XXXX> <srcPath>
  → 读出 <basename>.pdf → ArrayBuffer IPC 推回
  → ExtensionHost postMessage {type:'officePdfContent', requestId, data}
  → renderPdf(bytes) 走与 pdf-viewer 同款 pdfjs 管线
  → <canvas> × N 页 appendChild
```

**主进程**([src/main/office-convert.ts](../src/main/office-convert.ts)):

- `convertOfficeToPdf(srcPath, options)` 走 `execFile(bin, ['--headless','--convert-to','pdf','--outdir',tmpDir, srcPath], {timeout: 120000})`
- `tmpDir` 用 `fsp.mkdtemp(os.tmpdir() + '/whale-office-')`,转换完 `fsp.rm(tmpDir, {recursive, force})`
- `bin` 来自 [src/main/office-binary.ts](../src/main/office-binary.ts) 的 `await sofficeBinary(override)`(`Promise<string|null>`,async — P1-1;从 `thumbnail.ts` 抽出,以解开原 `thumbnail.ts` ↔ `office-convert.ts` 循环依赖):`override` > `C:\Program Files\LibreOffice\program\soffice.exe` (Win) / `/Applications/LibreOffice.app/Contents/MacOS/soffice` (Mac) / `/usr/bin/soffice` / `/usr/lib/libreoffice/program/soffice` (Linux) > PATH `soffice --version` 异步探针(并发首调用 inflight 去重)
- `await isSofficeAvailable()` 探针同上,扩展不主动调,缺 soffice 时报 `'LibreOffice (soffice) not found'`

**iframe**([src/extensions/office-viewer/index.ts](../src/extensions/office-viewer/index.ts)):

- pdfjs worker 注入:`(globalThis as ...).pdfjsWorker = pdfjsWorker`,fake worker 模式与 pdf-viewer 同款,绕开 `worker-src` CSP
- `HostBinaryDataFactory` 把 cmap / standardFont / wasm 请求经 `window.whaleExt.postMessage({type:'requestPdfAsset', ...})` 推给宿主,宿主经 `ext:getPdfAsset` 从 `node_modules/pdfjs-dist/cmaps` 等读回;绕开 iframe `connect-src` 与 `registerFileProtocol` 不支持 fetch
- `getDocument({data, cMapPacked: true, cMapUrl:'cmap/', standardFontDataUrl:'font/', wasmUrl:'wasm/', isEvalSupported: false, BinaryDataFactory})`
- `outputScale = min(dpr, 2) * 1.5`,逐页 `getPage` → `getViewport({scale: outputScale})` → `canvas.width = floor(w*scale)` → `page.render({canvas, ctx, viewport}).promise` → `page.cleanup()`
- 显示三档(§16.8,镜像 pdf-viewer):manual 缩放 / fit-width / fit-page;canvas 位图按 `outputScale` 固定渲染,显示尺寸 = `baseVp × computeDisplayScale(mode,…)` 纯 CSS 重排(`relayoutPages`),切换不重新栅格化;`#toolbar`:prev / `#page-input`+`#page-count` / next / Fit W / Fit P / −/+ / ↶/↷;每页独立旋转走 `session.rerenderPage(pageNum, rotation)` 单页重栅格化;键盘导航(PageUp/Down/Home/End/←/→/Ctrl+0/9/+/-);ResizeObserver + rAF 仅 fit 模式重排;`computeDisplayScale` 同步传给 session(TextLayer 按显示比例布局,选区任何缩放下对齐)
- 进度 / 状态:`#loading-bar` 显 Converting → Loading → Rendering N/M(或错误,`data-state='error'`),`:empty` 隐藏 + `role="status"`;底部 `#status` 左文件大小(`fileContent.size`)右页数
- 主题:启动时 `applyTheme(detectInitialTheme())`(与 pdf-viewer 同款,消除深色用户白闪)
- 取消:`renderToken`(单调递增)在 `requestOfficeConvert` 之后每步 await 前比对;只取消 pdfjs 阶段,**soffice 阶段无法取消**(用户切换文件时旧进程继续跑完)
- `pendingAssets` / `pendingConversions` 两个 Map,**无超时清理**(主进程响应丢失时悬挂 resolver 永久驻留)

**i18n**:Strings + I18N 复用 pdf-viewer 共享的 7 个 key(`loading / failedDecode / rendering / failedRender / zoomIn / zoomOut / pageLabel`,见 `PDFJS_I18N`),`failedConvert` 等是 office-viewer 独有。

**已知取舍 / 遗留**(详见 [docs/09-known-issues.md §16](./09-known-issues.md)):

- ~~缺 pdf-viewer 同款 UX~~ ✅ 已修(2026-07-18,§16.8):fit-width / fit-page / 手动三档 + 每页独立旋转 + 跳页 input + prev/next + 键盘导航 + ResizeObserver 重排 + 大小/页数 status 栏 + loading 进度条全部落地;纯函数抽 [view-math.ts](../src/extensions/office-viewer/view-math.ts)(8 测试)
- ~~Buffer → ArrayBuffer 双重拷贝~~ ✅ 已修(2026-07-18,docs/15 P1-4,端到端 Uint8Array)
- ~~临时目录无启动清理~~ ✅ 已修(2026-07-18,§16.6,per-process 惰性清扫 + mtime 守卫)
- **缩略图占位** ✅ 已修(2026-07-15,P3-1):office-viewer 冷转码 2–5s 期间并行 `requestThumbnail` 取缓存 jpg 当首页占位,`renderPdf` 清占位画真页,不再空白
- ~~缺 soffice 路径用户配置入口~~ ✅ 已修(2026-07-18,§16.14):设置 → Extensions 的 LibreOffice 路径框(reducer `sofficePath` + 5 语言 locale 早有)现已打通 viewer 链路 —— ExtensionHost `requestOfficeConvert` / `requestSofficeCheck` 都带 override,`ext:isSofficeAvailable` 透传;路径框不再被缩略图开关门控(viewer 用户也能设)
- ~~缺 a11y~~ ✅ 已修(2026-07-18,§16.18):zoom 按钮补 `aria-label`(本地化,随 `applyLocale` 更新);`#status` 加 `role="status"`;每页 canvas 在共享渲染循环统一打 `role="img"` + `aria-label`(office-viewer 传本地化 `pageAriaLabel`,pdf-viewer 用默认英文 `Page N of M`)

**已修**(2026-07-06 改造):

- ✅ PDF 已缓存到 `.whale/transcodes/<basename>.pdf`(仿 transcode-cache,详见 [src/main/office-cache.ts](../src/main/office-cache.ts));inflight 去重 / move/copy/remove 钩子齐全
- ✅ soffice 参数已加 `--norestore --nologo --nofirststartwizard`(统一定义在 [office-binary.ts](../src/main/office-binary.ts) 的 `sofficeConvertArgs`)
- ✅ soffice stderr 已捕获并入 error message(`stdio: ['ignore', 'pipe', 'pipe']`)
- ✅ iframe 与 pdf-viewer 重复代码已抽到 [shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts);`requestAsset` 30s 超时,`doc.destroy()` 在 render 末尾调用
- ✅ office-viewer 启动已用 `detectInitialTheme()`(消除深色用户白闪)
- ✅ `office-convert.test.ts`(8 cases)+ `office-cache.test.ts`(11 cases)已挂 test 脚本
- **缺 a11y**:按钮只 `title` 无 `aria-label`,`#status` 不是 `role="status"`,`<canvas>` 无 alt
- **CSP `font-src` 未显式声明**:`default-src 'self'` 兜底但太宽

### 5.2 pdf-viewer 改进路线图 (Phase 1, 2026-07-06)

**目标**:12 个 PDF 相关的 TypeScript 错误归零 + 两套 render loop 合并为 1 套 + page/doc 生命周期 `try/finally` 兜底 + 6+1 单测覆盖。Phase 2/3(textLayer / 虚拟化 / 缩略图栏 / outline / 搜索)显式 out of scope。

**A1** `outputScale()` 未声明 ✅ 已修 — 旧 `pdf-viewer/index.ts:284, 361, 547` 三处 `outputScale()` 调用从未声明,运行时 `ReferenceError`。**修法**:`shared/pdfjs-in-iframe.ts:170` 把 `defaultOutputScale` 改为 `export function`(同款 PDFJS_I18N 模式),pdf-viewer `import { defaultOutputScale as outputScale }`(refactor 后 import 已删除,见 B1 — 整个 render loop 走 session 后 `outputScale` 由 session 内部消化)。

**A2** `doc.destroy()` 调用错 API ✅ 已修 — `shared/pdfjs-in-iframe.ts` 6 处 `doc.destroy()` 实际是 `PDFDocumentProxy` 没有 `destroy()`(只有 `cleanup(): Promise<any>`,见 `node_modules/pdfjs-dist/types/src/display/api.d.ts:1153`)。**修法**:6 处全改 `doc.cleanup()`,保留 `await` + `.catch(() => undefined)`;`destroy()` 自身变 `async`,内部 `await currentDoc.cleanup()`,签名 `void` → `Promise<void>`。同步修 pdfjs 6.0.227 静默 warn / worker stream 不释放的 long-standing 内存泄漏。

**A3** `page.cleanup().catch()` 调用错 API ✅ 已修 — `shared/pdfjs-in-iframe.ts` 3 处 `page.cleanup().catch()` 实际是 `PDFPageProxy.cleanup(): boolean`(见 `api.d.ts:1494`),不是 Promise。**修法**:删 `.catch()`,改 `page?.cleanup();`(B2 的 `try/finally` 兜)。pdfjs 内部 `try { _destroy() } catch { return false }` 自带失败处理,外层再包 try/catch 冗余。

**B1** 双 render loop 合并 ✅ 已修 — 旧 `pdf-viewer/index.ts:483-577` 的 `renderPdf`(~95 行)独立跑 `getDocument` + per-page loop,与 `office-viewer` 走 `session.renderPdfBytes` 是字符级复制。**修法**:
- `PdfjsSessionOptions` 新增 `onAfterPageRender(pageNum, canvas, baseVp, doc)` 钩子,在 session 内部 `renderOnePage` 末尾调一次
- `PdfjsSessionOptions` 新增 `onDocumentLoaded(pageCount)` 钩子,在 `getDocument.promise` resolve 后调一次(早于第一页 render)
- `PdfjsSession` 接口新增 `rerenderPage(pageNum, newRotation)` 方法
- pdf-viewer 的 `renderPdf` 缩成 50 行,内部只 `await session.renderPdfBytes(bytes)`;`rerenderPage` 缩成 3 行 forwarder
- 删 `rerenderAllPages`(死代码,`@internal` 未引用)+ `renderPageTo`(已不需要)+ `renderPdf` 主循环(~95 行)+ `state.doc` 字段(由 session 内部管理)
- **净删除 ~80 行**;office-viewer 不需改动(session 不传 `onAfterPageRender`,行为不变)

**B2** `try/finally` 包裹 page/doc 生命周期 ✅ 已修 — 旧 per-page loop 全部 `page.cleanup()` / `doc.cleanup()` 散落在 await 之后,任何 `page.render().promise` reject 都漏页面对象 + 字体引用 + cmap 注册表。**修法**:`renderOnePage(doc, n, scale, myToken)` 内部 `let page = null; try { ... } finally { page?.cleanup(); }`;外层 `try { for ... } finally { await doc.cleanup(); }`。finally 不吞原始 error(那仍冒泡到 caller → `onStatus({kind:'error'})` → UI 呈现)。

**B3** 单测覆盖 ✅ 已修 — 新文件 `src/extensions/shared/pdfjs-in-iframe.test.ts`(13 个 case,8 个 suite,覆盖:defaultOutputScale、detectInitialTheme、outputScale override、getToken cancellation 中断、session.cancel() 中断、destroy() 拒绝 pending asset、asset timeout 50ms、handleHostMessage 三分支、onDocumentLoaded + onAfterPageRender 顺序、`session.rerenderPage` 烟测),挂 `package.json:test` 脚本。**Mock 策略**:`createPdfjsSession` 新增 `pdfjsLib?: PdfjsLike` 形参(默认真实 import),测试用 `FakeDoc / FakePage / FakePagesEl` + `global-jsdom` 提供 DOM。**测试钩子**:`__setAssetRequestTimeoutForTest(ms) => restore` 让 timeout 测试不真等 30s。

**TextLayer** ✅ 已修(2026-07-06 Phase 2) — 每页 canvas 上方覆盖一层 `pdfjs-dist/legacy/build/pdf.mjs` 的 `TextLayer`,文字可选中 / 复制 / Ctrl+F。关键实现:
- `PdfjsSessionOptions` 新增 `computeDisplayScale(baseVp, rotation?)` 回调,由 pdf-viewer 传入其 `computeDisplayScale`(fit-width / fit-page / 手动缩放),textLayer 用 `display` 级别 viewport(而非 `outputScale` 的 retina 坐标),span 坐标与 CSS 显示的 canvas 对齐
- `renderOnePage` 把 canvas 包进 `<div data-page-container>`(`position: relative; display: inline-block`),textLayer div(`position: absolute; inset: 0; z-index: 0`) 挂其内
- `rerenderPage` 重建 container + canvas + textLayer,rotation 正确传透到 `computeDisplayScale` 和 `page.getViewport`
- viewer.css 加入 `.textLayer` 样式(transparent 文字 + selection 高亮 + endOfContent sentinel)
- 缩放 / fit-mode 重排时 textLayer 不 re-layout(这是一个已知取舍,下一轮可用 `TextLayer.update({viewport})` 修复)

**beforeunload teardown** ✅ 已加 — `pdf-viewer/index.ts:53` 顶部 `window.addEventListener('beforeunload', () => { void session.destroy().catch(() => undefined); })`,iframe 重载时释放 worker stream / 字体缓存(配合 A2 修复)。

**Bundle size**:删除死代码 + 重复逻辑,预期 `pdf-viewer/bundle.js` 降 3-5KB(实测见 `Verification` 节)。

**虚拟化** ✅ 已修(2026-07-07 Phase 2):`virtualize: true` 选项启用懒渲染,`IntersectionObserver` + `rootMargin` buffer 驱动,每页只有进入视口缓冲区才创建 canvas + TextLayer。占位 div 用第 1 页 baseVp + displayScale 估算高度,滚动条精确。内存约束在 ~11 页 canvas,不限总页数。

**§A3 容器不被 flex 压扁** ✅ 已修(2026-07-07 Phase 2,合并到上面的修复):

**根因**:`#pages` 是 `display: flex; flex-direction: column` 容器,典型 Electron 窗口下只有 ~1 viewport 高(~900px)。`<div data-page-container>` 是它的 flex 子项,**默认 `flex-shrink: 1`**,16 页 PDF 的容器被 flex 引擎平均压成 900/16 ≈ 56px 高,canvas 内部 841.89px 高但容器 `overflow: hidden` 把 canvas clip 到顶部 56px — 用户看到"16 页挤一起、每页细长条"。3 页 PDF 同理,每页被压成 300px。

**修法**:容器 cssText 末尾加 `flex-shrink: 0`(`renderPageContent` 创建的 inline-block 容器 + `renderVirtualized` 创建的占位 div),让 flex 引擎保留容器自然高度(841.89px)。容器溢出 `#pages` 的 overflow:auto 自然产生滚动条,用户滚看完整内容。

**易错点(踩过的)**:
- 用 `display: inline-block` + `align-items: center` + canvas-`max-width: 100%` 循环依赖 → 容器塌成 0 宽(第一轮错误方向)
- 用 `display: block; width: ${px}; height: ${px}; margin: 0 auto` + canvas-`width: 100%; height: 100%` → 容器被拉成 `#pages` 全宽,`displayHeight` 又因 `computeDisplayScale` 在 fit-width 状态读 `clientWidth` 报早被压成 22px(第二轮错误方向)
- 用 cssText 替换占位的 inline-block → 浏览器缓存占位 stale computed style,残留的 `width: 100%; height: ${estHeight}px` 影响新容器
- 用 `aspect-ratio` 算 canvas height → Chromium 对 `<canvas>` 把 `canvas.width/height` HTML attribute 的 intrinsic 尺寸排在 CSS `aspect-ratio` 之前,`aspect-ratio` 实际被忽略,canvas height 退回 intrinsic ratio × width 算出来的非常小值

**最终方案**:destroy + recreate 占位(`oldContainer.remove()` 后 `pagesEl.appendChild(newContainer)`),新容器 cssText = `position: relative; display: inline-block; overflow: hidden; flex-shrink: 0;`,canvas 显式 `width: ${baseVp.width}px; height: ${baseVp.height}px`(不用 aspect-ratio)。`onAfterPageRender` / `relayoutPages` 同步设 `width` 和 `height`(不只是 width)。`#pages canvas` CSS 删 `max-width: 100%; height: auto`(制造循环依赖的元凶)。

**测试**:`src/extensions/shared/pdfjs-in-iframe.test.ts` 加 4 个 case 覆盖新行为(显式 inline-block 容器无 placeholder 残留、canvas 显式 width+height 无 aspectRatio、占位 div 保留 `width: 100%; height: ${estHeight}px`、virtualize 时前 3 页换成新容器其余保留 placeholder)。

**未做(Phase 3,本 PR 明确不做)**:

- **缩略图侧栏**:复用 `.whale/thumbs/<basename>.jpg`(主进程 `thumbnail.ts` 已生成)。
- **PDF Outline** ✅ 已做(2026-07-18):底层 `doc.getOutline()` 数据 API 一直在(当年"PDFOutline 不在 6.0.227"指 pdfjs 的 viewer **组件**,非数据 API)。session 新增 `getOutline()` / `resolveDest(dest)`([shared/pdfjs-in-iframe.ts](../src/extensions/shared/pdfjs-in-iframe.ts));pdf-viewer 加左侧栏 `<aside id="outline-sidebar">` + toolbar `☰` 按钮切换,点击条目 `resolveDest`→页码→`gotoPage`(`gotoPage` 改查 `data-page-container`,虚拟化离屏页也命中,IO 自动补渲染);外部链接走 `openLinkExternally`。无 outline 时按钮禁用。单测 5 case 覆盖。
- **`PDFFindController`**:仅 `web` build 有,不在 `legacy`,Phase 3 或 skip。
- **CJK 字体显式注册**:Chromium `@font-face local()` 兜底够用,Phase 2 再考虑显式。
- **`session.destroy()` 主动 teardown**:`ExtensionHost` 销毁 iframe 时调用(目前只有 `beforeunload` 兜),Phase 2 集成。
- **TextLayer 缩放重排**:`TextLayer.update({viewport})` 在 fit-mode/zoom 变化后调用,让 text span 对齐新缩放。(当前行为:缩放后 textLayer 视觉偏移但功能正常)。
- **office-viewer UX parity** / **a11y** / **CSP** / **soffice fallback**:见 [docs/09 §16.8 / §16.18 / §16.20 / §16.21](./09-known-issues.md),out of PDF Phase 1。

**关联 §17**:3 个 bug 的同款记录见 [docs/09 §17.1 / §17.2 / §17.3](./09-known-issues.md)。

---

## 6. 双层 iframe 套第三方 webapp

`excalidraw-editor` 与 `drawio-editor` 共享这条拓扑:`ExtensionHost` (外层 iframe) → 内层 iframe 加载第三方 webapp。

**四件硬约束**(缺一不可):

1. **`registerSchemesAsPrivileged([{scheme:'whale-extension', privileges:{standard:true, secure:true}}])`** 必须在 `app.ready` 之前(`src/main/main.ts:207-240`);否则 origin 是 opaque,`document.cookie` 抛 `SecurityError`
2. **不要**给 `whale-extension://` 响应套主进程 CSP;`onHeadersReceived` 跳过该协议,由各扩展 meta CSP 治理
3. build 第三方 webapp 时**不要**过滤子目录;drawio `App.main` 同步等子资源 200,失败不发 `init`
4. 第三方 webapp 的 embed 协议经常"遗留字符串握手"+"结构化 JSON"两套;drawio 是 `proto=json` URL 参数切换

**excalidraw**:直接 `@excalidraw/excalidraw` 嵌入,scene restore + dirty 跟踪 + 从目录树拖文件嵌入(图片经原生嵌入;非图片插入带链接的缩略图,点击用系统程序打开)。

**drawio**(`useWhaleBridge.ts` + `drawio-bridge.ts`):

- `drawio-offline` webapp + `?proto=json` 结构化协议
- `EMPTY_DRAWIO` 单行占位符(`<diagram>` 紧跟 `<mxGraphModel>`,零空白),避免 `parseDiagramNode` children 分支失败
- Drawio 保存实测走 `export` action event(不是 `autosave`/`save`);bridge `dispatchDrawioMessage` 必须识别 3 种 event 统一映射到 `{kind: 'xml', xml}`
- drawio `editor.modified` 默认 false(画了 shape + 1.5s autosave timer 后才翻 true),工具栏 Save 不依赖 dirty 直接允许(未修改 = no-op 写盘)

## 7. 后台音乐 dock (BackgroundPlayerDock)

独立的 `media-player` 实例挂在主窗口底部(64px 高),跨 location / 跨 `activeView` 持续播放,不取代主区域。

**协议**(基于现有 `ExtensionMessage` + `HostMessage`):
- 入站(扩展 → host):
  - `requestFile` — 上下首 / 点播队列里的某行,host 解析成 `BackgroundPlayerContext.jumpTo`
  - `requestStreamingUrl` — 与全屏 viewer 走同一通路(host 按扩展名回 `whale-file://` 或 `whale-audio://`)
  - **新增** `requestOpenInView` — dock 的"放大"按钮,host 调 `openWithExtension` 把当前曲目升格成全屏 viewer;dock 状态保留
  - **新增** `requestHide` — dock 的"收起"按钮,host 设 `BackgroundPlayerContext.dismissed = true`
- 出站(host → 扩展):
  - `fileContent` — `BackgroundPlayerContext.currentPath` 变化时推送(走 streaming URL 转码通路,与全屏路径一致)
  - `siblings` — 把整个 `queue` 当作 siblings,让 prev/next 在队列内导航
  - `setTheme` / `setLocale` — 与全屏同步
  - `streamingUrl` — 协议层响应(媒体流式 URL)

**模式切换**:`?mode=bar` 通过 URL 查询参数传进去,扩展读 `location.search` 后给 `<body>` 设 `data-mode`,CSS 切换两套布局(`#toolbar`/`#stage`/`#playlist` 隐藏,`#bar` 显示)。同一份 playback / queue / loop / shuffle / rate / volume / progress 逻辑,DOM 形状不同 —— 0 行播放核心代码改动。

**状态共享**(localStorage):
- `media-player-volume` / `media-player-muted` / `media-player-rate` / `media-player-progress` — 与全屏 viewer **共用同一组 key**,用户在 dock 调好的音量进 viewer 也一致
- 新增 `media-player-bg-state` — `{ queue, currentIndex, dismissed }`,只 dock 用

**入口**(只通过右键菜单,双击行为不变):
- 单文件右键:「后台播放」(`EntryContextMenu.tsx`)
- 文件夹右键:「播放此文件夹」(`DirectoryTree.tsx`)— `ipcApi.listDirectory` + `isAudioFile` 过滤后调 `BackgroundPlayerContext.playEntries`
- dock 上的 `⛶` 按钮:`requestOpenInView`
- dock 上的 `×` 按钮:`requestHide`(dock 卸载,`dismissed=true` 持久化;下次入队时自动回来)

**Provider 嵌套**:`BackgroundPlayerContextProvider` 包在 `ExtensionContextProvider` 之外(见 [Root.tsx](src/renderer/containers/Root.tsx)),dock 自身是第二个 iframe 槽位,不与 `activeView` 抢 iframe。

## 8. 扩展 i18n

- host 语言变化 → push `setLocale` → `extension-api.js` 集中 `onLocale()` + `t(I18N)` → 工具栏 / 状态栏 / 菜单文案刷新
- pdf-viewer / office-viewer 已接入 en/zh;其他扩展需要时按同一模式(`interface Strings + I18N: Record<string, Strings> + let T + applyLocale()`)接入即可

## 9. 已知坑(在本模块反复踩)

详见 [docs/09-known-issues.md](./09-known-issues.md)。重点:

- `BINARY_EXT` 误加 `drawio` / `dio` → host 按 base64 注入 → `loadXml` 报 "Start tag expected"(mxfile 是 UTF-8 文本)
- drawio `readFirstDiagramXml` 对无 `%` 前缀的 body 盲目 inflate → "invalid bit length repeat"
- drawio `export` action event(不是 `autosave`/`save`)→ bridge 必须三事件统一映射
- drawio `editor.modified` 默认 false → Save 按钮不能依赖 dirty
- drawio embed 默认 `parent.postMessage('ready', '*')` 字符串握手 → 加 `?proto=json` 切到结构化协议
- pdf-viewer 大文件字节桥(2026-07-18):host 经 `requestFileBytes`/`fileBytes` 读文件回传 `Uint8Array`(postMessage 结构化克隆)→ `session.renderPdfBytes`,消除 base64 整文件(渲染进程 O(n²) 拼接 + 33% 膨胀 + iframe 再解码)。**不用 whale-file:// 流式**:`<video>` 能用(media 管线不经 CORS),但 pdfjs `getDocument({url})` 内部 fetch 触发 CORS,Chromium 协议级硬限制「跨源 fetch 仅限 http/https/data/chrome」,自定义协议被拒(`net::ERR_FAILED`)。`HostBinaryDataFactory` 仍经 host IPC 拿 cmap/字体/wasm。真 worker 可选(`USE_PDFJS_WORKER`,meta CSP `worker-src` 加 `whale-extension://*`,`build-extensions.js` 复制 `pdf.worker.mjs`);fake worker 默认(office-viewer 内存 bytes 不经此路径)
- `pdfjs-dist` `cMapUrl` / `standardFontDataUrl` 必须是**纯文件系统路径 + 结尾 `/`**(主进程路径,不是 `file://` URL)
- `pdfjs-dist` `cmaps/ standard_fonts/ wasm/` 已加进 `builder.json` `asarUnpack`
- 编辑器(CodeMirror) Compartment 切换不触发 `contentChangedInEditor`(vs. drawio 教训)
- Edit 工具在 Windows 偶发写入 `\0` null 字节 → grep 报 binary file → 用 Write 重写干净

## 10. 架构审阅遗留(2026-07-18)

- ~~`ExtensionHost.tsx` god-switch~~ ✅ 已拆(2026-07-18):16 个 `request* → reply` RPC case 下沉到 [extension-host/rpc-cases.ts](../src/renderer/components/extension-host/rpc-cases.ts) —— 通用 `forwardRpc` 关联 helper(ipcApi 调用 → 成功回包 / 错误回包,各 case 只给 reply 构造器),`createRpcHandler` 返回判别委托,非 RPC 消息回落组件内 switch;宿主文件 1076 → 761 行,消息 effect 的依赖数组从 9 项收到 6 项。测试:[rpc-cases.test.ts](../src/renderer/components/extension-host/rpc-cases.test.ts)(7 例:reply 形状 / 错误兜底 / sofficePath 透传 / 非 RPC 回落)。
- **postMessage `targetOrigin: '*'`**(ExtensionHost / extension-api.js 双向):接收端有 `event.source === iframe.contentWindow` 校验所以不算漏洞,但 `whale-extension://` 是特权 scheme,发往 iframe 的消息对同窗口任何 message 监听者可见,应收窄为具体 origin。
- ~~`archive.ts` `execFileSync('7za', timeout:3000)` 探测残留~~ ✅ 实为已修(2026-07-18 复核):7za PATH 探测与 list/extract 全走异步 `execFile` + `_sevenZipInflight` 首调去重(P1-1 同批),主进程无同步残留;本条是过时记录。
