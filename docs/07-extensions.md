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

- `ExtensionHost.tsx` iframe 宿主,管理加载 / 消息桥 / 保存流程 / 工具栏
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
8. **本地相对路径图片破图** ✅ 已修(2026-07-06 Week 3)— **协议层**:`FileContentMessage` 加可选 `dirPath?: string`(backward-compat),`ExtensionHost.tsx` 用 `parentDir(filePath)` 透传。**扩展层**:`md-render.ts` 加 `resolveRelativeImagePath`(处理 scheme / Unix 绝对 / Windows 绝对 / UNC / 相对 / 无 dirPath)+ `resolveLocalImages(container, currentDir)`,后者调 `encodeWhaleFileUrl` 把 `<img src="./cover.png">` 转 `whale-file://<encoded>`。**陷阱**:scheme 正则 `/^[a-z][a-z0-9+.-]*:/i` 会把 `C:\` 误判,改为白名单。**`..` 不客户端解析**(留给 host 端 whale-file:// handler 校验 allowed-roots)。见 [docs/09 §18.2.3](./09-known-issues.md)
9. **`previewPane.innerHTML = clean` 全量重排** ✅ 已修(2026-07-06 Week 4)— 双层节流:[md-render.ts `shouldSkipRender(lastContent, nextContent)`](../src/extensions/md-editor/md-render.ts) 纯函数在 `renderPreview` 入口短接同内容;`createRafScheduler()` 工厂把 `innerHTML` 突变对齐到浏览器 repaint。`setContent` 路径绕开 short-circuit + 强制 `lastRenderedContent = null`(新文件首字符相同也重绘)。见 [docs/09 §18.2.4](./09-known-issues.md)
10. **`applyTheme('light')` 写死** ✅ 已修(2026-07-06 Week 4)— 删 [index.ts `fileContent` 分支](../src/extensions/md-editor/index.ts) 的 `applyTheme('light')`;新增 [md-render.ts `detectInitialTheme()`](../src/extensions/md-editor/md-render.ts) 读 `window.matchMedia` 兜底;启动时 seed 一次。host `setTheme` 始终是 source of truth。见 [docs/09 §18.2.5](./09-known-issues.md)
11. **`schedulePreview` 缺 token 保护** ✅ 已修(2026-07-06 Week 1,随 #2)— `createPreviewScheduler` 工厂内部 Symbol 守卫,旧 token 自动失效
12. **GFM 任务列表 / 删除线默认关闭** ✅ 已修(2026-07-06 Week 4)— **marked v18 默认开启 GFM**(`marked.use({gfm: true, breaks: false})` 已在 Week 1 配好),task list `<input type="checkbox">` + `<del>` strikethrough 自动生效,`<input>` 走 HTML profile 默认白名单。**无需代码改动**,只补 4 case 回归测试。见 [docs/09 §18.2.7](./09-known-issues.md)

**🟢 P2 — 锦上添花**

13. **TOC / 大纲侧栏** ✅ 已修(2026-07-07 Week 5)— 抽 [`extractToc(markdown)`](../src/extensions/md-editor/md-render.ts) 纯函数(共享 `computeBlockLineNumbers` 跟 `parseMarkdown` 对齐行号)+ [`renderToc(container, entries, onSelect)`](../src/extensions/md-editor/md-render.ts) DOM 渲染;工具栏 `≡ TOC` 按钮 toggle `#toc-sidebar` hidden(240px 宽,按 `level` indent 12px/级);点击 anchor 调 `onSelect` 滚动 preview 到 `data-source-line` 块。`parseMarkdown` 同步给 heading 标 `id="md-h-{line}-{textLen}"` 跟 TOC 对齐。见 [docs/09 §18.3.1](./09-known-issues.md)
14. **导出 HTML / PDF** ✅ 已修(2026-07-07 Week 5,HTML 部分)— [`wrapHtmlDocument(title, bodyHtml)`](../src/extensions/md-editor/md-render.ts) 包成完整 HTML 文档(~50 行 GitHub-风格 CSS,内联 `data-source-line` 保留) + [`triggerDownload(filename, content, mime)`](../src/extensions/md-editor/md-render.ts) 创 Blob + `<a download>` + synthetic click + 1s 后 `URL.revokeObjectURL`;工具栏 `⇩ HTML` 按钮,文件名 = path basename 去 `.md`/`.markdown` + `.html`。**PDF 部分**留二期(分页 + 字体嵌入复杂,价值低)。见 [docs/09 §18.3.2](./09-known-issues.md)
15. **Mermaid / KaTeX** ✅ 已修(Mermaid 2026-07-07;KaTeX 2026-07-14)— mermaid v11 内部用 `new Function(...)`,需要 `unsafe-eval`,但**不放宽主 CSP** — 改用**沙箱 iframe 隔离**([src/extensions/md-editor/mermaid-sandbox.html](../src/extensions/md-editor/mermaid-sandbox.html))。沙箱 CSP 单独允许 `unsafe-eval`;主 iframe 用 `<iframe sandbox="allow-scripts" src="mermaid-sandbox.html">`(无 `allow-same-origin`)创建 — mermaid 跑代码但拿不到父 DOM / cookies / localStorage。[src/extensions/md-editor/md-sandbox.ts](../src/extensions/md-editor/md-sandbox.ts) `createMermaidSandbox()` 工厂管理 postMessage 协议,`e.source === iframe.contentWindow` 拒伪造响应。`renderMermaid` 走沙箱路径:占位 div + RPC → SVG 替换,失败回退原始 source + red border。Build 脚本加 [scripts/build-extensions.js](../scripts/build-extensions.js) md-editor 分支 copy `mermaid.min.js`(静态 `<script src>` 加载,不能 bundle)。Bundle 影响:`bundle.js` 从 4.1MB(内联)降回 865KB,沙箱按需加载 3.4MB。手动测试文件 [Test/mermaid-demo.md](../../Test/mermaid-demo.md) 覆盖 7 种 diagram + 错误注入 + js 不误捕 + 图片不干扰。**KaTeX** ✅ 同沙箱思路(独立 KaTeX iframe + postMessage + KaTeX 字体),见 [docs/09 §18.3.3](./09-known-issues.md)
16. **persist font-size / wrap mode** ✅ 已修(2026-07-06 Week 3 工具栏)— `md-editor-font-size` + `md-editor-wrap-mode` localStorage key,`clampFontSize` 范围 10-32
17. **撤销/重做指示 + "Modified" 角标** ✅ 已修(2026-07-07 Week 5,Modified 角标部分)— 状态栏右侧 `#status-dirty` 元素(orange ● + Modified),`updateListener` docChanged 置 true,`savingFile` 消息置 false,`setContent` 置 false。**撤销/重做红点**未做(Week 6+ 候选)
18. **阅读时长 / 字数实时统计** ✅ 已修(2026-07-07 Week 5)— 字数在 Week 3 #7 状态栏 `Words` 字段;阅读时长 [`estimateReadingMinutes(text)`](../src/extensions/md-editor/md-render.ts) CJK-aware(英文 200 wpm + CJK 400 cpm),`englishWords = countWords - cjkRuns`,空 0 非空至少 1。状态栏 `Words.title` 显示 "N min read"

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

