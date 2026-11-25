← 返回 [plan.md](../plan.md)

# 06. 缩略图管线

> 输出统一 JPEG 256px,存 `<dir>/.whale/thumbs/<basename>.jpg`。视频 / PDF / 字体 / 文件夹各自一个生成器,失败静默回退。

## 1. 当前支持的格式(`thumbKindOf` 分派)

[src/shared/whale-meta.ts](../src/shared/whale-meta.ts) `ThumbKind` 联合:

```ts
type ThumbKind = 'image' | 'svg' | 'video' | 'pdf' | 'font';
```

| kind | 后端 | 依赖 | 备注 |
|---|---|---|---|
| `image` | `sharp` | 内置 | 失败静默回退 image icon |
| `svg` | `encodeSvgThumb`(librsvg via sharp) | 内置 | vector,密度 oversample |
| `video` | `encodeVideoThumb`:`ffmpeg -ss 1 -frames:v 1` | `ffmpeg-static` | 短视频回退 `-ss 0` |
| `pdf` | `renderPdfThumb(srcPath)`:pdfjs 渲染首页 → napi canvas → sharp,跑在 `whale-thumb` utilityProcess | `pdfjs-dist` + `@napi-rs/canvas` | |
| `font` | `renderFontToPng`(`@napi-rs/canvas.GlobalFonts.registerFromPath`)→ "Aa" + pangram + 数字 | `@napi-rs/canvas` | `.eot` 不被支持 |

`thumbKindOf` 优先级:`svg` 单独排第一(via librsvg),然后 raster → video → pdf → font。`svg` 同时留在 `IMAGE_EXT`(让 `isImageFile` 仍返 true);`BINARY_EXT` 不含 `drawio/dio`(mxfile 是 UTF-8 文本,详见 [docs/07-extensions.md §8](./07-extensions.md))。

**不再出缩略图**(代码文件保留但 `thumbKindOf` 不命中,改走品牌图标):

- `excalidraw` / `drawio` / `dio` —— 缩略图太小看不清,改品牌图标
- Office(doc/xls/ppt/odt…) / 电子书(epub/mobi/azw3/fb2/cbz)—— 随 office-viewer / ebook-viewer 扩展一并移除,缩略图管线与 LibreOffice / Calibre 转换栈已删;这些格式显示品牌图标,双击走系统默认应用
- `caj`(CAJ 知网)—— CAJ\0 子型内嵌 PDF 对象流不规范,pdfjs 自动恢复失败;Whale 不实现 CAJ 缩略图与 viewer,双击走系统 CAJViewer
- `midi` / `.mid` —— 不出缩略图;`isAudioFile` 仍返 true 用于扩展 dispatch

**未在 `ThumbKind` 联合但由扩展直接打开的**:`heic/heif`(heic-viewer 走扩展,不依赖缩略图管线)。

## 2. 文件夹缩略图

- `wst.jpg`(文件夹缩略图)+ `wsb.jpg`(文件夹背景,1024px)
- `loadFolderThumbnail(dir)` 懒加载(IntersectionObserver + 4 并发 FIFO 队列)
- `setFolderThumbnail(dir, srcPath)` 手动设置；srcPath 可以是原生对话框从位置外选择的图片、SVG、视频、PDF 或字体，服务只读取源文件；已有缓存仅在不旧于源文件时复用，过期则直接重新编码到目标 `wst.jpg`，绝不创建或更新源目录的 `.whale/`
- `clearFolderThumbnail(dir)` 清除
- 右键菜单的封面/背景设置与清除统一捕获同步/异步错误并交给 `showError`；失败时不清空缩略图缓存
- `generateFolderThumbnail` 取目录内首张可缩略文件(`firstThumbnailableFiles` 不递归子目录,只看直接子文件),按文件名顺序最多试 `FOLDER_SOURCE_CANDIDATES = 8` 张:第一张损坏不再让整个文件夹失败,逐张跳过并 `console.warn`;全部失败时把该目录记入失败备忘 `FOLDER_FAIL_TTL_MS = 30s`,这 30 秒内不再重扫(上限 1000 条),成功生成或 `clearFolderThumbnail` 都会清掉这条记忆

