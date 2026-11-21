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

## 2. 前置(一次性)

- **nsis-resources 离线**(国内必做):下载 `nsis-resources-3.4.1.7z`(`github.com/electron-userland/electron-builder-binaries`),用系统 7-Zip(或任意 `7za`)解压到 `tools/nsis-resources-3.4.1/`,打包时设 `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 指向它,绕过 GitHub 下载(electron-builder 源码 `nsisUtil.js` 优先读这个 env)。SHA-512:`Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==`。
- `node_modules` 完整(`npm install`)。Electron 42.11 的 npm 包可在首次启动时按需下载二进制；若 `node_modules/electron/dist` 缺失，先运行 `node node_modules/electron/install.js`。国内直连 GitHub 下载失败时，可只对这一次命令设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，完成后用 `node_modules/electron/dist/version` 核对与 `package.json` 一致；不要把其他包的镜像配置当成 Electron 二进制已落盘的证明。
- `nsis-3.0.4.1` 编译器、`winCodeSign` 通常已在 `%LOCALAPPDATA%/electron-builder/Cache` 缓存,不用重下(winCodeSign 缺失时的后果见坑 5/6)。

## 3. 验证打包成功

- exe 大小以实际产物为准(打包日志会打印);PE `MZ` 头 OK(`node -e "console.log(require('fs').readFileSync('...').slice(0,2))"`)。
- 日志收尾有 `building block map`(electron-builder 最后一步)。
- `grep -c "file:///C:/Whale" release/app/dist/main/main.js` = 0(无 import.meta.url 硬编码,见坑 4)。
- **白名单检查**(0.5.1 起,见 §5):`npx asar list release/build/win-unpacked/resources/app.asar | grep -o 'node_modules/[^/]*' | sort -u` 顶层只剩白名单包 + `electron-updater`(+无害的 `d3-dsv` 残留)。
- **启动冒烟(0.5.0 的教训,必做)**:真启动一次 `release/build/win-unpacked/WhaleTag.exe`,确认主窗口出现且**没有** "A JavaScript error occurred in the main process" 弹窗(0.5.0 曾因 mcp-tools 值导入链把 index-db 守卫打进 main.js,打包版启动即崩,而 dev/test 因 `NODE_ENV≠production` 全绿漏网)。注意冒烟 shell 必须先清 `ELECTRON_RUN_AS_NODE`(坑 3)——不清的话 exe 退化成纯 Node 秒退 exit 0,看起来"正常退出",实际什么都没测到。
- **主进程自动冒烟**:`node scripts/packaged-smoke.js`(Windows,先完成 `--dir` 打包)用 Playwright 启动现有 `win-unpacked`,隔离 `APPDATA` / `LOCALAPPDATA` 与临时文本 fixture;校验 `isPackaged` / 窗口就绪 / 版本,再显式 fork asar 内真实的 `index-worker.js` 跑全文 build → search → has → shutdown,并检查隔离持久化 JSON。脚本不依赖生产环境测试 IPC,`finally` 关闭 Electron 并清理临时目录。
- **真实 GUI 冒烟**:`node scripts/packaged-gui-smoke.js` 仅在这一次性 Electron 主进程里把原生目录选择器返回值替换为临时 fixture,随后通过真实 Add Location → Browse → Add 页面按钮进入生产 known-roots / persist / 文件列表链路;再真实点击 Copy Path 并由主进程读回剪贴板,打开 Image Viewer 点击进入/退出 fullscreen,在 Text Editor 输入内容、Ctrl+S 并校验磁盘字节;另保留图片与文本两个标签,从后台关闭带未保存编辑的文本标签,确认打开时目标获得焦点,取消后恢复原活动标签且脏标签仍打开,再保存并关闭清理。OS 剪贴板不能靠隔离 `APPDATA` 隔离:脚本只对空剪贴板或单独 `text/plain` 执行 Copy Path,并在写入前快照、用一次结构化 write 恢复、以有界严格 read-back 校验；遇 HTML/RTF 组合、图片、FileNameW、URI 等不能可靠恢复的格式时不触碰剪贴板,明确跳过 Copy Path 单项并继续其余 GUI 验证,干净 CI 仍执行完整 clipboard 断言。没有新增生产后门或 IPC,超时关闭/kill 并清理隔离数据。
- **Draw.io 资源与运行冒烟**:`node scripts/packaged-drawio-smoke.js` 走同样的隔离与真实 Add Location 链路,打开最小 `.drawio`,先确认内层 webapp 的 viewer / base / lightbox URL 都是非空的扩展协议同源地址,再以不执行的 `<link rel="preload" as="script">` 验证懒加载 HTML viewer 依赖 `js/viewer-static.min.js` 确实可加载,并由主进程真实请求 Lightbox 目录文档,最后验证 webapp init、fixture 实际渲染和 `mxCellEditor` 图形 label 编辑，再点击当前 iframe 所属宿主 toolbar 的真实 Save 按钮，由 Node 轮询磁盘 XML，要求包含编辑后的 label、不再含旧 label、内容确实改变且 mtime 严格前进。扩展构建的 `shouldCopyDrawioAsset` 只排除可证明未使用的 `drawio-offline/node_modules`、source map、独立 `viewer.min.js` 和孤儿 workbox;实际被 `app.min.js` 引用的 `viewer-static.min.js`、math、stencils/templates 与 ElectronApp 均保留。构建同时 patch 复制后的 `index.html` 与 `js/PreConfig.js`:后者原本会把 viewer/base 重置为 `null`,现统一固定到本地 viewer/base/lightbox,防止运行时回退公网 CDN;base/lightbox 是无尾斜杠目录 URL,扩展协议只对 `drawio-editor/drawio-assets` 精确根路径映射 `index.html`,其他扩展目录仍返回 404。上游 `drawio-offline` 本身不提供 `embed-static.min.js` / `embed.js`,因此 HTML-embed 仍是有明确边界的上游能力缺口,不宣称已修复或已覆盖。总 watchdog 为 300 秒,超时错误带 launch/window/editor/offline/lightbox/render/edit/save/readback/cleanup 等当前阶段;该分支经静态检查,未人为等待 300 秒或注入 kill 故障。
- **CI 门禁**:`.github/workflows/ci.yml` 在 Windows / Node 22 上跑 `npm ci`、lint、type-check、全量测试;`.github/workflows/packaged-smoke.yml` 仅手动触发,执行 fresh unpacked 构建与上述主进程、全文 worker、真实 GUI、Draw.io 三类冒烟,避免每个 PR 都付打包成本。工作流本身是否已在 GitHub 跑通仍以 Actions 记录为准,本地通过不等于远端通过。
- **基准 CLI**:`scripts/bench-performance.js`、`scripts/bench-fulltext-phases.js`、`scripts/bench-fulltext-batches.js` 仅接受已知参数，未知参数、`--output` 缺值及非十进制/越界 `--rounds` 会在创建 fixture 前失败。phase/batch 导出 `runCli(argv)` 供测试覆盖真实参数解析与失败报告链。报告带 `generatedAt` 与清理后的 `completedAt`，`--output` 成功/失败都会覆盖旧报告；测量/校验失败也在 closeAllDbs/rm 后完成同一报告，保留原 `error`、`cleanupError`、`tempRootRemoved` 与退出码 1，原本成功的 run 若清理失败同样改为 `ok:false`，不把失败 JSON 当成功 stdout。
- 当前工作区已用 Electron 42.11.18 / electron-builder 26.18.0 经 `npm run package:win -- --dir` 重新构建，并通过 `node scripts/packaged-smoke.js`、`node scripts/packaged-gui-smoke.js` 与 `node scripts/packaged-drawio-smoke.js`；覆盖 unpacked 主进程、隔离持久化、真实全文 worker，Add Location / Copy Path / Image Viewer fullscreen / Text Editor Ctrl+S / 后台脏标签取消关闭与焦点恢复，以及 Draw.io 离线 viewer/base/lightbox 配置、bundle 可服务性、webapp init/render/label edit、宿主 Save 与磁盘新 label 读回。未覆盖 NSIS 安装包。

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
  验证:`node -e "require('pdfjs-dist/legacy/build/pdf.mjs')"` 在 Electron 42(node 22)可行。

### 坑 5/6:任务栏显示 Electron 默认图标 / rcedit 下载 winCodeSign 卡 GitHub(✅ 已解决)
- **历史**:`builder.json` 曾把 `win.signAndEditExecutable` 设 `false` 绕开 rcedit —— rcedit(app-builder 的 `pkg/rcedit`)需要 `winCodeSign` 包,从 GitHub 下载,国内卡(`Get https://github.com/.../winCodeSign-2.6.0.7z: ... wsarecv: ... timeout` → `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`);代价是 exe 保留 Electron 默认图标(任务栏/Alt+Tab 不显示蓝色 W)。
- **现状**:`winCodeSign-2.6.0` 已离线缓存在 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/`,`resources/builder.json` **不再**带 `signAndEditExecutable: false`(回退默认 `true`)→ rcedit 跑通,把 `resources/icon.ico`(蓝色 W,多分辨率)嵌进 exe。**0.3.0 起验证**:从打包后的 `win-unpacked/WhaleTag.exe` 抽出的图标 MD5 与 Electron 默认图标不同 → 自定义 W 已嵌入。
- **迁移注意**:换机器/清缓存后需重新落 `winCodeSign-2.6.0`(下载 `winCodeSign-2.6.0.7z` 解压到上述 Cache 目录);否则 `signAndEditExecutable:true` 又会在 editResources 卡 GitHub,或临时回退 `false`(图标退回默认)。

### 坑 7:latest.yml 的 url 与产物文件名不一致(连字符 vs 空格)
- **症状**:自动更新按 latest.yml 的 `url: WhaleTag-Setup-0.5.1.exe` 找文件,而 NSIS 实际产物是 `WhaleTag Setup 0.5.1.exe`(空格名)——三件套原样上传的话 electron-updater 下载 404。
- **根因**:electron-builder 写 latest.yml 时按 artifactName 模板把空格规范化成连字符,NSIS 输出文件却保留空格(0.5.0 时代即如此,非新引入)。
- **修法**:发布前把 exe 与 `.exe.blockmap` 重命名成 yml 里 `url` 的名字再一起上传(yml 里的 sha512/size 描述内容,重命名不影响校验);别反向改 yml 去迁就空格名。

## 5. `files` 白名单(0.5.1 起)

- **背景**:electron-builder 默认把根 `package.json` 的整棵生产依赖树打进 `app.asar`——0.5.0 时这棵树约 500MB(echarts / @mui / @excalidraw / codemirror 等 ~150-200MB 与 webpack bundle 重复,mermaid 链 ~110MB 只服务一个懒加载功能),而渲染层与扩展 bundle 运行时根本不读 node_modules。
- **现状**:`resources/builder.json` 的 `files` 先 `!**/node_modules/**/*` 整体排除,再以 `**/node_modules/{…}/**/*` 放回运行时真正需要的包:pdfjs-dist、sharp(+`@img`)、better-sqlite3(运行时 `require('bindings')` → 连带 `bindings` / `file-uri-to-path`)、ffmpeg-static、`@napi-rs`、exifr、jschardet、iconv-lite、ajv(+`ajv-formats`;asar 里那份 8.x 来自 `@modelcontextprotocol/sdk` 的依赖链)及 semver / detect-libc / safer-buffer 小件。`electron-updater` 是 electron-builder 对直接生产依赖强制保留的,属预期;`d3-dsv`(~24KB,mermaid→d3 链残留)无害。
- **维护规则**:main webpack externals(`.erb/configs/webpack.config.main.{dev,prod}.ts`)与 `lazy-native.ts` createRequire 清单里的每个包都必须出现在白名单;native 包的传递依赖(bindings / file-uri-to-path / detect-libc)也要带上。新增外部包时先 `grep -r "require('<pkg>" release/app/dist/main/` 确认运行时真的会加载,再进白名单,并按 §3 冒烟。
- **效果**:安装包 265.2MB → 189.7MB,`app.asar` 496.8MB/59,928 文件 → 164.4MB/5,725 文件。

## 6. 关键文件

| 文件 | 作用 |
|---|---|
| `resources/builder.json` | electron-builder 配置(icon / asarUnpack / files 白名单 / win.signAndEditExecutable) |
| `.erb/configs/webpack.config.main.{dev,prod}.ts` | main bundle webpack(externals,与 files 白名单联动,见 §5) |
| `scripts/build-extensions.js` | 扩展独立构建;manifest 占位符未命中会立即抛错,drawio 只剔除经 copy-filter 与真实冒烟核对的未使用资源 |
| `scripts/packaged-smoke.js` | 隔离用户数据的 win-unpacked 启动 + 真实全文 worker 冒烟 |
| `scripts/packaged-gui-smoke.js` | 真实 Add Location、Copy Path、Image Viewer fullscreen 与 Text Editor 保存冒烟 |
| `scripts/packaged-drawio-smoke.js` | 真实 Draw.io init/render/label edit、宿主 Save 与磁盘新 label 读回冒烟 |
| `.github/workflows/ci.yml` / `packaged-smoke.yml` | Windows 三件套门禁 / 手动 fresh unpacked 构建与三类冒烟 |
| `tools/nsis-resources-3.4.1/` | 离线 nsis-resources |
