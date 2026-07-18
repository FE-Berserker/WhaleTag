← 返回 [plan.md](../plan.md)

# 06. 缩略图管线

> 输出统一 JPEG 256px,存 `<dir>/.whale/thumbs/<basename>.jpg`。视频 / PDF / Office / 电子书 / 字体 / 文件夹各自一个生成器,失败静默回退。

## 1. 当前支持的格式(`thumbKindOf` 分派)

[src/shared/whale-meta.ts](../src/shared/whale-meta.ts) `ThumbKind` 联合:

```ts
type ThumbKind = 'image' | 'svg' | 'video' | 'pdf' | 'office' | 'ebook' | 'font';
```

| kind | 后端 | 依赖 | 备注 |
|---|---|---|---|
| `image` | `sharp` | 内置 | 失败静默回退 image icon |
| `svg` | `encodeSvgThumb`(librsvg via sharp) | 内置 | vector,密度 oversample |
| `video` | `encodeVideoThumb`:`ffmpeg -ss 1 -frames:v 1` | `ffmpeg-static` | 短视频回退 `-ss 0` |
| `pdf` | `encodePdfThumb`:pdfjs 渲染首页 → napi canvas → sharp | `pdfjs-dist` + `@napi-rs/canvas` | |
| `office` | `encodeOfficeThumb`:探测 LibreOffice → 转 PDF → 复用 pdf | 系统装 LibreOffice | 缺失回退图标 |
| `ebook` | `ebook-cover.ts`:EPUB/CBZ(fflate)/ FB2(XML)/ MOBI/AZW/AZW3(手写 PalmDB+EXTH) | `fflate` | |
| `font` | `renderFontToPng`(`@napi-rs/canvas.GlobalFonts.registerFromPath`)→ "Aa" + pangram + 数字 | `@napi-rs/canvas` | `.eot` 不被支持 |

`thumbKindOf` 优先级:`svg` 单独排第一(via librsvg),然后 raster→ video → pdf → office → ebook → font。`svg` 同时留在 `IMAGE_EXT`(让 `isImageFile` 仍返 true);`BINARY_EXT` 不含 `drawio/dio`(mxfile 是 UTF-8 文本,详见 [docs/07-extensions.md §8](./07-extensions.md))。

**不再出缩略图**(代码文件保留但 `thumbKindOf` 不命中,改走品牌图标):

- `excalidraw` / `drawio` / `dio` —— 缩略图太小看不清,改品牌图标
- `caj`(CAJ 知网)—— CAJ\0 子型内嵌 PDF 对象流不规范,pdfjs 自动恢复失败;Whale 不实现 CAJ 缩略图与 viewer,双击走系统 CAJViewer
- `midi` / `.mid` —— 不出缩略图;`isAudioFile` 仍返 true 用于扩展 dispatch

**未在 `ThumbKind` 联合但 `whale-meta.ts` 拥有扩展名集合的**:

- `CAD_EXT` / `CAD_HEIC` / `CAD_HEIF`(cad-viewer / heic-viewer 走扩展,不依赖缩略图管线)
- `AUDIO_TRANSCODE_EXT`(media-player 转码,不走缩略图)

**音频文件 gating**:`isAudioFile` 不存在;audio 通过 `media-player` 扩展播放,需要转码的格式用 `isAudioTranscodeFile(name)`(`whale-meta.ts:240`)判定,在 `ThumbIcon` 回退路径中按 `audio` 类图标。

## 2. 文件夹缩略图

- `wst.jpg`(文件夹缩略图)+ `wsb.jpg`(文件夹背景,1024px)
- `loadFolderThumbnail(dir)` 懒加载(IntersectionObserver + 4 并发 FIFO 队列)
- `setFolderThumbnail(dir, srcPath)` 手动设置
- `clearFolderThumbnail(dir)` 清除
- `generateFolderThumbnail` 取目录内首张可缩略文件(`firstThumbnailableFile` 不递归子目录,只看直接子文件)

`ThumbIcon.tsx` 是所有视图里文件夹缩略图的**唯一渲染路径**,守卫逻辑避免提前 return 跳过目录(`isDirectory && !canThumb` 当前正确短路)

## 3. 管线基础设施(格式无关)

[src/main/thumbnail.ts](../src/main/thumbnail.ts):