## 5. 媒体与文档类

| 扩展 | 后端 |
|---|---|
| image-viewer | 原生 `<img>` + Lightbox 缩放 / pan / 旋转 / `flipH` / `flipV`;`<` `>` `Space` 等快捷键 |
| heic-viewer | libheif-js wasm 解码;大文件同步阻塞 → iframe 显示 "Decoding…" |
| pdf-viewer | 扩展 iframe 内 pdfjs 浏览器版 + 线程内 fake worker + `HostBinaryDataFactory`(经 host IPC 拿 cmap / 标准字体 / wasm)+ `<canvas>` 渲染 + fit W/P + 旋转 + 状态栏;CJK 字体自动回退系统 |
| media-player | `<video>` / `<audio>` 流式播放;10 视频 + 16 音频。原生 / 视频 → `whale-file://`(主进程 Range 206 响应);**APE/WMA/AIFF/AMR/AC3/DTS/MPC/WV/DSF → `whale-audio://`**:主进程实时 ffmpeg → Opus 流式推给 `<audio>`(首播 ~1s 出声,不先把整份转码完),输出同步 tee 写入 `.whale/transcodes/<basename>.opus`,播完后即缓存,再开秒开 + 可拖动;`.opus` MIME `audio/opus`;playlist + 循环 + 速度 + 随机 + 进度记忆 |
| office-viewer | `requestOfficeConvert` → 主进程 `soffice --headless --convert-to pdf` → `officePdfContent` 推回 → iframe 内 pdfjs 浏览器版渲染到 `<canvas>`;fake worker + `HostBinaryDataFactory` 与 pdf-viewer 同款;**每次开档冷启动 soffice**(P3-1:冷转码 2-5s 期间并行 `requestThumbnail` 取缓存 jpg 当首页占位,不再空白);手动缩放 + rAF scroll 同步「当前页 / 总页」(P3-2),无 fit / 旋转 / 跳页 / 键盘导航 |
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
- `bin` 来自 [src/main/thumbnail.ts:111-159](../src/main/thumbnail.ts) 的 `await sofficeBinary(override)`(`Promise<string|null>`,async — P1-1):`override` > `C:\Program Files\LibreOffice\program\soffice.exe` (Win) / `/Applications/LibreOffice.app/Contents/MacOS/soffice` (Mac) / `/usr/bin/soffice` / `/usr/lib/libreoffice/program/soffice` (Linux) > PATH `soffice --version` 异步探针(并发首调用 inflight 去重)
- `await isSofficeAvailable()` 探针同上,扩展不主动调,缺 soffice 时报 `'LibreOffice (soffice) not found'`

