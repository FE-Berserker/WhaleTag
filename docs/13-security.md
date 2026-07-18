← 返回 [plan.md](../plan.md)

# 13. 安全模型

> 当前代码的安全边界、隔离策略、已知保护措施。位置级加密(AES-256-GCM)未实现,只在调研阶段。

## 1. 进程与渲染层隔离

- `contextIsolation: true` `nodeIntegration: false` `sandbox: true`
- 渲染层**永不**直接碰 Node,只经 `window.whale`([src/main/preload.ts](../src/main/preload.ts) 经 `contextBridge.exposeInMainWorld`)
- 详细内容见 [docs/01-architecture.md §7](./01-architecture.md)

## 2. 写路径保护(allowedRoots)

[src/main/allowed-roots.ts](../src/main/allowed-roots.ts):

- `setAllowedRoots(roots)` 注册可写根目录(只有这些目录里的文件可被修改)
- `assertWithinAllowedRoot(filePath)` 校验路径是否落在某个 root 下
- **空集合 = 拒绝所有写**(fail-closed)
- `fs.realpathSync` 解析目标(不存在递归父目录再拼尾部),防 symlink 逃逸
- Windows 大小写归一(`isSameOrDescendant` 比较前 `toLowerCase`)

**只读位置**:从不在 `setAllowedRoots` 注册 → 写 IPC 早 throw → UI 写按钮 disabled。

详见 [docs/02-file-io.md §6](./02-file-io.md)。

## 3. CSP

[src/main/main.ts](../src/main/main.ts) 主进程:

- `onHeadersReceived` 设 renderer CSP(`default-src 'self'; img-src 'self' https: http: data: blob: ...;` 等)
- **跳过 `whale-extension://` 响应** —— 由各扩展 meta CSP 自己治理(主进程 CSP 对扩展过严)

`whale-extension://` 协议:

- `registerSchemesAsPrivileged([{ scheme: 'whale-extension', privileges: { standard: true, secure: true } }])` 在 `app.ready` 之前
- 没这条 → origin opaque → `document.cookie` 抛 `SecurityError`,drawio/excalidraw 等双层 iframe 加载失败

## 4. 扩展 iframe 沙箱

- `sandbox = 'allow-same-origin allow-scripts allow-modals allow-downloads'`
- 主进程只接受 `event.source === iframe.contentWindow` 的消息
- 每个扩展 HTML 自带严格 CSP meta(`script-src 'self' whale-extension://*`,不内联 handler)

## 5. API Key 与凭据

- **AI API key**(ANTHROPIC / OPENAI):Electron `safeStorage`(DPAPI / Keychain)加密落盘 `userData/ai-secrets.json`
- `safeStorage.isEncryptionAvailable()=false` 拒绝存储
- **绝不**进 redux-persist / **绝不**回显明文
- 设置页只显示"已设 / 未设"状态

## 6. 流式推送通道

- 唯一 main → renderer 推送通道 = `ai:chunk` / `ai:error` / `ai:approvalRequest`
- `preload.onAi*` 返回 unsubscribe
- **仅固定 `ai:*` 通道**,不泛化整桥
- AI 关闭时通道不暴露

## 7. 工具系统护栏