- `thumbPathFor(dir, basename)` → `<dir>/.whale/thumbs/<basename>.jpg`
- 原子写 / mtime 缓存 / in-flight 去重 / delete/rename/move/copy 清理钩子**全部格式无关**
- 失败一律静默回退类型图标(FileTypeIcon),不阻塞其它缩略图
- **主进程并发闸门**([src/main/concurrency.ts](../src/main/concurrency.ts) 的 `Semaphore`):LibreOffice(`soffice`)**串行 cap 1**——`sofficeConvertArgs` 不传 `-env:UserInstallation`,并发进程争用 profile 锁会失败 / 损坏,所以 office 缩略图(`encodeOfficeThumb`)与 office-viewer PDF(`convertOfficeToPdf`)共用同一个 `sofficeSemaphore`;ffmpeg / calibre / dwg2dxf / ODA 共享 `mediaConvertSemaphore`(cap 2)。只包住子进程那一段,后续 pdfjs / sharp 渲染不持锁。**P3-3 后**:`encodeOfficeThumb` 与 `convertOfficeToPdf` 都改走共享的 `convertOfficeToPdfVia`([office-convert.ts](../src/main/office-convert.ts))—— 优先常驻 UNO worker,失败回退 execFile,`sofficeSemaphore.run` 同时包两路(worker 的 Desktop 单线程串行 + 回退的 profile-lock 串行,共用 cap 1);常驻 listener 用独立 `-env:UserInstallation` profile 不抢默认 profile。详见 [docs/17](./17-office-worker.md)
- **二进制探测记忆化**:soffice / dwg2dxf / ebook-convert / 7za 的 `--version` PATH 探测(异步 `execFile`,最多 3s timeout)**每进程只跑一次**(模块级缓存);override / 候选路径的 `existsSync` 仍每次跑(便宜);**并发首调用 inflight 去重**(per-binary `_xInflight: Promise<boolean> | null`),首个 caller kick off spawn、后续 caller await 同一 Promise。soffice 冷启慢,以前每次 office 转换都重新探测。**P1-1 之前是 `execFileSync`,冷启动 Windows 上 PATH 查找 + 二进制 bootstrap 吃满 3s timeout 阻塞整个主进程事件循环**(改 async 后消除冻结,详见 [docs/15-perf-audit.md P1-1](./15-perf-audit.md))
- **pdfjs 惰性**:PDF 缩略图用的 pdfjs-dist 经 `getPdfjs()`(`nodeRequire`)在首次 PDF 缩略图时才 load,不在启动顶层(见 [docs/01 §4](./01-architecture.md))

## 4. ThumbIcon 加载机制(前端)

[src/renderer/components/ThumbIcon.tsx](../src/renderer/components/ThumbIcon.tsx):

- 每个 cell 用 IntersectionObserver 监听,带 200px lookahead
- 加载请求进 [src/renderer/services/thumb-load-queue.ts](../src/renderer/services/thumb-load-queue.ts) FIFO 队列,`MAX_CONCURRENT = 4`(对齐 sharp worker pool)
- 同 key 去重;scroll-out 调 `cancelThumbLoad` 摘除未启动的 task
- `thumbCache` key = `${path}|${modified}` → data URL,卸载 / 复用时 `observed` 标志丢弃"in-flight 完成后但 cell 已 recycle"的脏结果
- **IO `observed` 双向同步**:`isIntersecting: true` 分支复位 `observed = true`,`false` 分支置 `false`。否则快速滚过的 cell 永远停在 Skeleton,滚回视口也不会再填充(细节见 [docs/09-known-issues.md §12](./09-known-issues.md))

## 5. 按格式区分的回退图标

[src/renderer/components/FileTypeIcon.tsx](../src/renderer/components/FileTypeIcon.tsx) + [src/renderer/domain/file-icon.ts](../src/renderer/domain/file-icon.ts):

- **39 类** `FileIconCategory`(完整列表,不是 19):`image` / `video` / `audio` / `pdf` / `word` / `excel` / `ppt` / `archive` / **`javascript`** / **`typescript`** / **`html`** / **`css`** / **`python`** / **`java`** / **`cpp`** / **`csharp`** / **`go`** / **`rust`** / **`shell`** / **`database`** / **`matlab`** / **`json`** / **`notebook`** / **`design`** / **`email`** / **`link`** / **`diskimage`** / `code` / `markdown` / `text` / `data` / `ebook` / `caj` / `drawio` / `excalidraw` / `font` / `model3d` / `executable` / `generic`
- 大小写不敏感;多点名取最后一段(`archive.tar.gz` → archive、`app.min.js` → code);dotfile(`.gitignore`) / 无扩展名 → `generic`
- Office 在 `whale-meta.OFFICE_EXT` 合并基础上按 word/excel/ppt **三分**(`rtf→word`、`csv/tsv→excel`,仅图标)
- **CAJ 类**含 `caj / kdh / nh / caa / teb`(`CAJ_EXT`),显示 `SchoolIcon`

**`archive` 类 — 区分两套集合**:

| 集合 | 内容 |
|---|---|
| `whale-meta.ARCHIVE_EXT`(9 种,**可解码**) | `zip, tar, tgz, tbz2, txz, gz, bz2, xz, 7z` |
| `file-icon.ARCHIVE_ICON_EXT`(14 种,**仅图标用途**) | `zip, tar, gz, tgz, 7z, rar, bz2, tbz2, xz, txz, zst, lz, lzma, cab` |

`.rar` / `.zst` / `.lz*` / `.cab` 显示 `FolderZip` 图标但**不是 archive-viewer 默认打开项** —— `archive-viewer` 实际只覆盖前一组 9 种,后一组只显示图标。

**`font` 类**:`file-icon.ts` 自带本地 `FONT_EXT = {ttf, otf, woff, woff2, eot}`(比 `whale-meta.FONT_EXT` 多 `.eot`,因为 `.eot` 是 legacy IE 格式,**能被 Chromium font-face 解析**,但 `@napi-rs/canvas` 解不出来所以不出缩略图)。**`font-viewer` 扩展接受 ttf/otf/woff/woff2**,`.eot` 不被打开(manifest 不含)。

**`model3d` 类大表细分**(品牌色优先,非品牌色共用 `#00897b` `ViewInArIcon`):

| 扩展 | 品牌 | 图标 |
|---|---|---|
| `blend` | Blender 橙 | `DesignServicesIcon` |
| `ma`, `mb` | Maya 青 | `ArchitectureIcon` |
| `max` | 3ds Max 蓝 | `ArchitectureIcon` |
| `skp` | SketchUp 红 | `ArchitectureIcon` |
| `c4d` | Cinema 4D 蓝 | `ArchitectureIcon` |
| `3dm` | Rhino 黑 | `ArchitectureIcon` |
| `ztl`, `zpr` | ZBrush 橙 | `ArchitectureIcon` |
| `sldprt`, `sldasm`, `slddrw` | SolidWorks 红 | `PrecisionManufacturingIcon` |
| DWG / DXF (`dwg`, `dxf`) | AutoCAD 红 | `ArchitectureIcon` |
| 通用 stl/obj/glb/gltf/ply/step/stp/iges/igs/brep/fbx/dae/3ds/3mf | — | `ViewInArIcon` |

接入点:`ThumbIcon.tsx`(列表 / 网格 / 画廊 / 属性托盘 / 搜索结果行的回退分支)/ `SearchBar.tsx` / `AdvancedSearchDialog.tsx` 结果行(`size={20}` 对齐 small)。

文件夹图标保持 `FolderIcon`,不被 FileTypeIcon 接管。

**drawio / excalidraw 不使用 MUI 图标**:直接显示品牌应用图标(`src/renderer/assets/drawio-icon.png`、`excalidraw-icon.svg`),因为生成的场景缩略图在小尺寸下几乎看不清。

## 6. 缓存与生命周期

- 已生成的缩略图命中缓存,无重新生成的闪烁
- 文件 delete / rename / move / copy → 对应 `.whale/thumbs/<basename>.jpg` 跟随清理
- 同一文件并发只生成一次(in-flight 去重)
- 单个文件生成失败不影响其它

## 7. 已知取舍

- `.eot` 出图但 `font-viewer` 不打开;`whale-meta.FONT_EXT` 不收它(避免无人看的缩略图)
- `.midi` 不缩略图(没意义)
- PDF 渲染器在主进程(@napi-rs/canvas),不带 CJK 字体替换表 —— 部分 PDF 标题可能显示为 notdef 方框;PDF 渲染扩展走 Chromium 自动字体补字形,缩略图级别可接受
- 损坏字体 / 不支持格式静默失败
- 缩略图大小写不敏感(`.PDF`/`.Pdf` 同样识别)
- 多段名(`archive.tar.gz`)取最后一段判断
- dotfile(`.gitignore`)归 `generic`
- 同类别内不同格式暂不细分(JS/Python/Go 都是青色 `Code`),如需字母角标则在 `FileTypeIcon.tsx` 叠加 `Typography`,不改 `file-icon.ts` 类别映射
- 大文件保护不在缩略图管线(只有 video 首帧快)

## 8. 架构审阅遗留(2026-07-18)

- ✅ **纯 JS CPU 已下沉 utilityProcess**(2026-07-18 修):pdf / ebook / font 渲染(pdfjs `page.render`、`unzipSync` 封面提取、font canvas 光栅化)移入 `whale-thumb` utilityProcess(thumb-worker.ts,镜像 index-worker 三件套);image 走 sharp libuv 线程池、video / office 本来就是子进程,故留主进程;office 的 doc→PDF 仍走主进程 UNO worker,临时 PDF 再交 worker 渲染。测试环境(ELECTRON_RUN_AS_NODE,`utilityProcess.fork` 不可用)下 host 进程内回退,直调同一套 thumb-render 函数。
