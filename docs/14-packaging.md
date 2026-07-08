← 返回 [plan.md](../plan.md)

# 14. Windows 打包流程与排坑

> `npm run package:win` 的完整流程,以及在打包/AI 调试过程中踩过的坑(症状 → 根因 → 修法)。国内网络环境特有。

## 1. 打包命令

```bash
# 1) 杀残留进程(避免 EBUSY 锁 app.asar)
taskkill //F //IM WhaleTag.exe 2>/dev/null

# 2) 清理上次产物(含隐藏的 .icon-ico / win-unpacked)
find release/build -mindepth 1 -delete

# 3) 打包 —— 关键:离线 nsis-resources + unset ELECTRON_RUN_AS_NODE
unset ELECTRON_RUN_AS_NODE
export ELECTRON_BUILDER_NSIS_RESOURCES_DIR="C:/Whale/tools/nsis-resources-3.4.1"
npm run package:win > package.log 2>&1
```

产物:`release/build/WhaleTag Setup 0.0.1.exe`(~447 MiB)+ `release/build/win-unpacked/`(免安装版,可直接跑 `WhaleTag.exe`)。

## 2. 前置(一次性)

- **nsis-resources 离线**(国内必做):下载 `nsis-resources-3.4.1.7z`(`github.com/electron-userland/electron-builder-binaries`),用 `node_modules/7zip-bin/win/x64/7za.exe` 解压到 `tools/nsis-resources-3.4.1/`,打包时设 `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 指向它,绕过 GitHub 下载(electron-builder 源码 `nsisUtil.js` 优先读这个 env)。SHA-512:`Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==`。
- `node_modules` 完整(`npm install`)。
- `nsis-3.0.4.1` 编译器、`winCodeSign` 通常已在 `%LOCALAPPDATA%/electron-builder/Cache` 缓存(nsis 打包用),不用重下。

## 3. 验证打包成功

- exe 大小 ~447 MiB,PE `MZ` 头 OK(`node -e "console.log(require('fs').readFileSync('...').slice(0,2))"`)。
- 日志收尾有 `building block map`(electron-builder 最后一步)。
- `grep -c "file:///C:/Whale" release/app/dist/main/main.js` = 0(无 import.meta.url 硬编码,见坑 4)。

## 4. 排坑(按踩坑顺序)

### 坑 1:打包卡在 "downloading nsis-resources-3.4.1"
- **症状**:electron-builder 卡在从 GitHub 下载 nsis-resources,最终超时失败。
- **根因**:国内访问 GitHub 慢/失败。
- **修法**:见前置 §2,用 `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 离线方案。

### 坑 2:EBUSY "resource busy or locked" unlink app.asar
- **症状**:`find` 删 app.asar,或 electron-builder 复制时报 `EBUSY`。
- **根因**:之前跑过的 `WhaleTag.exe`(或 dev 模式、或诊断时手动跑的 win-unpacked/WhaleTag.exe)进程残留,锁着 app.asar。
- **修法**:打包前 `taskkill //F //IM WhaleTag.exe` + `find release/build -mindepth 1 -delete`。

### 坑 3:@electron/rebuild 异常 / ELECTRON_RUN_AS_NODE
- **症状**:native 依赖(better-sqlite3 / sharp / @napi-rs)rebuild 失败,或 electron 子进程行为异常。
- **根因**:Claude Code 的 host 会注入 `ELECTRON_RUN_AS_NODE`,让 electron 以纯 node 模式跑。
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

