← 返回 [plan.md](../plan.md)

# 14. Windows 打包流程与排坑

> `npm run package:win` 的完整流程,以及在打包调试过程中踩过的坑(症状 → 根因 → 修法)。国内网络环境特有。

## 1. 打包命令

```bash
# 1) 杀残留进程(避免 EBUSY 锁 app.asar)
taskkill //F //IM WhaleTag.exe 2>/dev/null

# 2) 清理上次产物(含隐藏的 .icon-ico / win-unpacked)
find release/build -mindepth 1 -delete

# 3) 打包 —— 关键:离线 nsis-resources + unset ELECTRON_RUN_AS_NODE
unset ELECTRON_RUN_AS_NODE
export ELECTRON_BUILDER_NSIS_RESOURCES_DIR="C:/WhaleTag/tools/nsis-resources-3.4.1"
npm run package:win > package.log 2>&1
```

产物:`release/build/WhaleTag Setup <ver>.exe` + `release/build/win-unpacked/`(免安装版,可直接跑 `WhaleTag.exe`)。

`npm run package:win` 先跑 `npm run build`,而 `build` 现在包含 `build:mobile` → `release/app/dist/mobile`(只读局域网访问用的移动端 bundle,见 [docs/22](./22-lan-access.md));它随 `dist/**/*` 一起进 `app.asar`,不需要额外配置(见 §5)。

## 2. 前置(一次性)

