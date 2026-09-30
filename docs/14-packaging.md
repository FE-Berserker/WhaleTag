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

- **nsis-resources 离线**(国内必做):下载 `nsis-resources-3.4.1.7z`(`github.com/electron-userland/electron-builder-binaries`),用 `node_modules/7zip-bin/win/x64/7za.exe` 解压到 `tools/nsis-resources-3.4.1/`,打包时设 `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 指向它,绕过 GitHub 下载(electron-builder 源码 `nsisUtil.js` 优先读这个 env)。SHA-512:`Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==`。
- `node_modules` 完整(`npm install`)。
- `nsis-3.0.4.1` 编译器、`winCodeSign` 通常已在 `%LOCALAPPDATA%/electron-builder/Cache` 缓存,不用重下(winCodeSign 缺失时的后果见坑 5/6)。

## 3. 验证打包成功

- exe 大小以实际产物为准(打包日志会打印);PE `MZ` 头 OK(`node -e "console.log(require('fs').readFileSync('...').slice(0,2))"`)。
- 日志收尾有 `building block map`(electron-builder 最后一步)。
- `grep -c "file:///C:/Whale" release/app/dist/main/main.js` = 0(无 import.meta.url 硬编码,见坑 4)。

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

## 5. 关键文件

| 文件 | 作用 |
|---|---|
| `resources/builder.json` | electron-builder 配置(icon / asarUnpack / win.signAndEditExecutable) |
| `.erb/configs/webpack.config.main.{dev,prod}.ts` | main bundle webpack(externals) |
| `tools/nsis-resources-3.4.1/` | 离线 nsis-resources |