- **Claude 路径**:CLI 自带 Read/Write/Edit/**Bash** 直接碰盘;`canUseTool` 回调先过 `readOnlyGuard` 再决定是否推批准
- **HTTP 路径**(Whale 自有工具 `read_file` / `list_directory` / `write_file`):每个执行器经 `assertWithinAllowedRoot` 守护,写经 `atomicWriteText`;共用 `decideToolCall` 在 Claude 与 HTTP 间一致

**只读位置硬拒**:只读根下 Write / Edit / NotebookEdit / Bash 调用 → 批准弹框**之前**直接 reject,不再问用户。

## 8. 数据层

- **redux-persist** 走主进程同步 IPC + atomic write(`.tmp + renameSync`),不丢数据;详见 [docs/02-file-io.md §8](./02-file-io.md)
- **sidecar**:标签 / 描述 / 颜色走 `.whale/wsd.json` 目录级聚合,不嵌入文件名
- 路径存储为相对路径(便于整体迁移)

## 9. 外部链接

- 扩展内的 `<a href="https://...">` 点击 → `window.whaleExt.postMessage({ type: 'openLinkExternally', url })` → 主进程 `shell.openExternal`
- 不在应用内导航,不在扩展内直接跳转

## 10. Trash

- 删除默认走 `shell.trashItem`(系统回收站),可恢复
- 设置 `deleteToTrash: false`(redux-persist 设置项)才走 `fs.rm` 永久删除
- toast 提供"打开回收站"按钮

## 11. 用户自定义 shell 命令(设置 → 命令)

用户在设置里录入命令行模板(如 `python process.py ${path}`),右键文件/文件夹 → "命令" 子菜单运行,弹**新终端窗口**显示输出。本地优先 power-user 能力,安全模型见 [src/main/shell-command.ts](../src/main/shell-command.ts):

- **opt-in**:模板存 redux-persist `settings.userCommands`(默认空 `[]`),未配置则右键菜单不显示"命令"子菜单。
- **路径不可信,模板可信**:模板是用户显式录入;被替换进去的**文件路径**不可信(文件名可能含 `&` `|` `"` `%` 元字符 → 命令注入)。
- **主进程做替换 + 引号**:renderer 只传 `{ template, targetPath }`;主进程 `runUserCommand` 把 `${path}` / `${dir}` / `${name}` 替换成**加好引号的值**再拼命令。renderer 永不构造 shell 字符串。
- **引号复用** [windowsCmdShim.ts](../src/main/ai/utils/windowsCmdShim.ts) 的 `quoteWindowsShellArgument`(cmd 双引号 + 内嵌 `"` 翻倍)+ POSIX 单引号([shell-quote.ts](../src/main/shell-quote.ts))。
- **`assertWithinAllowedRoot(targetPath)` 在 IPC 入口**(`shell:runCommand`,[ipc.ts](../src/main/ipc.ts))—— 拒配置位置外的路径 / symlink 逃逸 / 未注册根(fail-closed),对齐 `fs:rename` / `fs:delete`。
- **Windows `%` 拒绝**:cmd 默认下 `"..."` 内的 `%VAR%` 仍展开(`%%` 只在 .bat 内有效,`cmd /k` 内不可靠转义)→ 路径含 `%` 直接拒,renderer toast 报 `commandPathBlocked`。`!`(delayed expansion 关)放行。详见 [docs/09 §24](./09-known-issues.md)。
- **`spawn` + `detached` + `child.unref()`**(fire-and-forget,新终端窗口归用户);永不 `exec`。
- **不按只读位置拒绝**:命令是用户显式 opt-in 的外部进程(可能只读分析),`readOnlyGuard`(约束 WhaleTag/AI 自身的写)不适用 —— 只保留 `assertWithinAllowedRoot` 这道基础闸。

## 12. 已知不在范围

| 项 | 状态 | 说明 |
|---|---|---|
| **位置级加密**(AES-256-GCM + scrypt) | ❌ 不实现 | 主进程 `crypto:` 模块未写;只在调研阶段;生产用户没强需求 |
| **云存储加密** | 🚫 不实现 | 云存储本身(S3 / WebDAV)不在范围 |
| **导入 / 导出** | 🚫 不实现 | 配置 / 标签库 / 位置 JSON 备份 与 `.ts → .whale` 迁移工具均不做 |
| **安全审计日志** | ⏳ 未做 | 用户没强需求 |

> 任何"安全加强"需求先列到对应模块文档的"已知取舍 / 遗留"或新章节,不开"未来加密"段。

## 13. 读侧边界(2026-07-18 审阅 + 修复)

写操作 33 处过 `assertWithinAllowedRoot`(§2)。审阅发现读路径完全不受限、与威胁模型不一致;**通道闸已修(同日)**:

- ✅ `fs:readFile` / `fs:readTextFile` handler 入口加 `assertWithinAllowedRoot`([ipc.ts](../src/main/ipc.ts));扩展 `requestFileBytes` 汇到 `fs:readFile`,同步被闸。渲染层调用方全部为用户动作驱动(打开文件 / AI 附件 / 灯箱 / 搜索命中,均在位置内),fail-closed 不伤启动路径;AiPanel 附件读取带 try/catch 降级(读不到就只发路径)。
- ✅ `fs:openNative` 同闸;扩展 `openLinkExternally`(http(s) 分流 `window.open` 后)与 `openNative` 消息汇到它,"任意路径启动 OS 程序"的面被封。
- ⏳ **遗留**:能力授予"全有或全无"——manifest 无 permissions / capabilities 字段,pdf-viewer 与 text-editor 拥有完全相同的宿主能力面。目前 15 个扩展全是内置自研,威胁面可控;引入第三方 / 用户扩展机制前须补"按 manifest 声明能力白名单放行 `request*` 消息类型"。