`ThumbIcon.tsx` 是所有视图里文件夹缩略图的**唯一渲染路径**,守卫逻辑避免提前 return 跳过目录(`isDirectory && !canThumb` 当前正确短路)

## 3. 管线基础设施(格式无关)

[src/main/thumbnail.ts](../src/main/thumbnail.ts):

- `thumbPathFor(filePath)`(单参,内部拆出目录与文件名)→ `<dir>/.whale/thumbs/<basename>.jpg`
- 原子写 / mtime 缓存 / in-flight 去重 / delete/rename/move/copy 清理钩子**全部格式无关**
- **复用判据是 mtime + size**(`generatedFrom` 上限 5000 条):同一进程内生成过的 thumb 只有源文件 `mtimeMs` 与字节数都没变才复用;进程重启后内存无记录,退回 `target.mtimeMs >= source.mtimeMs` 的旧启发式(代价是保存后同秒内改内容仍可能显示旧图,换来冷启动不额外 stat 源文件)
- **ffmpeg 有超时**:`execFile` 带 `timeout: 10_000, killSignal: 'SIGKILL'`,损坏视频不再无限占住 worker 队列
- **渲染层缓存有上界**:[ThumbIcon.tsx](../src/renderer/components/ThumbIcon.tsx) 的 data-URL `Map` 在写入端淘汰(`THUMB_CACHE_LIMIT = 800`,FIFO),单条 256px/q80 约 10–20KB → 上限约 8–16MB;此前只在目录切换时清空
- `loadFolderThumbnail` / `loadFolderBackground`(主进程函数,各自 target path 为 key)只合并同目录**尚未 settle** 的加载:同目录并发共享一次 copy/read,thumbnail 与 background 不混用,不同目录互不影响;成功或失败都在 `finally` 清除 Map,失败会传给所有等待方且下一次可立即重试。后续调用会重新读盘,不把结果持久缓存在 JS;空目录的 `null` 也不做跨批次缓存,因此新增首张可缩略文件后不会被旧空结果遮住,代价是分离的多次空目录加载仍可能各自扫描。背景读取经 `thumbnail:loadFolderBackground` 暴露给文件列表,渲染层在目录切换及设置/清除后重新加载,慢响应按 effect 清理丢弃。
- 失败一律静默回退类型图标(FileTypeIcon),不阻塞其它缩略图
- **主进程并发闸门**([src/main/concurrency.ts](../src/main/concurrency.ts) 的 `Semaphore`):`thumbnailSemaphore` 限制同时进行的缩略图编码数(sharp / ffmpeg / pdfjs),只包住编码那一段,后续写盘不持锁。`setFolderBackground` 的 sharp 读取/旋转/缩放/JPEG 编码也进入同一个 4 路信号量,异常经 `finally` 释放许可;目标 `wsb.jpg` 的小型原子写不持锁。
- **ffmpeg 路径**:`ffmpegPath()` 取 `ffmpeg-static` 自带二进制,打包态把路径里的 `app.asar` 换成 `app.asar.unpacked`;缺失时返回 `null`,视频缩略图直接回退类型图标(不做 PATH 探测)。
- **pdfjs 惰性**:PDF 缩略图用的 pdfjs-dist 经 `getPdfjs()`(`nodeRequire`)在首次 PDF 缩略图时才 load,不在启动顶层(见 [docs/01 §4](./01-architecture.md))。专用 utilityProcess 通过 `withPdfjsNodeRuntime()` 包裹首次 load:加载期间临时把 Electron 的 `process.type === 'utility'` 规范化为 `browser`,使 pdfjs 选择 Node canvas / image factories 而非 DOM factories;加载结束或抛错后立即恢复原 property descriptor。
- **扫描版 PDF 需要 wasm 解码器**:`renderPdfThumb` 通过 `wasmUrl` 指向 `pdfjs-dist/wasm/`(普通路径 + 结尾 `/`),JPEG 2000 / JBIG2 / CCITT 传真图像由其中的模块解码。未设置时 pdfjs 丢弃图片但仍完成渲染,曾导致整页空白;2026-11-24 已修复,并由 [thumb-render.test.ts](../src/main/thumb-render.test.ts) 配合 [samples/pdf](../samples/pdf/) 的 JPEG 2000 / CCITT G4 样本覆盖。

