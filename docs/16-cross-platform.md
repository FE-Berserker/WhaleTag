← 返回 [plan.md](../plan.md)

# 16 · macOS / Linux 跨平台打包可行性

> **2026-07-12** 的跨平台可行性评估,覆盖 `src/main` + `src/shared` 的平台相关代码、`resources/builder.json`、webpack 配置、原生模块、AI 组件打包。
>
> ⚠️ **文档定位**:同 [docs/15](./15-perf-audit.md),是 plan.md §F「不做未来计划」的**经确认例外**——一份评估 + 可勾选追踪清单。每项完成后勾 `- [x]` 并回写对应模块 doc;评估**不做**的移到文末「已接受的取舍」。
>
> **验证边界**:本评估基于静态代码分析,**尚未实际在 mac/linux 上跑过** `package:mac` / `package:linux`。结论需一次冒烟构建验证。

---

## 总体结论:🟢 可行性高

源码本身基本就是跨平台的——几乎所有平台敏感路径都已有正确的 `win32` / `darwin` / `linux` 分支。最大的担心(secretStore 用 Windows DPAPI)经核实是**误报**:实际用 Electron `safeStorage`(Windows=DPAPI / mac=Keychain / linux=libsecret)。

真正的工作量在**构建配置 + 签名 + CI 矩阵**,不在应用代码。**无架构改动。**

---

## ✅ 已就绪、无需改(代码层面)

| 项 | 位置 | 状态 |
|---|---|---|
| AI 密钥存储 | [secretStore.ts](../src/main/ai/security/secretStore.ts) | `safeStorage` 全平台;非 DPAPI 直调,无 `powershell.exe` |
| soffice (LibreOffice) | [thumbnail.ts](../src/main/thumbnail.ts) `sofficeBinary` ~L112-147 | 三平台候选路径全有(Win Program Files / mac `/Applications/LibreOffice.app/...` / linux `/usr/bin/soffice`、`/usr/lib/libreoffice/...`);`soffice.exe` vs `soffice` 已处理 |
| ffmpeg | [thumbnail.ts](../src/main/thumbnail.ts) ~L96 | `ffmpeg-static` 包自带各平台二进制,asarUnpack 已含 |
| 7zip | [archive.ts](../src/main/archive.ts) ~L34 | `7zip-bin` 自带 win/mac/linux 全部二进制,按 `process.platform` + `arch` 选 |
| ebook-convert (calibre) | [ebook-convert.ts](../src/main/ebook-convert.ts) ~L24-55 | 三平台候选路径全有 |
| dwg2dxf / ODA | [cad-convert.ts](../src/main/cad-convert.ts) ~L25-78 | `dwg2dxf` 走 PATH(brew / 包管理器都对);ODA 无 linux 版是事实,linux 走 LibreDWG |
| claude CLI | [findClaudeCliPath.ts](../src/main/ai/providers/claude/cli/findClaudeCliPath.ts) | 范本级跨平台:Win 查 AppData / Program Files,非 Win 查 `/usr/local/bin`、`/opt/homebrew/bin`、`~/.volta`、`~/.asdf`、`~/.npm-global`、`~/.local/bin` |
| spawn / shell-quote | [customSpawn.ts](../src/main/ai/providers/claude/customSpawn.ts) / [shell-quote.ts](../src/main/shell-quote.ts) | `.cmd/.bat/.ps1` 仅 win32 走 `shell:true`;POSIX 单引号转义正确 |
| env / path 工具 | [ai/utils/env.ts](../src/main/ai/utils/env.ts) / [ai/utils/path.ts](../src/main/ai/utils/path.ts) | PATH 分隔符、大小写归一、`node` vs `node.exe` 全按平台分 |
| userData / 菜单 / 回收站 / reveal | [main.ts](../src/main/main.ts) ~L349-369 / [menu.ts](../src/main/menu.ts) / [ipc.ts](../src/main/ipc.ts) ~L685-800 | 三分支齐全;mac「关窗不退出」行为正确 |
| webpack externals | [.erb/configs/](../.erb/configs/) | [docs/14 坑4](./14-packaging.md) 的 pdfjs 子路径修是 OS 无关正则,无 `file:///C:/` 泄漏 |
| AI 组件 `.whaleai` | [build-ai-component.js](../scripts/build-ai-component.js) | 按设计每平台各跑一次,读当前平台 optionalDeps |
| asarUnpack globs | [builder.json](../resources/builder.json) ~L16-25 | `@img/**` / `@napi-rs/**` 正确覆盖 mac/linux prebuild 路径 |
| 原生模块 rebuild | better-sqlite3 / sharp / @napi-rs/canvas | electron-builder 26 打包时自动按 Electron ABI rebuild;`occt-import-js` 是 WASM 全便携 |

