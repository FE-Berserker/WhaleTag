← 返回 [plan.md](../plan.md)

# 07. 扩展系统

> 8 个内置扩展、manifest + iframe 沙箱 + postMessage 桥、按扩展名分发、修订历史、双层 iframe 套第三方 webapp 拓扑。

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
  text-editor/
  image-viewer/
  heic-viewer/
  excalidraw-editor/ drawio-editor/
  font-viewer/
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

**Host → Ext 全部消息类型**(`HostMessage` 联合,`src/shared/extension-types.ts:151-161`):

| 消息 | 用途 |
|---|---|
| `fileContent` | 文件内容(含可选 `size`)|
| `savingFile` | 正在保存,UI 反馈 |
| `setTheme` / `setReadOnly` / `setLocale` | 主题 / 只读 / 语言切换 |
| `requestSave` | 触发扩展保存 |
| `heicWasm` | HEIC wasm 经 host IPC 供给(绕 iframe CSP) |
| `externalDrag` / `fileEmbed` / `siblings` | 文件夹拖入 / 嵌入 / 同级条目 |

**Ext → Host 全部消息类型**(`ExtensionMessage` 联合,`src/shared/extension-types.ts`):

核心生命周期 / 编辑:`ready` / `loadDefaultTextContent` / `parentSaveDocument` / `contentChangedInEditor` / `editDocument`

资产请求:`requestHeicWasm`(heic-viewer wasm 经 host IPC 读取)

图片编辑:`requestFileEmbed` / `requestFile` / `thumbnailGenerated` / `openLinkExternally` / `error`

**安全**:iframe sandbox = `allow-same-origin allow-scripts allow-modals allow-downloads`;Host 只接受 `event.source === iframe.contentWindow`;每个扩展 HTML 自带严格 CSP meta。

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
- 编辑器脏状态经 `contentChangedInEditor` 上报;Save 触发 `parentSaveDocument` → `writeFileWithRevision`
- 编辑器保存前**自动备份**到 `.whale/revisions/<basename>/<timestamp>.<ext>`
- 启动清理 30 天前的旧 revision(`Root.tsx` 调 `cleanupRevisions(30)`)

**修订历史**:

- IPC `ext:backupRevision` / `ext:writeFile` / `ext:listRevisions` / `ext:restoreRevision` / `ext:deleteRevision`——均过 `assertWithinAllowedRoot`;`deleteRevision` 把 revision 路径绑定到所属文件的 `.whale/revisions/` 前缀(与 restore 相同),拒绝删除任意路径
- UI:`RevisionHistoryDialog`

**i18n**:host `setLocale` 推送,机制见 §8;全局类型抽到 `src/extensions/shared/whale-ext.d.ts`(扩展不再各自 `declare global`)。

## 4. 文本查看器 / 编辑器实现要点

| 扩展 | 引擎 | 关键功能 |
|---|---|---|
| json-viewer | 自研 | 折叠树 + Ctrl-F + Copy Pretty/Minified + Tree/Raw 切换 + 大文件保护(>50000 节点锁 Raw) + JSONPath 复制 |
| html-viewer | DOMPurify iframe | zoom + fit-width + 源码/预览 + 打印 + 图片开关 + 状态栏 |
| text-editor | CodeMirror 6 | 查找/替换 + 字体缩放 + Wrap + 状态栏 + 代码折叠(白名单语言) + **接管 txt/log/csv/tsv**(2026-07-06 合并自 text-viewer) |

**text-viewer 已废弃**(2026-07-06):原来的 txt/log/csv/tsv 全部归 text-editor。CSV 不再出表格视图;log 大文件不再有 banner / 虚拟化(交给 CM 自管)。text-viewer 特有的 CSV 表格视图 + autoLink + Phase 4c 虚拟化随目录删除。CodeMirror 自己能撑住 100k+ 行的 buffer;但 100MB+ 纯文本 `.log` 没有 banner 防御,直接打开可能 OOM —— 真遇到大 log 请用 `openNative` 让系统应用打开。

各查看器/编辑器共享 `src/extensions/shared/zoom.ts` 与 `keymap.ts`。

## 5. 媒体与文档类