## 4. ThumbIcon 加载机制(前端)

[src/renderer/components/ThumbIcon.tsx](../src/renderer/components/ThumbIcon.tsx):

- 每个 cell 用 IntersectionObserver 监听,带 200px lookahead
- 加载请求进 [src/renderer/services/thumb-load-queue.ts](../src/renderer/services/thumb-load-queue.ts) FIFO 队列,`MAX_CONCURRENT = 4`(对齐 sharp worker pool)
- 同 key 去重;scroll-out 调 `cancelThumbLoad` 摘除未启动的 task
- `thumbCache` key = `${path}|${modified}` → data URL,卸载 / 复用时 `observed` 标志丢弃"in-flight 完成后但 cell 已 recycle"的脏结果;`cacheKey` 变化时还会清空上一张图与 `loaded` 标记——否则没有 React key 的复用单元格会短暂显示上一个文件的缩略图,或因 `loaded` 仍为 true 而跳过 Skeleton
- **IO `observed` 双向同步**:`isIntersecting: true` 分支复位 `observed = true`,`false` 分支置 `false`。否则快速滚过的 cell 永远停在 Skeleton,滚回视口也不会再填充(细节见 [docs/09-known-issues.md §12](./09-known-issues.md))
- 加载/解码失败会 catch 并回退类型或文件夹图标，不产生 unhandled rejection；失败结果不写 `thumbCache`，之后重新进入视口仍可重试

## 5. 按格式区分的回退图标

[src/renderer/components/FileTypeIcon.tsx](../src/renderer/components/FileTypeIcon.tsx) + [src/renderer/domain/file-icon.ts](../src/renderer/domain/file-icon.ts):

- **39 类** `FileIconCategory`(完整列表,不是 19):`image` / `video` / `audio` / `pdf` / `word` / `excel` / `ppt` / `archive` / **`javascript`** / **`typescript`** / **`html`** / **`css`** / **`python`** / **`java`** / **`cpp`** / **`csharp`** / **`go`** / **`rust`** / **`shell`** / **`database`** / **`matlab`** / **`json`** / **`notebook`** / **`design`** / **`email`** / **`link`** / **`diskimage`** / `code` / `markdown` / `text` / `data` / `ebook` / `caj` / `drawio` / `excalidraw` / `font` / `model3d` / `executable` / `generic`
- 大小写不敏感;多点名取最后一段(`archive.tar.gz` → archive、`app.min.js` → code);dotfile(`.gitignore`) / 无扩展名 → `generic`
- Office 格式在 `file-icon.ts` 本地集合基础上按 word/excel/ppt **三分**(`rtf→word`、`csv/tsv→excel`,仅图标)
- **CAJ 类**含 `caj / kdh / nh / caa / teb`(`CAJ_EXT`),显示 `SchoolIcon`

**`archive` 类**:`file-icon.ARCHIVE_ICON_EXT`(14 种,**仅图标用途**)覆盖 `zip, tar, gz, tgz, 7z, rar, bz2, tbz2, xz, txz, zst, lz, lzma, cab`;全部显示 `FolderZip` 图标,双击走系统默认应用(archive-viewer 已随瘦身移除)。

**`font` 类**:`file-icon.ts` 自带本地 `FONT_EXT = {ttf, otf, woff, woff2, eot}`(比 `whale-meta.FONT_EXT` 多 `.eot`,因为 `.eot` 是 legacy IE 格式,**能被 Chromium font-face 解析**,但 `@napi-rs/canvas` 解不出来所以不出缩略图)。**`font-viewer` 扩展接受 ttf/otf/woff/woff2**,`.eot` 不被打开(manifest 不含)。