**iframe**([src/extensions/office-viewer/index.ts](../src/extensions/office-viewer/index.ts)):

- pdfjs worker 注入:`(globalThis as ...).pdfjsWorker = pdfjsWorker`,fake worker 模式与 pdf-viewer 同款,绕开 `worker-src` CSP
- `HostBinaryDataFactory` 把 cmap / standardFont / wasm 请求经 `window.whaleExt.postMessage({type:'requestPdfAsset', ...})` 推给宿主,宿主经 `ext:getPdfAsset` 从 `node_modules/pdfjs-dist/cmaps` 等读回;绕开 iframe `connect-src` 与 `registerFileProtocol` 不支持 fetch
- `getDocument({data, cMapPacked: true, cMapUrl:'cmap/', standardFontDataUrl:'font/', wasmUrl:'wasm/', isEvalSupported: false, BinaryDataFactory})`
- `outputScale = min(dpr, 2) * 1.5`,逐页 `getPage` → `getViewport({scale: outputScale})` → `canvas.width = floor(w*scale)` → `page.render({canvas, ctx, viewport}).promise` → `page.cleanup()`
- 缩放由 CSS `canvas.style.width = '${zoom*100}%'` 实现;`#toolbar` 只两个按钮 `#zoom-in / #zoom-out` + `#zoom-level` 文本 + `#page-info`(`<n> / <total>`)
- 转换进度通过 `statusEl.textContent` 显示两段文案:`'Converting to PDF…'` → `'Loading…'` → `'Rendering <n> / <total>…'` → 空;无进度条 UI,无文件大小 / 总页数 status 栏
- 主题:启动时硬编码 `applyTheme('light')`,无 pdf-viewer 的 `detectInitialTheme()` 白闪缓解
- 取消:`renderToken`(单调递增)在 `requestOfficeConvert` 之后每步 await 前比对;只取消 pdfjs 阶段,**soffice 阶段无法取消**(用户切换文件时旧进程继续跑完)
- `pendingAssets` / `pendingConversions` 两个 Map,**无超时清理**(主进程响应丢失时悬挂 resolver 永久驻留)

**i18n**:Strings + I18N 与 pdf-viewer 重复 6 个 key(`loading / failedDecode / rendering / failedRender / zoomIn / zoomOut`),`failedConvert` 是 office-viewer 独有。

**已知取舍 / 遗留**(详见 [docs/09-known-issues.md §16](./09-known-issues.md)):

- **Buffer → ArrayBuffer 双重拷贝**:`convertOfficeToPdf` 返回 Buffer,IPC handler 再拷成 ArrayBuffer,然后 renderer 又 `new Uint8Array(msg.data)`,典型几 MB~几十 MB 浪费
- **临时目录无启动清理**:Electron 主进程在 soffice 运行中崩溃(断电 / kill -9),`whale-office-*` tmpDir 永久泄漏
- **缺 pdf-viewer 同款 UX**:fit-width / fit-page / 旋转 / 跳页 input / 键盘导航(PageUp/Down/Home/End/←/→/Ctrl+0/Ctrl+9/+/-)/ ResizeObserver 重排 / 滚动同步 currentPage / 文件大小与页数 status 栏,office-viewer 全部没接
- **缩略图占位** ✅ 已修(2026-07-15,P3-1):office-viewer 冷转码 2–5s 期间并行 `requestThumbnail` 取缓存 jpg 当首页占位,`renderPdf` 清占位画真页,不再空白
- **缺 soffice 路径用户配置入口**:`options.sofficePath` 接受 override,但 UI 没暴露,非标准安装位置即失败

**已修**(2026-07-06 改造):

- ✅ PDF 已缓存到 `.whale/transcodes/<basename>.pdf`(仿 transcode-cache,详见 [src/main/office-cache.ts](../src/main/office-cache.ts));inflight 去重 / move/copy/remove 钩子齐全
- ✅ soffice 参数已加 `--norestore --nologo --nofirststartwizard`(统一定义在 [thumbnail.ts](../src/main/thumbnail.ts) 的 `sofficeConvertArgs`)
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
- **PDF Outline**:`PDFOutline` 不在 6.0.227,需要手动解析或升级,Phase 3 或 skip。
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
- pdf-viewer iframe 内不碰主进程 CSP;fake worker + 自定义 `BinaryDataFactory` 绕 `connect-src` 与 `registerFileProtocol` fetch 限制
- `pdfjs-dist` `cMapUrl` / `standardFontDataUrl` 必须是**纯文件系统路径 + 结尾 `/`**(主进程路径,不是 `file://` URL)
- `pdfjs-dist` `cmaps/ standard_fonts/ wasm/` 已加进 `builder.json` `asarUnpack`
- 编辑器(CodeMirror) Compartment 切换不触发 `contentChangedInEditor`(vs. drawio 教训)
- Edit 工具在 Windows 偶发写入 `\0` null 字节 → grep 报 binary file → 用 Write 重写干净