| 扩展 | 后端 |
|---|---|
| image-viewer | 原生 `<img>` + Lightbox 缩放 / pan / 旋转 / `flipH` / `flipV`;`<` `>` `Space` 等快捷键 |
| heic-viewer | libheif-js wasm 解码;大文件同步阻塞 → iframe 显示 "Decoding…" |

✅ **pdf-viewer 已随 0.4.9 瘦身移除**(2026-09,连同 `shared/pdfjs-in-iframe.ts` 会话工厂、AI 框选提问管线 `askAi`/marquee/`aiDraftBus`/`AskQuestionDialog`、`requestFileBytes`/`fs:readFileRange` 字节桥、`requestPdfAsset` 资产服务)。PDF 文件本身仍受完整支持:**主进程**缩略图(`thumb-render.ts`,pdfjs 页 1 渲染)与全文索引(`fulltext.ts`)不依赖该扩展;`pdfjs-dist` 依赖与 `builder.json` asarUnpack 因此保留。

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

## 7. 扩展 i18n

- host 语言变化 → push `setLocale` → `extension-api.js` 集中 `onLocale()` + `t(I18N)` → 工具栏 / 状态栏 / 菜单文案刷新
- 各扩展按同一模式接入(`interface Strings + I18N: Record<string, Strings> + let T + applyLocale()`)

## 8. 已知坑(在本模块反复踩)

详见 [docs/09-known-issues.md](./09-known-issues.md)。重点:

- `BINARY_EXT` 误加 `drawio` / `dio` → host 按 base64 注入 → `loadXml` 报 "Start tag expected"(mxfile 是 UTF-8 文本)
- drawio `readFirstDiagramXml` 对无 `%` 前缀的 body 盲目 inflate → "invalid bit length repeat"
- drawio `export` action event(不是 `autosave`/`save`)→ bridge 必须三事件统一映射
- drawio `editor.modified` 默认 false → Save 按钮不能依赖 dirty
- drawio embed 默认 `parent.postMessage('ready', '*')` 字符串握手 → 加 `?proto=json` 切到结构化协议
- `pdfjs-dist` `cMapUrl` / `standardFontDataUrl` 必须是**纯文件系统路径 + 结尾 `/`**(主进程路径,不是 `file://` URL;缩略图 / 全文索引管线同样适用)
- `pdfjs-dist` `cmaps/ standard_fonts/ wasm/` 已加进 `builder.json` `asarUnpack`
- 编辑器(CodeMirror) Compartment 切换不触发 `contentChangedInEditor`(vs. drawio 教训)
- Edit 工具在 Windows 偶发写入 `\0` null 字节 → grep 报 binary file → 用 Write 重写干净

## 9. 架构审阅遗留(2026-07-18)

- ~~`ExtensionHost.tsx` god-switch~~ ✅ 已拆(2026-07-18):16 个 `request* → reply` RPC case 下沉到 [extension-host/rpc-cases.ts](../src/renderer/components/extension-host/rpc-cases.ts) —— 通用 `forwardRpc` 关联 helper(ipcApi 调用 → 成功回包 / 错误回包,各 case 只给 reply 构造器),`createRpcHandler` 返回判别委托,非 RPC 消息回落组件内 switch;宿主文件 1076 → 761 行,消息 effect 的依赖数组从 9 项收到 6 项。测试:[rpc-cases.test.ts](../src/renderer/components/extension-host/rpc-cases.test.ts)(7 例:reply 形状 / 错误兜底 / sofficePath 透传 / 非 RPC 回落)。
- **postMessage `targetOrigin: '*'`**(ExtensionHost / extension-api.js 双向):接收端有 `event.source === iframe.contentWindow` 校验所以不算漏洞,但 `whale-extension://` 是特权 scheme,发往 iframe 的消息对同窗口任何 message 监听者可见,应收窄为具体 origin。
- ~~`archive.ts` `execFileSync('7za', timeout:3000)` 探测残留~~ ✅ 实为已修(2026-07-18 复核):7za PATH 探测与 list/extract 全走异步 `execFile` + `_sevenZipInflight` 首调去重(P1-1 同批),主进程无同步残留;本条是过时记录。