### 坑 5:AI "MODULE_NOT_FOUND" requireStack []
- **症状**:设了 API key 后 AI 报 `code: 'MODULE_NOT_FOUND', requireStack: []`(node 入口加载失败)。
- **根因**:`findClaudeCliPath` 的 `bundledCliPath` 用 `require.resolve` 拿到 **`app.asar` 逻辑路径**(Electron 对 asar 透明,即使文件 asarUnpack'd,逻辑路径仍记 app.asar)。customSpawn 用**外部 node**跑 `cli-wrapper.cjs`,外部 node 读不到 `.asar` 归档(它是单个打包文件,不是目录)→ 入口找不到。
- **修法**:`bundledCliPath` 把路径里 `app.asar` 重映射到 `app.asar.unpacked`(`@anthropic-ai/claude-code` 被 asarUnpack,物理在那):
  ```ts
  if (pkgJsonPath.includes('app.asar'))
    pkgJsonPath = pkgJsonPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  ```
  通用教训:Electron 主进程把 asar 内文件路径传给**外部子进程**时,必须转成 `app.asar.unpacked` 真实路径。

### 坑 6:AI "Claude Code process exited with code 1"(黑盒)
- **症状**:AI 报裸 exit code,看不出真正原因。
- **根因**:`customSpawn.ts` 的 stdio 第三项 `'ignore'`,claude.exe / cli-wrapper.cjs 的 stderr 全丢。
- **修法**:stdio 改 `'pipe'` + 模块级 ring buffer 缓存 stderr 尾部(~64KB)+ `child.on('exit')` 记录非零退出诊断;导出 `consumeRecentSpawnExit(code)`;`ClaudeChatRuntime.errorMessage` 正则匹配 `exited with code N` 拼上 stderr 尾 8 行;`AiPanel` 用 `whiteSpace:'pre-wrap'` 多行显示。
  - cli-wrapper.cjs 用 `stdio:'inherit'` 调 claude.exe,所以 claude.exe 的 stderr 会流到 customSpawn 的 child.stderr,pipe 即可拿到。
  - SDK 的 `SpawnedProcess` 接口没有 stderr 字段(它不读 stderr),改 pipe 对 SDK 透明。
  - **必须消费 stderr**,否则管道写满(~64KB)会让 claude.exe 阻塞 hang。

### 坑 7:UI 显示 API key "已设置",但 AI 要 login
- **症状**:设置显示"已设置(加密存储)",但 claude.exe 提示要登录(没收到凭证)。
- **根因**:`secretStore.ts` 的 `hasSecret` 只查文件里有没有 key 条目,**不验证解密**。反复安装 exe / 换机器后,旧 DPAPI blob 残留(DPAPI 绑定 Windows 用户 + 机器,不可移植),`getSecret` 解密失败返回空,但 `hasSecret` 仍返回 true → UI 误导。
- **修法**:`hasSecret` 先尝试解密,解密失败返回 false 并清掉 stale blob:
  ```ts
  const encrypted = readAll()[name];
  if (!encrypted) return false;
  if (decryptValue(encrypted) !== '') return true;
  // stale undecryptable blob — drop it
  ```

### 坑 8:中转 403 "Failed to authenticate / Request not allowed"
- **症状**:设 API key 后 AI 403。
- **根因**:中转/代理用 `ANTHROPIC_AUTH_TOKEN`(Bearer 头),而 WhaleTag 默认设 `ANTHROPIC_API_KEY`(x-api-key 头);新版 Claude Code(2.1+)只读环境变量,不读 `~/.claude/settings.json`。
- **修法**:设置 → AI(claude-cli)加「认证字段」下拉(`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`,cc-switch 默认后者)+「Anthropic 基础地址」字段(`ANTHROPIC_BASE_URL`,中转端点);`buildQueryOptions` 按选择写对应 env。参考 cc-switch(`github.com/farion1231/cc-switch`)的 Claude Code 供应商配置。

### 坑 9:任务栏显示 Electron 默认图标(不是 logo)
- **症状**:任务栏图标是 Electron 的电子/原子图标,不是蓝色 W。
- **根因**:`builder.json` 的 `win.signAndEditExecutable: false` → electron-builder 不用 rcedit 把 `.icon-ico/icon.ico`(蓝色 W,已生成)嵌入 exe,exe 保留 Electron 默认图标。
- **修法**:改 `signAndEditExecutable: true` —— **但触发坑 10**。

### 坑 10:signAndEditExecutable: true → rcedit 下载 winCodeSign 卡 GitHub(⚠️ 当前未解决)
- **症状**:改 `signAndEditExecutable: true` 后,打包在 `editResources`(rcedit)步骤失败:`Get https://github.com/.../winCodeSign-2.6.0.7z: ... wsarecv: ... timeout`,最终 `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`。
- **根因**:rcedit(app-builder 的 `pkg/rcedit`)需要 `winCodeSign` 包,从 GitHub 下载,国内卡。**这正是当初设 `signAndEditExecutable: false` 的原因** —— 避开 rcedit + winCodeSign 下载。
- **待解**:winCodeSign 离线方案(类似 nsis-resources):下载 `winCodeSign-2.6.0.7z`(`tools/` 里已有),解压并让 app-builder 找到(放 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/`,或找 app-builder 的 env 变量)。**当前 exe 图标仍是 Electron 默认,任务栏/Alt+Tab 不显示 logo** —— 是已知的遗留问题。

## 5. 关键文件

| 文件 | 作用 |
|---|---|
| `resources/builder.json` | electron-builder 配置(icon / asarUnpack / win.signAndEditExecutable) |
| `.erb/configs/webpack.config.main.{dev,prod}.ts` | main bundle webpack(externals) |
| `src/main/ai/providers/claude/cli/findClaudeCliPath.ts` | 解析 claude.exe 路径(asar.unpacked 重映射) |
| `src/main/ai/providers/claude/customSpawn.ts` | spawn claude.exe + stderr 捕获(ring buffer) |
| `src/main/ai/providers/claude/buildQueryOptions.ts` | 构造 env(API_KEY/AUTH_TOKEN/BASE_URL) |
| `src/main/ai/providers/claude/ClaudeChatRuntime.ts` | runTurn / 预热降级 / 认证预检 / errorMessage |
| `src/main/ai/security/secretStore.ts` | DPAPI 加密 key 存储(hasSecret 验证解密) |
| `tools/nsis-resources-3.4.1/` | 离线 nsis-resources |

## 6. AI 调用链(理解坑 5-8)

```
renderer ai:query  →  ipc-ai.ts streamTurn  →  ClaudeChatRuntime.runTurn
   →  claude-agent-sdk query()/startup()
   →  customSpawn spawn(外部 node, [cli-wrapper.cjs, ...])
   →  cli-wrapper.cjs spawnSync(claude.exe, ...)
   →  claude.exe  读 env(ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL)+ ~/.claude/.credentials.json
```

认证与 endpoint 全靠 env 透传(`buildQueryOptions` 构造,customSpawn 透传,cli-wrapper 再 spawnSync 透传)。新版 Claude Code(2.1+)**只读环境变量**,不读 `~/.claude/settings.json`(见 cc-switch Issue #1046)。
