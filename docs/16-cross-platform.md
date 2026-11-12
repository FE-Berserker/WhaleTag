← 返回 [plan.md](../plan.md)

# 16 · macOS / Linux 跨平台打包可行性

> **2026-07-12** 的跨平台可行性评估,覆盖 `src/main` + `src/shared` 的平台相关代码、`resources/builder.json`、webpack 配置、原生模块。
>
> ⚠️ **文档定位**:同 [docs/15](./15-perf-audit.md),是 plan.md §F「不做未来计划」的**经确认例外**——一份评估 + 可勾选追踪清单。每项完成后勾 `- [x]` 并回写对应模块 doc;评估**不做**的移到文末「已接受的取舍」。
>
> **验证边界**:本评估基于静态代码分析,**尚未实际在 mac/linux 上跑过** `package:mac` / `package:linux`。结论需一次冒烟构建验证。

---

## 总体结论:🟢 可行性高

源码本身基本就是跨平台的——几乎所有平台敏感路径都已有正确的 `win32` / `darwin` / `linux` 分支。

真正的工作量在**构建配置 + 签名 + CI 矩阵**,不在应用代码。**无架构改动。**

---

## ✅ 已就绪、无需改(代码层面)

| 项 | 位置 | 状态 |
|---|---|---|
| ffmpeg | [thumbnail.ts](../src/main/thumbnail.ts) | `ffmpeg-static` 包自带各平台二进制,asarUnpack 已含(视频首帧缩略图) |
| 7za | —— | 已随 archive 模块移除:应用内不再解压归档,`7zip-bin` 依赖已删(打包脚本若需解 `.7z` 请用系统 7-Zip) |
| shell-quote | [shell-quote.ts](../src/main/shell-quote.ts) | 路径引号按平台分:win32 cmd 双引号 + 内嵌 `"` 翻倍,POSIX 单引号 close-reopen |
| userData / 菜单 / 回收站 / reveal | [main.ts](../src/main/main.ts) ~L349-369 / [menu.ts](../src/main/menu.ts) / [shell.ts](../src/main/ipc/shell.ts) | 三分支齐全;mac「关窗不退出」行为正确 |
| webpack externals | [.erb/configs/](../.erb/configs/) | [docs/14 坑4](./14-packaging.md) 的 pdfjs 子路径修是 OS 无关正则,无 `file:///C:/` 泄漏 |
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

### C-1. Linux 大小写敏感路径守卫过宽(安全相关)✅ 已解决
- **原问题**:[allowed-roots.ts](../src/main/allowed-roots.ts) `assertWithinAllowedRoot` 与 [extension-protocol.ts](../src/main/extension-protocol.ts) `isWithinRoot` 都把 target 和 root 整体 `toLowerCase()` 再比。Windows/mac(默认大小写不敏感)没问题;**Linux ext4 大小写敏感**,注册 `/home/u/Photos` 会连 `/home/u/photos/...` 也放进写白名单——是不同路径,破坏写保护语义。
- **修法**(2026-07-16):新增 [path-fold.ts](../src/main/path-fold.ts) 的 `foldPath(p)`——`win32`/`darwin` 小写、其它(linux)原样,两处守卫(allowed-roots 3 个位点 + extension-protocol `isWithinRoot`)都改用它。**为什么 darwin 也 fold**:mac 默认 APFS 大小写不敏感,且 `realpath` 已把 case 归一到磁盘真实大小写,故 fold 与 exact 在 mac 上结果一致(fold 是 no-op-after-realpath);只在罕见的 case-sensitive mac 上 fold 略宽(= 改前风险,可接受),linux 则从过宽修成精确。`better-sqlite3` 之类无关。测试:[path-fold.test.ts](../src/main/path-fold.test.ts) 覆盖两分支(经 test-seam param);allowed-roots / extension-protocol 的 case 断言改成平台条件(`CASE_INSENSITIVE_FS` ? 接受 : 拒绝),32/32 过。

### C-2. Linux 桌面环境 fallback 链 ✅ 已解决(2026-11-12)
- **修复前**:
  - [shell-command.ts](../src/main/shell-command.ts)「用户命令」开终端只 `xterm -e bash -c`。GNOME / KDE / Cinnamon 默认不带 xterm;spawn 失败被吞,右键菜单点了没反应。
  - [shell.ts](../src/main/ipc/shell.ts) `revealAndSelect`:linux 只 fallback 到 `nautilus --select`(GNOME 专);KDE 是 `dolphin --select`,其余桌面没有选中能力。
  - [fs-write.ts](../src/main/ipc/fs-write.ts) `runOsZip`:linux 走外部 `zip -r`;`zip` 在 Ubuntu Desktop 默认**不装**,打包直接失败。
- **修复**:新增 [desktop-linux.ts](../src/main/desktop-linux.ts),把三处桌面相关知识收敛成可单测的「有序候选链」,调用方只负责执行与报错:
  - **终端**:`linuxTerminalCandidates()` — `$TERMINAL` → `x-terminal-emulator` → `gnome-terminal(--)` → `konsole(-e)` → `xfce4-terminal(-x)` → `tilix` → `kitty` → `alacritty` → `xterm(-e)`;`launchLinuxTerminal()` 逐个 spawn 并等待 `spawn` 事件(ENOENT 是异步到达的,不能看返回值),全失败才抛错——渲染层已有 catch 会弹出真实错误,不再静默;窗口用 `; exec bash` 保持打开。
  - **reveal**:`linuxRevealSteps()` — D-Bus `org.freedesktop.FileManager1.ShowItems`(让运行中的文件管理器选中,URI 编码)→ `nautilus --select` → `dolphin --select` → `xdg-open 父目录`;某一步缺失或非零退出就跳过,全失败才报错。
  - **打包**:[fs-write.ts](../src/main/ipc/fs-write.ts) 的 POSIX 分支在 `zip` 报 ENOENT 时退回 `python3` + 内置 `zipfile` 脚本(`pythonZipPairs` 保持 `commonParentDir` 的相对布局;唯一差异是空目录不入包)。