- **nsis-resources 离线**(国内必做):下载 `nsis-resources-3.4.1.7z`(`github.com/electron-userland/electron-builder-binaries`),用系统 7-Zip(或任意 `7za`)解压到 `tools/nsis-resources-3.4.1/`,打包时设 `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 指向它,绕过 GitHub 下载(electron-builder 源码 `nsisUtil.js` 优先读这个 env)。SHA-512:`Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==`。
- `node_modules` 完整(`npm install`)。Electron 42.11 的 npm 包可在首次启动时按需下载二进制；若 `node_modules/electron/dist` 缺失，先运行 `node node_modules/electron/install.js`。国内直连 GitHub 下载失败时，可只对这一次命令设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，完成后用 `node_modules/electron/dist/version` 核对与 `package.json` 一致；不要把其他包的镜像配置当成 Electron 二进制已落盘的证明。
- `nsis-3.0.4.1` 编译器、`winCodeSign` 通常已在 `%LOCALAPPDATA%/electron-builder/Cache` 缓存,不用重下(winCodeSign 缺失时的后果见坑 5/6)。

## 3. 验证打包成功

- exe 大小以实际产物为准(打包日志会打印);PE `MZ` 头 OK(`node -e "console.log(require('fs').readFileSync('...').slice(0,2))"`)。
- 日志收尾有 `building block map`(electron-builder 最后一步)。
- `grep -c "file:///C:/Whale" release/app/dist/main/main.js` = 0(无 import.meta.url 硬编码,见坑 4)。
- **白名单检查**(0.5.1 起,见 §5):`npx asar list release/build/win-unpacked/resources/app.asar | grep -o 'node_modules/[^/]*' | sort -u` 顶层只剩 §5 表里的运行时白名单包,不应再出现 `ajv`、`electron-updater`、`d3-dsv` 或任何嵌套 `node_modules`。白名单改动后除了下面的冒烟,还要对 `app.asar` 里每个运行时包做一次真实 `require`(Electron 42 自带 Node 24.19、`ELECTRON_RUN_AS_NODE=1`,直接给 `app.asar` 路径),因为打包日志不会告诉你少复制了一个文件。
- **启动冒烟(0.5.0 的教训,必做)**:真启动一次 `release/build/win-unpacked/WhaleTag.exe`,确认主窗口出现且**没有** "A JavaScript error occurred in the main process" 弹窗(0.5.0 曾因 mcp-tools 值导入链把 index-db 守卫打进 main.js,打包版启动即崩,而 dev/test 因 `NODE_ENV≠production` 全绿漏网)。注意冒烟 shell 必须先清 `ELECTRON_RUN_AS_NODE`(坑 3)——不清的话 exe 退化成纯 Node 秒退 exit 0,看起来"正常退出",实际什么都没测到。
- **主进程自动冒烟**:`node scripts/packaged-smoke.js`(Windows,先完成 `--dir` 打包)用 Playwright 启动现有 `win-unpacked`,隔离 `APPDATA` / `LOCALAPPDATA` 与临时文本 fixture;校验 `isPackaged` / 窗口就绪 / 版本,再显式 fork asar 内真实的 `index-worker.js` 跑全文 build → search → has → shutdown,并检查隔离持久化 JSON。脚本不依赖生产环境测试 IPC,`finally` 关闭 Electron 并清理临时目录。
- **真实 GUI 冒烟**:`node scripts/packaged-gui-smoke.js` 仅在这一次性 Electron 主进程里把原生目录选择器返回值替换为临时 fixture,随后通过真实 Add Location → Browse → Add 页面按钮进入生产 known-roots / persist / 文件列表链路;再真实点击 Copy Path 并由主进程读回剪贴板,打开 Image Viewer 点击进入/退出 fullscreen,在 Text Editor 输入内容、Ctrl+S 并校验磁盘字节;另保留图片与文本两个标签,从后台关闭带未保存编辑的文本标签,确认打开时目标获得焦点,取消后恢复原活动标签且脏标签仍打开,再保存并关闭清理。OS 剪贴板不能靠隔离 `APPDATA` 隔离:脚本只对空剪贴板或单独 `text/plain` 执行 Copy Path,并在写入前快照、用一次结构化 write 恢复、以有界严格 read-back 校验；遇 HTML/RTF 组合、图片、FileNameW、URI 等不能可靠恢复的格式时不触碰剪贴板,明确跳过 Copy Path 单项并继续其余 GUI 验证,干净 CI 仍执行完整 clipboard 断言。没有新增生产后门或 IPC,超时关闭/kill 并清理隔离数据。
- **可复跑 GUI 回归**:`scripts/packaged-gui-regression.js` 默认对 `release/build/win-unpacked/WhaleTag.exe` 运行(`npm run test:gui`),`npm run test:gui:current` 经 `WHALETAG_GUI_USE_CURRENT_BUILD=1` 对当前 `npm run build` 产物运行、不重新打包。每次运行在独立临时目录中隔离 Windows profile 与 fixture(`plain.txt` 固定 mtime + `Nested folder/nested.md`),运行结束写 `result.json` 并在关键步骤截图,不与开发机真实 profile 或上一次运行共享状态。覆盖 cold start(英语、production `file:` URL)、真实 Add Location、六个图标按钮的可访问名、设置页四个 Switch(无静态 "Enabled")、快捷键搜索标签与焦点环、Frosted Mint / Dark / Light 三套主题的 body 颜色、高级搜索首次 lazy 打开并在关闭重开后保留输入、简体中文 `html lang` 与日期、属性托盘 separator 连续键盘调宽与焦点、1024×640 / 720×480 无横向溢出(设置页另测 Dialog Paper 视口几何与自身 overflow),以及 console warning/error、pageerror、requestfailed、404 为空。2026-11 起新增 5 步并固定为 17 步:view-cycle(List/Gallery/Task→Board/Matrix/Calendar/Gantt/Tag cloud/Folder visualization/Knowledge graph 逐个可见且不新增 pageerror)、tab-focus-not-trapped(焦点进入列表后 Tab 能离开)、gallery-arrow-single-step(画廊方向键只移动焦点、不改变选择)、extension-open(双击文本文件加载 Text Editor iframe、校验内容并在关闭后无残留 tab)、rename-no-stale-tab(扩展 tab 打开时重命名,旧 tab 不残留、新 tab 指向新路径)。已接入手动 `packaged-smoke.yml`;是否通过以当次实际运行结果为准,不因脚本存在或接入流程而视为已通过。
- **Draw.io 资源与运行冒烟**:`node scripts/packaged-drawio-smoke.js` 走同样的隔离与真实 Add Location 链路,打开最小 `.drawio`,先确认内层 webapp 的 viewer / base / lightbox URL 都是非空的扩展协议同源地址,再以不执行的 `<link rel="preload" as="script">` 验证懒加载 HTML viewer 依赖 `js/viewer-static.min.js` 确实可加载,并由主进程真实请求 Lightbox 目录文档,最后验证 webapp init、fixture 实际渲染和 `mxCellEditor` 图形 label 编辑，再点击当前 iframe 所属宿主 toolbar 的真实 Save 按钮，由 Node 轮询磁盘 XML，要求包含编辑后的 label、不再含旧 label、内容确实改变且 mtime 严格前进。扩展构建的 `shouldCopyDrawioAsset` 只排除可证明未使用的 `drawio-offline/node_modules`、source map、独立 `viewer.min.js` 和孤儿 workbox;实际被 `app.min.js` 引用的 `viewer-static.min.js`、math、stencils/templates 与 ElectronApp 均保留。构建同时 patch 复制后的 `index.html` 与 `js/PreConfig.js`:后者原本会把 viewer/base 重置为 `null`,现统一固定到本地 viewer/base/lightbox,防止运行时回退公网 CDN;base/lightbox 是无尾斜杠目录 URL,扩展协议只对 `drawio-editor/drawio-assets` 精确根路径映射 `index.html`,其他扩展目录仍返回 404。上游 `drawio-offline` 本身不提供 `embed-static.min.js` / `embed.js`,因此 HTML-embed 仍是有明确边界的上游能力缺口,不宣称已修复或已覆盖。总 watchdog 为 300 秒,超时错误带 launch/window/editor/offline/lightbox/render/edit/save/readback/cleanup 等当前阶段;该分支经静态检查,未人为等待 300 秒或注入 kill 故障。
- **Excalidraw / Mermaid 运行冒烟**:`node scripts/packaged-excalidraw-smoke.js` 同样只替换一次性主进程的原生目录选择结果，随后走真实 Add Location 与 Excalidraw UI。脚本读取 canvas 实际像素确认 fixture 非空，并覆盖首份 fileContent 经 `initialData` 恢复的路径（不再抢在 `initializeScene` 前 `updateScene`，空场景不能通过）；双击进入绑定文本编辑，等宿主标签出现 dirty 标记后点击所属宿主 Save，并在磁盘读回后确认标签恢复 clean，Node 校验磁盘文本、元素 version 与 mtime；再从 extra-tools 打开 Mermaid to Excalidraw，打开前仅在这个隔离 iframe origin 的编辑器 localStorage 预置同一个最小 `flowchart TD\n  A-->B`，并断言 textarea 初始值，任何初始或后续 preview 都只能是该图而非默认示例，再等待 lazy preview 的真实非空像素且无 conversion error，以组件原生 Ctrl+Enter 执行 Insert，等宿主 dirty 后第二次 Save，磁盘含 A/B 文本、arrow/line、元素数增加、原文本保留且 mtime 严格前进，并最终恢复 clean。没有生产测试后门；300 秒 watchdog 带 launch/window/editor/render/edit/save/readback/mermaid/cleanup 阶段，临时目录正常退出清理。脚本从真实编辑器到 Mermaid lazy preview 全程收集 console error、pageerror、requestfailed 与 404；已知的 Excalidraw 字体 CSP 降级单独归类计数，其余失败必须为空，诊断写入 `artifacts/packaged-excalidraw-smoke-*/diagnostics.json`，专门覆盖异步 chunk URL / CSP / 加载失败。
- **CI 门禁**:`.github/workflows/ci.yml` 在 Windows / Node 22 上跑 `npm ci` → `npx electron-rebuild -f -o better-sqlite3`(npm 装的是纯 Node ABI 的预编译包,见 [docs/09 §4](./09-known-issues.md))→ `npm run lint` → `npm test`(`pretest` 先跑 type-check)→ `npm run build`(全部 bundle 都编译,坏掉的 webpack 配置在 PR 上就会暴露);超时 35 分钟(测试运行器上限 30 分钟)。`.github/workflows/packaged-smoke.yml` 仅手动触发,执行 fresh unpacked 构建、主进程/全文 worker、真实 GUI、Draw.io、Excalidraw/Mermaid 冒烟,以及可复跑 GUI 回归和 LAN 桌面/移动冒烟,避免每个 PR 都付打包成本；任一步失败时上传 `artifacts/**` 诊断并保留 7 天。工作流本身是否已在 GitHub 跑通仍以 Actions 记录为准,本地通过不等于远端通过。
- **冒烟脚本与界面同步**:这些脚本按可访问名 / testid 定位控件,界面重构后必须跟着改,否则下一个运行的人会把"脚本过期"误当成"打包坏了"。2026-11-25 修过一批(设置页重建之后):主题选择改为 tile 单选组(`selectTheme`,不再找 `Theme` 下拉框)、对话框标题是带样式的 `span` 而非 heading(用 `#settings-dialog-title` 断言文案)、LAN 单网卡时 Base URL 是"标签 + 提示"两个文本节点(读整行而不是找一整句)、Excalidraw 字体的 CSP 提示按消息形状匹配(不再写死 `font-src` 源列表)、LAN 停止后移动端的 list / tags 请求一起失败(都算预期的离线上报)。
- **基准 CLI**:`scripts/bench-performance.js`、`scripts/bench-fulltext-phases.js`、`scripts/bench-fulltext-batches.js` 仅接受已知参数，未知参数、`--output` 缺值及非十进制/越界 `--rounds` 会在创建 fixture 前失败。phase/batch 导出 `runCli(argv)` 供测试覆盖真实参数解析与失败报告链。报告带 `generatedAt` 与清理后的 `completedAt`，`--output` 成功/失败都会覆盖旧报告；测量/校验失败也在 closeAllDbs/rm 后完成同一报告，保留原 `error`、`cleanupError`、`tempRootRemoved` 与退出码 1，原本成功的 run 若清理失败同样改为 `ok:false`，不把失败 JSON 当成功 stdout。
- 当前工作区曾用 Electron 42.11.18 / electron-builder 26.18.0 经 `npm run package:win -- --dir` 重新构建，并逐项跑过 `node scripts/packaged-smoke.js`、`node scripts/packaged-gui-smoke.js`、`node scripts/packaged-drawio-smoke.js` 与 `node scripts/packaged-excalidraw-smoke.js`；这些结果只对应当次本机构建与隔离 profile，不代表 GitHub Actions 或 fresh 最终安装包已通过。该次运行覆盖 unpacked 主进程、隔离持久化、真实全文 worker，Add Location / Image Viewer fullscreen / Text Editor Ctrl+S / 后台脏标签取消关闭与焦点恢复，Draw.io 离线 viewer/base/lightbox 配置、bundle 可服务性、webapp init/render/label edit、宿主 Save 与磁盘新 label 读回，以及 Excalidraw canvas 实际渲染、绑定文本与 Mermaid flowchart 的 dirty/clean 保存、隔离初始定义、A/B 节点和连线读回（该次二次保存后读回 7 个元素）。本次本机 GUI 因已有 `text/plain` + `text/html` 组合剪贴板按安全策略跳过 Copy Path 且未触碰原数据，干净 CI 仍执行该项。未覆盖 NSIS 安装包。

## 4. 排坑(按踩坑顺序)

### 坑 1:打包卡在 "downloading nsis-resources-3.4.1"
- **症状**:electron-builder 卡在从 GitHub 下载 nsis-resources,最终超时失败。**根因**:国内访问 GitHub 慢/失败。
- **修法**:见前置 §2,用 `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 离线方案。

### 坑 2:EBUSY "resource busy or locked" unlink app.asar
- **症状**:`find` 删 app.asar,或 electron-builder 复制时报 `EBUSY`。
- **根因**:之前跑过的 `WhaleTag.exe`(或 dev 模式、或诊断时手动跑的 win-unpacked/WhaleTag.exe)进程残留,锁着 app.asar。
- **修法**:打包前 `taskkill //F //IM WhaleTag.exe` + `find release/build -mindepth 1 -delete`。

### 坑 3:@electron/rebuild 异常 / ELECTRON_RUN_AS_NODE
- **症状**:native 依赖(better-sqlite3 / sharp / @napi-rs)rebuild 失败,或 electron 子进程行为异常。
- **根因**:shell 里残留 `ELECTRON_RUN_AS_NODE=1`(跑过 Electron 测试后常见,见 [docs/09 §1](./09-known-issues.md))会让 electron 退化为纯 Node 解释器。
- **修法**:打包命令前 `unset ELECTRON_RUN_AS_NODE`。

### 坑 4:别机主进程崩 "ReferenceError: DOMMatrix is not defined"
- **症状**:打包版在别的电脑启动即弹错误对话框,开发机正常。
- **根因**:`.erb/configs/webpack.config.main.{dev,prod}.ts` 的 externals 用对象式 `'pdfjs-dist': 'commonjs pdfjs-dist'`,**只匹配裸名,不匹配子路径** `pdfjs-dist/legacy/build/pdf.mjs`(`thumbnail.ts` / `fulltext.ts` 用的)。子路径被 webpack 打进 bundle,`import.meta.url` 被硬编码成构建机绝对路径 `file:///C:/Whale/...`,别机不存在 → pdfjs 的 DOMMatrix polyfill 找不到 `@napi-rs/canvas` → 主进程顶层用 `DOMMatrix` 即崩。
- **修法**:externals 改数组 + 函数匹配子路径,让 pdfjs 运行时从 node_modules 加载(`import.meta.url` 是真实路径):
  ```js
  externals: [ { /* 原对象 */ }, ({ request }, cb) => {
    if (/^pdfjs-dist(\/|$)/.test(request)) return cb(null, `commonjs ${request}`);
    cb();
  } ]
  ```
  验证:`node -e "require('pdfjs-dist/legacy/build/pdf.mjs')"` 在 Electron 42(内置 Node 24.19)可行。

### 坑 5/6:任务栏显示 Electron 默认图标 / rcedit 下载 winCodeSign 卡 GitHub(✅ 已解决)
- **历史**:`builder.json` 曾把 `win.signAndEditExecutable` 设 `false` 绕开 rcedit —— rcedit(app-builder 的 `pkg/rcedit`)需要 `winCodeSign` 包,从 GitHub 下载,国内卡(`Get https://github.com/.../winCodeSign-2.6.0.7z: ... wsarecv: ... timeout` → `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`);代价是 exe 保留 Electron 默认图标(任务栏/Alt+Tab 不显示蓝色 W)。
- **现状**:`winCodeSign-2.6.0` 已离线缓存在 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/`,`resources/builder.json` **不再**带 `signAndEditExecutable: false`(回退默认 `true`)→ rcedit 跑通,把 `resources/icon.ico`(蓝色 W,多分辨率)嵌进 exe。**0.3.0 起验证**:从打包后的 `win-unpacked/WhaleTag.exe` 抽出的图标 MD5 与 Electron 默认图标不同 → 自定义 W 已嵌入。
- **迁移注意**:换机器/清缓存后需重新落 `winCodeSign-2.6.0`(下载 `winCodeSign-2.6.0.7z` 解压到上述 Cache 目录);否则 `signAndEditExecutable:true` 又会在 editResources 卡 GitHub,或临时回退 `false`(图标退回默认)。

### 坑 7:latest.yml 的 url 与产物文件名不一致(连字符 vs 空格)
- **症状**:自动更新按 latest.yml 的 `url: WhaleTag-Setup-0.5.1.exe` 找文件,而 NSIS 实际产物是 `WhaleTag Setup 0.5.1.exe`(空格名)——三件套原样上传的话 electron-updater 下载 404。
- **根因**:electron-builder 写 latest.yml 时按 artifactName 模板把空格规范化成连字符,NSIS 输出文件却保留空格(0.5.0 时代即如此,非新引入)。
- **修法**:发布前把 exe 与 `.exe.blockmap` 重命名成 yml 里 `url` 的名字再一起上传(yml 里的 sha512/size 描述内容,重命名不影响校验);别反向改 yml 去迁就空格名。

## 5. `files` 白名单(0.5.1 起)与语言包(2026-11-25 起)

- **背景**:electron-builder 默认把根 `package.json` 的整棵生产依赖树打进 `app.asar`——0.5.0 时这棵树约 500MB(echarts / @mui / @excalidraw / codemirror 等 ~150-200MB 与 webpack bundle 重复,mermaid 链 ~110MB 只服务一个懒加载功能),而渲染层与扩展 bundle 运行时根本不读 node_modules。
- **现状**:`resources/builder.json` 的 `files` 先 `!**/node_modules/**/*` 整体排除,再按**文件**放回运行时真正会加载的那部分。main webpack externals(`.erb/configs/webpack.config.main.{dev,prod}.ts`)与 `lazy-native.ts` 的 createRequire 清单是唯一依据;`electron-updater`、`electron-log`、`d3-dsv`、`ajv` 等都已由 webpack 打进 `main.js`,asar 里不留副本。

  | 包 | 放回内容 | 运行时谁在用 |
  |---|---|---|
  | `better-sqlite3` | `package.json`、`LICENSE`、`lib/**`、`build/Release/*.node` | `index-db.ts` 直接 `import`(主进程与 `index-worker.js`);`deps/`(SQLite C 源码,~10MB)与 `src/` 不带 |
  | `bindings`、`file-uri-to-path` | 入口脚本 + 许可证 | better-sqlite3 12 仍用 `require('bindings')` 定位 `.node` |
  | `pdfjs-dist` | `legacy/build/pdf.mjs`、`legacy/build/pdf.worker.mjs`、`cmaps/**`、`standard_fonts/**`、`wasm/**`、`iccs/**` | 缩略图与全文抽取(`thumb-render.ts` / `fulltext.ts` 设 `cMapUrl` / `standardFontDataUrl` / `wasmUrl`);非 legacy `build/`、`web/`、`image_decoders/`(已编进 worker)、source map、`types/` 都不带 |
  | `sharp`、`@img` | sharp 的 `dist/**`、`lib/**`、`src/**`;`@img/**/*` 整体 | `lazy-native.ts`;`@img/sharp-win32-x64` 是原生二进制 |
  | `@napi-rs` | `@napi-rs/**/*` 整体 | 字体缩略图与 pdfjs 的 DOMMatrix polyfill;原生二进制 |
  | `ffmpeg-static` | `index.js`、`ffmpeg.exe`(及非 Windows 的 `ffmpeg`)与许可证 | 视频缩略图抽帧;`install.js` 与其嵌套依赖不带 |
  | `exifr` | `dist/full.umd.js` | EXIF 读取;umd 包自包含 |
  | `jschardet` | `index.js` + `src/**` | `index.js` 只是 `require('./src')`;`dist/` 不带 |
  | `iconv-lite`、`safer-buffer` | `lib/**`、`encodings/**`、入口脚本 | 旧编码文本解码(`text-decode.ts`) |
  | `semver`、`detect-libc` | 入口脚本 + `lib/**`、`classes/**` 等 | sharp 的运行时依赖 |

  列表**末尾**的 `!**/node_modules/*/node_modules/**` 兜底排除一切嵌套 `node_modules`(electron-builder 按顺序求值,后出现的排除项优先):此前 `d3-dsv/node_modules/iconv-lite`、`electron-updater/node_modules/semver` 约 0.4MB 残留因此消失。顶层 `node_modules` 只剩上表条目。
- **`electronLanguages`**:`builder.json` 顶层 `electronLanguages: ["en-US", "zh-CN", "zh-TW", "ja", "ko"]` 与应用 i18n 的 5 种语言一致,只保留这 5 个 `.pak`(47.2MB → 3.1MB)。应用界面文案走 renderer `locales/*.json`,不受影响;`.pak` 只管 Chromium 自带文案(右键菜单、滚动条提示等)。
- **维护规则**:main webpack externals 与 `lazy-native.ts` createRequire 清单里的每个包都必须出现在白名单;native 包的传递依赖(bindings / file-uri-to-path / detect-libc / semver / safer-buffer)也要带上。新增外部包时先 `grep -r "require('<pkg>" release/app/dist/main/` 确认运行时真的会加载,再进白名单,并按 §3 冒烟 + 对 asar 做真实 `require`。
- **原生模块 rebuild**:`npm run package:win` 打包前会让 `@electron/rebuild` 处理原生依赖;对 better-sqlite3 这类 prebuild-install 模块它**每次**都重新下载并解压 Electron ABI 的预编译包,不认已经正确的 `.node`。所以打包前先关掉所有 WhaleTag / 开发版 Electron 实例(含 `npm run dev`、跑测试的实例),否则 `better_sqlite3.node` 被占用会报 `EPERM: operation not permitted, unlink …`。`scripts/check-native-abi.cjs` 已通过而本机确有进程占着文件时,可临时用 `npx electron-builder --win --x64 --config resources/builder.json '-c.npmRebuild=false'` 跳过(PowerShell 下该参数必须加引号)。
- **压缩**:NSIS 负载是一个 7z solid 包,electron-builder 默认就用最高档 `-mx=9`;再写 `"compression": "maximum"` 不会更小。
- **效果**:0.5.1 整包级白名单:安装包 265.2MB → 189.7MB,`app.asar` 496.8MB/59,928 文件 → 164.4MB/5,725 文件。2026-11-25 文件级白名单 + 5 语言:安装包 196.85MB → 182.6MB(−14.2MB,−7.2%),`app.asar` 161.5MB/4,731 文件 → 132.2MB/4,003 文件,`win-unpacked` 668.4MB → 585.2MB,功能与界面无变化。安装包剩余体积主要是 Electron 本体(压缩后约 80MB)、drawio 资源(约 24MB)、`ffmpeg.exe`(约 19MB)、Excalidraw 字体(12.5MB,运行时按 unicode-range 子集从本地按需加载)与 `@napi-rs/canvas` / sharp 原生模块;再往下减都要改产品能力或依赖,取舍记在 [docs/19](./19-code-audit.md) 的取舍表。
- **`dist/mobile` 不需要单独配置**:只读局域网访问的移动端页面在 `release/app/dist/mobile`,`files` 里的 `dist/**/*` 已经覆盖,没有额外的 `extraResources`;主进程运行时按 `path.resolve(__dirname, '../mobile')` 找它。二维码库 `qrcode` 只被 renderer 以动态 `import()` 引用、由 renderer webpack 打进自己的 chunk(renderer 没有 externals),所以**不在**上面的 node_modules 白名单里。

## 6. 关键文件

| 文件 | 作用 |
|---|---|
| `resources/builder.json` | electron-builder 配置(icon / asarUnpack / 文件级 `files` 白名单 / `electronLanguages` / win.target) |
| `.erb/configs/webpack.config.main.{dev,prod}.ts` | main bundle webpack(externals,与 files 白名单联动,见 §5) |
| `.erb/configs/webpack.config.mobile.{dev,prod}.ts` | 移动端(只读局域网 Web 客户端)bundle → `dist/mobile`;`target: 'web'`,由主进程 HTTP 服务同源提供,无 dev server |
| `scripts/build-extensions.js` | 扩展独立构建;manifest 占位符未命中会立即抛错,drawio 只剔除经 copy-filter 与真实冒烟核对的未使用资源;传给 webpack 的配置路径带引号,检出目录含空格也能构建 |
| `scripts/packaged-smoke.js` | 隔离用户数据的 win-unpacked 启动 + 真实全文 worker 冒烟 |
| `scripts/packaged-gui-smoke.js` | 真实 Add Location、Copy Path、Image Viewer fullscreen 与 Text Editor 保存冒烟 |
| `scripts/packaged-gui-regression.js` | 默认 win-unpacked / 当前 production build 的可复跑 GUI 可访问性与布局回归,输出 JSON + 截图 |
| `scripts/packaged-drawio-smoke.js` | 真实 Draw.io init/render/label edit、宿主 Save 与磁盘新 label 读回冒烟 |
| `scripts/packaged-excalidraw-smoke.js` | 真实 Excalidraw canvas/edit/Save 与 Mermaid lazy preview/Insert/二次磁盘读回冒烟 |
| `scripts/packaged-lan-smoke.js` | 只读局域网冒烟(`npm run test:lan`):打包版开服务、配对、只读 API、独立手机/平板视口、停止失效与 `.whale` 只读快照;是否通过以实际运行结果为准 |
| `.github/workflows/ci.yml` / `packaged-smoke.yml` | Windows 三件套 + 完整 `build` 门禁(含 better-sqlite3 rebuild,35 分钟超时)/ 手动 fresh unpacked 构建、四类冒烟与可复跑 GUI 回归;LAN 冒烟(`test:lan`)只挂在后者的 `Smoke read-only LAN desktop and mobile clients` 步骤 |
| `tools/nsis-resources-3.4.1/` | 离线 nsis-resources |