**`model3d` 类大表细分**(品牌色优先,非品牌色共用 `#00897b` `ViewInArIcon`;图标取 `brand?.Icon ?? 类图标`,所以只配了品牌色的条目仍显示 `ViewInArIcon`):

| 扩展 | 品牌 | 图标 |
|---|---|---|
| `blend` | Blender 橙 | `DesignServicesIcon` |
| `ma`, `mb` | Maya 青 | `ViewInArIcon`(未配专属图标) |
| `max` | 3ds Max 蓝 | `ViewInArIcon`(未配专属图标) |
| `skp` | SketchUp 红 | `ViewInArIcon`(未配专属图标) |
| `c4d` | Cinema 4D 蓝 | `ViewInArIcon`(未配专属图标) |
| `3dm` | Rhino 黑 | `ViewInArIcon`(未配专属图标) |
| `ztl`, `zpr` | ZBrush 橙 | `ViewInArIcon`(未配专属图标) |
| `catpart`, `catproduct`, `catdrawing` | CATIA 深蓝 | `ArchitectureIcon` |
| `prt` | Creo 橙 | `DesignServicesIcon` |
| `sldprt`, `sldasm`, `slddrw` | SolidWorks 红 | `PrecisionManufacturingIcon` |
| DWG / DXF (`dwg`, `dxf`) | AutoCAD 红 | `ArchitectureIcon` |
| 通用 stl/obj/glb/gltf/ply/step/stp/iges/igs/brep/fbx/dae/3ds/3mf | — | `ViewInArIcon` |

接入点:`ThumbIcon.tsx`(列表 / 网格 / 画廊 / 属性托盘 / 搜索结果行的回退分支)/ `SearchBar.tsx` / `AdvancedSearchDialog.tsx` 结果行(`size={20}` 对齐 small)。

文件夹图标保持 `FolderIcon`,不被 FileTypeIcon 接管。

**drawio / excalidraw 不使用 MUI 图标**:直接显示品牌应用图标(`src/renderer/assets/drawio-icon.png`、`excalidraw-icon.svg`),原因见 §1(场景缩略图小尺寸看不清)。

## 6. 缓存与生命周期

- 已生成的缩略图命中缓存,无重新生成的闪烁
- 文件 delete / rename / move / copy → 对应 `.whale/thumbs/<basename>.jpg` 跟随清理
- 同一文件并发只生成一次(in-flight 去重)
- 单个文件生成失败不影响其它

## 7. 已知取舍

- `.eot` 出图但 `font-viewer` 不打开;`whale-meta.FONT_EXT` 不收它(避免无人看的缩略图)
- PDF 渲染器在 `whale-thumb` utilityProcess(@napi-rs/canvas,见 §8),不带 CJK 字体替换表 —— 部分 PDF 标题可能显示为 notdef 方框;PDF 渲染扩展走 Chromium 自动字体补字形,缩略图级别可接受
- 缩略图大小写不敏感(`.PDF`/`.Pdf` 同样识别);多段名 / dotfile 归并规则见 §5
- 同类别内不同格式暂不细分(JS/Python/Go 都是青色 `Code`),如需字母角标则在 `FileTypeIcon.tsx` 叠加 `Typography`,不改 `file-icon.ts` 类别映射
- 大文件保护不在缩略图管线(只有 video 首帧快)

## 8. 架构审阅遗留(2026-07-18)

- ✅ **纯 JS CPU 已下沉 utilityProcess**(2026-07-18 修):pdf / font 渲染(pdfjs `page.render`、font canvas 光栅化)移入 `whale-thumb` utilityProcess(thumb-worker.ts,镜像 index-worker 三件套);image 走 sharp libuv 线程池、video 本来就是子进程,故留主进程。测试环境(ELECTRON_RUN_AS_NODE,`utilityProcess.fork` 不可用)下 host 进程内回退,直调同一套 thumb-render 函数。(ebook 封面提取原在此列,随 ebook-viewer 移除。)