- 测试:[desktop-linux.test.ts](../src/main/desktop-linux.test.ts) 8 例(候选顺序与 argv 形状、跳过缺失终端、全失败时的错误清单、D-Bus URI 编码、跨目录相对路径映射)。
- [x] 终端 DE fallback
- [x] reveal fallback 扩展
- [x] runOsZip linux 兜底

### C-3. 图标资源(构建)
- **现状**:[resources/](../resources/) 只有 `icon.ico` + png,无 `.icns`。[builder.json](../resources/builder.json) 顶层 `icon` 指向 `.ico`,mac / linux 会忽略各自原生图标需求,fallback 到 Electron 默认图标(能跑,只是丑,且 electron-builder 会 warning)。`png-to-ico` / `png2icns` 两个 devDep 是**死依赖**(无任何脚本 import)。
- **修法**:用 `logo.svg` / `logo-512.png` 生成 `.icns`(更推荐在 mac 上用 `iconutil`,比无人维护的 `png2icns` 0.0.1 可靠);补 `mac.icon`;清掉死 devDep 或写 `scripts/gen-icons.js` 把它们用起来。~1-2 小时。

- [ ] 生成 `.icns` + 补 `mac.icon`

### C-4. mac 架构(可选)
- **现状**:[package.json](../package.json) `package:mac` 未 pin arch,默认跟宿主(M1→arm64,Intel→x64)。
- **修法**:要 universal dmg 需 `mac.target: [{ target: "dmg", arch: ["x64", "arm64"] }]`,或 CI 分别出 arm64 / x64 两个 dmg。

- [ ] 按分发策略定 arch

### C-5. Linux 无递归目录监听(功能性,2026-07-18 引入)✅ 已解决(2026-11-12)
- **原问题**:[dir-watcher.ts](../src/main/dir-watcher.ts)(docs/04 §10 fs.watch 失效机制)用 `fs.watch {recursive:true}` —— Windows/macOS 正常,**Linux 抛 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`,该 root 回落到手动刷新 / 手动重建**。
- **修法(已实现)**:recursive 创建失败即切 **per-dir 递归监听**——启动遍历目录树逐目录 `fs.watch`,新目录出现补挂、删除/改名释放其下 watcher;`.whale` / `node_modules` / `.git` 不下降(自写回声 + inotify 预算),上限 4096 个 watcher(到顶警告一次)。没有引入 chokidar:省掉一个与原生模块无关的大依赖,POSIX 上语义等价。Windows/macOS 仍走 single recursive watcher,零行为变化;测试用强制 per-dir 的 test seam 在任意平台跑同一代码路径(docs/04 §10 有完整描述)。
- [x] Linux per-dir 递归监听(未引入 chokidar)

---

## 🟢 零碎 / 纯装饰(可不改)

- [ ] [ipc-types.ts](../src/shared/ipc-types.ts) ~L30:JSDoc 举例 Windows 路径,无运行时影响。
- [ ] [thumbnail.ts](../src/main/thumbnail.ts) ~L662-674:`loadFolderThumbnail` 的 EBUSY 重试循环在 mac/linux 是死代码(读取不会 EBUSY),无害,无需改。
- [ ] [webpack.config.renderer.prod.ts](../.erb/configs/) `favicon: icon.ico`:`.ico` 在 mac/linux Chromium 也认,纯风格问题,可换 `.png`。

---

## 📋 推进路径与工作量

| 步骤 | 工作量 | 必要性 |
|---|---|---|
| **CI 矩阵**:macos-latest(arm64 + x64)+ ubuntu-latest(x64)各跑 `package:{mac,linux}` | 配置活,半天 | **必须**(原生模块不能从 Windows 交叉编译,须在目标 OS 上 `npm install` + 打包) |
| 生成 `.icns` + 补 `mac.icon`(C-3) | 1-2 小时 | 想要正经图标就得做;否则 fallback Electron 图标 |
| Linux 路径守卫大小写修复(C-1) | — | ✅ 已完成(2026-07-16) |
| Linux 终端 / reveal / zip fallback(C-2) | moderate,半天 | ✅ 已解决 (2026-11-12) |
| mac 签名 + 公证(B-1) | 1 天(证书到手后)+ $99/年 | 仅公开分发需要 |
| 运行时前置文档(可选外部工具) | 文档 | 同 Windows 现状([docs/14](./14-packaging.md)),照搬一节 |

**最短可跑路径**(dev / 自用即达标,不用签名):加 `.icns`(C-3)+ 在 mac 和 linux 各跑一次 `package:mac` / `package:linux` 冒烟,验证无崩。

**注意**:打包前同样要 `unset ELECTRON_RUN_AS_NODE`([docs/14 坑3](./14-packaging.md)),env 残留与 OS 无关。

---

## ✅ 已接受的取舍

| 项 | 理由 |
|---|---|
| mac 不签名自用 | Gatekeeper 手动绕过可忍;公开分发再补(B-1) |