---

## 🔴 硬阻塞(仅影响 mac 公开分发)

### B-1. mac 代码签名 + 公证
- **现状**:[builder.json](../resources/builder.json) 无 `mac.identity` / `notarize` / `hardenedRuntime`。
- **影响**:未签名 `.dmg` 触发 Gatekeeper(「WhaleTag 已损坏 / 无法打开」),用户得右键→打开 或 `xattr -dr com.apple.quarantine`。
- **自用 / 内部分发**:可忍(带上手动步骤)。
- **公开发布**:需 Apple Developer ID 证书($99/年)+ `afterSign` 公证脚本(`CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`)。
- **Linux 无此问题**(AppImage 不强制签名)。

- [ ] 自用可跳过;公开发布时补签名 + 公证

---

## 🟠 需要改的代码(都不大)

### C-1. Linux 大小写敏感路径守卫过宽(安全相关)
- **现状**:
  - [allowed-roots.ts](../src/main/allowed-roots.ts) ~L50-67:`assertWithinAllowedRoot` 把 target 和 root 都 `toLowerCase()` 再 `startsWith`。Windows / mac(默认大小写不敏感)没问题;**Linux ext4 大小写敏感**,注册 `/home/u/Photos` 会连 `/home/u/photos/...` 也放进写白名单——是不同路径,破坏 `assertWithinAllowedRoot` 的写保护语义。
  - [extension-protocol.ts](../src/main/extension-protocol.ts) ~L33-37:`whale-extension://` 资源遍历守卫同样问题(symlinked 扩展目录仅大小写不同可能滑过)。
- **修法**:把 `toLowerCase()` 门在 `process.platform === 'win32'` 后。[ai/utils/path.ts](../src/main/ai/utils/path.ts) ~L217 的 `normalizePathForComparison` 已是正确范式,照抄。**trivial**。

- [ ] 实现

### C-2. Linux 桌面环境 fallback 链缺失(易用性)
- **现状**:
  - [shell-command.ts](../src/main/shell-command.ts) ~L113-117:「用户命令」开终端只 `xterm -e bash -c`。GNOME / KDE / Cinnamon 默认不带 xterm;spawn 失败被吞(L119-123,文档记为「已知限制」)。
  - [ipc.ts](../src/main/ipc.ts) ~L784-800:「在文件夹中显示」linux 只 fallback 到 `nautilus --select`(GNONE 专);KDE 是 `dolphin --select`、XFCE 是 `thunar`。`xdg-open` 已覆盖主场景,这是锦上添花。
  - [ipc.ts](../src/main/ipc.ts) ~L373-407 `runOsZip`:linux 走外部 `zip -r` 命令,最小化 linux 镜像 / 容器未必装;失败是干净报错,不崩。
- **修法**:① 终端 DE 感知 fallback(`gnome-terminal` / `konsole` / `xfce4-terminal` / `xterm` 兜底,**moderate**);② reveal fallback 扩展 `dolphin --select`(**trivial**);③ `zip` 可 fallback 到已依赖的 7zip,或记为运行时前置(**moderate**)。

- [ ] 终端 DE fallback
- [ ] reveal fallback 扩展
- [ ] runOsZip linux 兜底

### C-3. 图标资源(构建)
- **现状**:[resources/](../resources/) 只有 `icon.ico` + png,无 `.icns`。[builder.json](../resources/builder.json) 顶层 `icon` 指向 `.ico`,mac / linux 会忽略各自原生图标需求,fallback 到 Electron 默认图标(能跑,只是丑,且 electron-builder 会 warning)。`png-to-ico` / `png2icns` 两个 devDep 是**死依赖**(无任何脚本 import)。
- **修法**:用 `logo.svg` / `logo-512.png` 生成 `.icns`(更推荐在 mac 上用 `iconutil`,比无人维护的 `png2icns` 0.0.1 可靠);补 `mac.icon`;清掉死 devDep 或写 `scripts/gen-icons.js` 把它们用起来。~1-2 小时。

- [ ] 生成 `.icns` + 补 `mac.icon`

### C-4. mac 架构(可选)
- **现状**:[package.json](../package.json) `package:mac` 未 pin arch,默认跟宿主(M1→arm64,Intel→x64)。
- **修法**:要 universal dmg 需 `mac.target: [{ target: "dmg", arch: ["x64", "arm64"] }]`,或 CI 分别出 arm64 / x64 两个 dmg。

- [ ] 按分发策略定 arch

---

## 🟢 零碎 / 纯装饰(可不改)

- [ ] [ai/prompt.ts](../src/main/ai/prompt.ts) ~L133:AI 系统 prompt 举例用 `C:\Music\Album\track.flac`,mac/linux 换成 `~/Music/...` 更贴切。
- [ ] [ipc-types.ts](../src/shared/ipc-types.ts) ~L30:JSDoc 举例 Windows 路径,无运行时影响。
- [ ] [thumbnail.ts](../src/main/thumbnail.ts) ~L662-674:`loadFolderThumbnail` 的 EBUSY 重试循环在 mac/linux 是死代码(读取不会 EBUSY),无害,无需改。
- [ ] [webpack.config.renderer.prod.ts](../.erb/configs/) `favicon: icon.ico`:`.ico` 在 mac/linux Chromium 也认,纯风格问题,可换 `.png`。

---

## 📋 推进路径与工作量

| 步骤 | 工作量 | 必要性 |
|---|---|---|
| **CI 矩阵**:macos-latest(arm64 + x64)+ ubuntu-latest(x64)各跑 `package:{mac,linux}` + `build-ai-component` | 配置活,半天 | **必须**(原生模块不能从 Windows 交叉编译,须在目标 OS 上 `npm install` + 打包) |
| 生成 `.icns` + 补 `mac.icon`(C-3) | 1-2 小时 | 想要正经图标就得做;否则 fallback Electron 图标 |
| Linux 路径守卫大小写修复(C-1) | trivial,半小时 | **推荐**(安全) |
| Linux 终端 / reveal / zip fallback(C-2) | moderate,半天 | 想要 linux 体验完整就得做 |
| mac 签名 + 公证(B-1) | 1 天(证书到手后)+ $99/年 | 仅公开分发需要 |
| 运行时前置文档(LibreOffice / calibre / LibreDWG `dwg2dxf`) | 文档 | 同 Windows 现状([docs/14](./14-packaging.md)),照搬一节 |

**最短可跑路径**(dev / 自用即达标,不用签名):加 `.icns` + 修两个 Linux 大小写守卫(C-1)→ 在 mac 和 linux 各跑一次 `package:mac` / `package:linux` 冒烟,验证无崩。

**注意**:打包前同样要 `unset ELECTRON_RUN_AS_NODE`([docs/14 坑3](./14-packaging.md)),Claude Code host 注入该 env 是 OS 无关的。

---

## ✅ 已接受的取舍

| 项 | 理由 |
|---|---|
| ODA File Converter 无 linux 版 | 官方无 linux build;linux CAD 转换走 LibreDWG `dwg2dxf`(代码已优先此路径) |
| headless linux 上 `safeStorage` 不可用 | 无 gnome-keyring / kwallet 时 `isEncryptionAvailable()` 返 false,用户得干净报错;桌面 Electron 应用可接受 |
| mac 不签名自用 | Gatekeeper 手动绕过可忍;公开分发再补(B-1) |
| `png2icns` devDep 闲置 | 待 C-3 落地时一并清理或启用 |
