← 返回 [plan.md](../plan.md)

# 13. 安全模型

> 当前代码的安全边界、隔离策略、已知保护措施。位置级加密(AES-256-GCM)未实现,见 §9。

## 1. 进程与渲染层隔离

- `contextIsolation: true` `nodeIntegration: false` `sandbox: true`
- 渲染层**永不**直接碰 Node,只经 `window.whale`([src/main/preload.ts](../src/main/preload.ts) 经 `contextBridge.exposeInMainWorld`)
- 用户数据交给会渲染 HTML 的第三方组件时**必须在 sink 转义**:ECharts tooltip 默认 `renderMode: 'html'`(innerHTML),而标签名经 `.whale/wsd.json` 或 MCP 工具可被任意字符串污染 → 统一走 [escape-html.ts](../src/renderer/services/escape-html.ts)。只转义 HTML sink,标签显示值(React 文本节点)保持原样,否则界面会显示 `&lt;`
- 详细内容见 [docs/01-architecture.md §7](./01-architecture.md)

## 2. 写路径保护(allowedRoots)

[src/main/allowed-roots.ts](../src/main/allowed-roots.ts):

- `setAllowedRoots(roots)` 注册可写根目录(只有这些目录里的文件可被修改)
- `assertWithinAllowedRoot(filePath)` 校验路径是否落在某个 root 下
- **空集合 = 拒绝所有写**(fail-closed)
- `fs.realpathSync` 解析目标(不存在递归父目录再拼尾部),防 symlink 逃逸
- Windows 大小写归一(`isSameOrDescendant` 比较前 `toLowerCase`)

**位置来历(provenance)**:`fs:setAllowedRoots` 只接受主进程记录在案的目录——用户在原生文件夹对话框里选过的(处理器在返回路径前用 [known-roots.ts](../src/main/known-roots.ts) 的 `rememberPickedRoot` 记录,持久化到 `<userData>/known-roots.json`),或升级/首装后第一次推送时的一次性种子(TOFU,写入记录后再以记录为准)。未知目录记 `console.warn` 后丢弃,不进入 `allowedRoots`——渲染层即使被注入,也无法把 `/` 注册成位置。记录文件损坏或不可读时按"未 seed"重来,而不是把用户锁在门外(若该路径被目录占用,先把目录改名为 `known-roots.json.corrupt-<时间戳>` 再重新记录,否则之后每次写入都会失败);位置目录改名后旧路径不再是已知目录,需重新添加。

**只读位置**:仍会注册进 `allowedRoots` 以允许读取；`allowedRoots` 只界定“哪些位置可访问”，不等同于只读权限。只读位置的写操作拦截在 renderer 的 IOActions / FileList / useListCommands 守卫，主进程写 IPC 不会仅凭 `isReadOnly` 拒绝。

修订历史 IPC(`ext:backupRevision` / `ext:listRevisions` / `ext:restoreRevision` / `ext:deleteRevision`)过同一闸;`deleteRevision` 额外把 revision 路径绑定到所属文件的 `<dir>/.whale/revisions/` 前缀(与 restore 相同)——`rm --force` 不进回收站,不做绑定就是任意路径强删。`ext:cleanupRevisions` 只接受有限、非负的 number，非法天数在删除前 reject。详见 [docs/07-extensions.md](./07-extensions.md)。

读取入口也遵守同一位置边界：`fs:readFile` / `fs:readTextFile` / `fs:readFileBase64` / `fs:listDirectory` / `fs:listDirectoryRecursive` / `folderMeta:read` 都过 `assertWithinAllowedRoot`——目录枚举同样能揭示位置外路径，递归扫描还会写 `<dir>/.whale/` 缓存，所以不能只防"读内容"；`fs:pathExists` 这个无校验的死通道已删除。目录缩略图加载/背景加载会校验目录(缺图时可能自动生成并写 `.whale`)，设置目录缩略图/背景会校验目标目录；原生对话框自选的 source 图片可以位于位置外，但服务只读取源、只在目标目录 `.whale/` 写入。单文件缩略图读取(`thumbnail:load`)同样先校验文件路径；`fs:zipEntries` 的归档目标也校验(名字是渲染层拼的用户输入，`..\..\x.zip` 不得越界)，`fs:zipDirectory` 的目标由主进程从源路径推导、保持豁免。`index:query` / `index:advanced` / `index:tags` / `index:status` / `fulltext:search` / `fulltext:has` 均在访问索引前校验 root。侧车批量读(`sidecar:readMany*`)仍不校验 root——它只返回调用方已给出文件名对应的元数据，无法枚举目录。

`fs:importExternal`(从系统拖入文件)的**源路径**不做位置校验：拖拽 API 只给路径字符串，主进程无法验证"这确实是一次用户拖拽"，而要求源在位置内会直接废掉"从资源管理器拖进来"这个功能。**目标目录**仍过 `assertWithinAllowedRoot`。残余风险如实记录：被注入的渲染层可以把任意可读文件复制进某个位置，再经 `fs:readFile` 读回——消除它只能取消位置外拖入，属已知取舍。

写入侧还有一条同等重要的边界：`fs:move` / `fs:copy` 的**目的地**此前只校验源路径（代码注释称"目的地可以是用户选的任意目录"），等于给注入的渲染层留了一条"把任意内容搬进 Startup / `~/.ssh`"的写逃逸；现在两端都过 `assertWithinAllowedRoot`（[fs-write.ts](../src/main/ipc/fs-write.ts)），与 `fs:rename` 对齐。`fs:importExternal` 的 `cp` 同时补 `force: false`——Node 默认 `force: true` 会静默覆盖 readdir 快照之后才出现的同名文件。

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

## 5. 数据层

- **redux-persist** 走主进程同步 IPC + atomic write(`.tmp + renameSync`),不丢数据;详见 [docs/02-file-io.md §8](./02-file-io.md)
- **sidecar**:标签 / 描述 / 颜色走 `.whale/wsd.json` 目录级聚合,不嵌入文件名
- 路径存储为相对路径(便于整体迁移)

## 6. 外部链接

- 扩展内的 `<a href="https://...">` 点击 → `window.whaleExt.postMessage({ type: 'openLinkExternally', url })` → 主进程 `shell.openExternal`
- 不在应用内导航,不在扩展内直接跳转
- 主窗口 `will-navigate` 锁定:渲染层无法把窗口导航到任意外部页面——preload 桥(`window.whale`)会随导航留在新页面,等同于把全套 IPC 交给目标页。dev 仅放行 dev server origin(HMR reload 不触发 will-navigate),生产全部 `preventDefault`;外链仍走 `setWindowOpenHandler` → `shell.openExternal`。

## 7. Trash

- 删除默认走 `shell.trashItem`(系统回收站),可恢复
- 设置 `deleteToTrash: false`(redux-persist 设置项)才走 `fs.rm` 永久删除
- toast 提供"打开回收站"按钮

## 8. 用户自定义 shell 命令(设置 → 命令)

用户在设置里录入命令行模板(如 `python process.py ${path}`),右键文件/文件夹 → "命令" 子菜单运行,弹**新终端窗口**显示输出。本地优先 power-user 能力,安全模型见 [src/main/shell-command.ts](../src/main/shell-command.ts):

- **菜单形态(2026-07-22)**:"命令"是右键菜单里**单项父条目**(Terminal 图标 + 右侧 ▸),悬停/点击在其右缘开**飞窗子菜单**列出全部适用命令(各带 Terminal 图标,模板作原生 tooltip)——命令再多也不撑长主菜单。实现在 [EntryContextMenu.tsx](../src/renderer/components/EntryContextMenu.tsx)(flyout 复用 GanttEntryMenu 的兄弟 `<Menu anchorEl>` 模式,悬停开 + 250ms 关窗宽限计时器防斜线误关;flyout Modal root 须设 `pointer-events:none`(paper 恢复 `auto`),否则全屏 root 层盖住父菜单项 → 幻影 mouseLeave/Enter 循环 = 飞窗闪烁)。

- **opt-in**:模板存 redux-persist `settings.userCommands`(默认空 `[]`),未配置则右键菜单不显示"命令"子菜单。
- **路径不可信,模板可信**:模板是用户显式录入;被替换进去的**文件路径**不可信(文件名可能含 `&` `|` `"` `%` 元字符 → 命令注入)。"可信"的前提是它确实来自设置——主进程只执行被推送过的模板(见下一条)。不过"来自设置"只是必要条件:首次运行某个模板时主进程还会弹一次原生确认(见下一条)。
- **主进程做替换 + 引号**:renderer 只传 `{ template, targetPath }`;主进程 `runUserCommand` 把 `${path}` / `${dir}` / `${name}` 替换成**加好引号的值**再拼命令。renderer 永不构造 shell 字符串。
- **引号复用** [shell-quote.ts](../src/main/shell-quote.ts) 的 `quotePathForShell` —— win32 走 cmd 双引号 + 内嵌 `"` 翻倍,POSIX 单引号 close-reopen。
- **`assertWithinAllowedRoot(targetPath)` 在 IPC 入口**(`shell:runCommand`,[shell.ts](../src/main/ipc/shell.ts))—— 拒配置位置外的路径 / symlink 逃逸 / 未注册根(fail-closed),对齐 `fs:rename` / `fs:delete`。
- **模板白名单 + 主进程一次性授权**:渲染层在启动(`PersistGate` 之后)与设置变更时把 `settings.userCommands` 的模板串推给主进程(`shell:setCommandTemplates`,[UserCommandTemplateSync.tsx](../src/renderer/components/UserCommandTemplateSync.tsx));但"渲染层说这是用户配置的"**不构成**授权——被注入的渲染层可以推任意模板。因此 `shell:runCommand` 在真正 spawn 前由**主进程**弹原生对话框展示完整命令并等待用户 Allow;批准按模板串持久化到 `<userData>/approved-command-templates.json`(tmp + rename 原子写),同一模板只问一次,编辑模板即重新询问。拒绝或对话框不可用 → 抛 `COMMAND_NOT_APPROVED`(fail-closed,[shell-types.ts](../src/shared/shell-types.ts))。两层合起来:名单负责"不越出设置",对话框负责"用户真的点了同意"([shell.ts](../src/main/ipc/shell.ts))。`runUserCommand` 自身仍只执行名单内模板,其余抛 `COMMAND_NOT_ALLOWED`([shell-command.ts](../src/main/shell-command.ts))。
- **Windows `%` 拒绝**:cmd 默认下 `"..."` 内的 `%VAR%` 仍展开(`%%` 只在 .bat 内有效,`cmd /k` 内不可靠转义)→ 路径含 `%` 直接拒,renderer toast 报 `commandPathBlocked`。`!`(delayed expansion 关)放行。详见 [docs/09 §22](./09-known-issues.md)。
- **`spawn` + `detached` + `child.unref()`**(fire-and-forget,新终端窗口归用户);永不 `exec`。macOS 走 `osascript`,脚本字符串**先双写 `\` 再转义 `"`**(顺序反了会让命令里的反斜杠吃掉转义);终端进程 spawn 失败(`error` 事件)现在 reject 到渲染层,不再 `console.warn` 后返回 `{ ok: true }` 假装启动成功。
- **不按只读位置拒绝**:命令是用户显式 opt-in 的外部进程(可能只读分析),只保留 `assertWithinAllowedRoot` 这道基础闸。

## 9. 已知不在范围

| 项 | 状态 | 说明 |
|---|---|---|
| **位置级加密**(AES-256-GCM + scrypt) | ❌ 不实现 | 主进程 `crypto:` 模块未写;只在调研阶段;生产用户没强需求 |
| **云存储加密** | 🚫 不实现 | 云存储本身(S3 / WebDAV)不在范围 |
| **导入 / 导出** | 🚫 不实现 | 配置 / 标签库 / 位置 JSON 备份 与 `.ts → .whale` 迁移工具均不做 |
| **安全审计日志** | ⏳ 未做 | 用户没强需求 |

> 任何"安全加强"需求先列到对应模块文档的"已知取舍 / 遗留"或新章节,不开"未来加密"段。

## 10. 读侧边界(2026-07-18 审阅 + 修复)

写操作 33 处过 `assertWithinAllowedRoot`(§2);读路径此前完全不受限、与威胁模型不一致,通道闸已修:

- ✅ `fs:readFile` / `fs:readTextFile` / `fs:readFileBase64` handler 入口加 `assertWithinAllowedRoot`([fs-read.ts](../src/main/ipc/fs-read.ts))。渲染层调用方全部为用户动作驱动(打开文件 / 灯箱 / 搜索命中 / 扩展嵌图,均在位置内),fail-closed 不伤启动路径。
- ✅ `fs:openNative` 同闸;扩展 `openLinkExternally`(http(s) 分流 `window.open` 后)与 `openNative` 消息汇到它,"任意路径启动 OS 程序"的面被封。扩展发来的 `file://` 链接先 `fileURLToPath` 还原成真实路径再过闸(drawio 的相对链接就是这种形态;此前直接拿 URL 串比对 root，必然失败且错误被静默吞掉)。
- ✅ `exif:extractGps` / `exif:get-summary` 同闸([search-index.ts](../src/main/ipc/search-index.ts))——Mapique 只对位置内文件取 EXIF,与此节声明对齐。
- ⏳ **遗留**:能力授予"全有或全无"——manifest 无 permissions / capabilities 字段,text-editor 与 image-viewer 拥有完全相同的宿主能力面。目前 8 个扩展全是内置自研,威胁面可控;引入第三方 / 用户扩展机制前须补"按 manifest 声明能力白名单放行 `request*` 消息类型"。

## 11. 本地 MCP 服务器(0.5.0)

外部 AI 客户端的文件操作入口(详见 [./21-mcp.md](./21-mcp.md)):

- 只监听 `127.0.0.1`,默认关闭;每个请求必须携带 Bearer token(`timingSafeEqual` 比较,设置页可再生成);token 优先经 OS 密钥库(`safeStorage`)加密落盘,无可用密钥库时回退明文并在配置里标记(`tokenStorage`),旧明文配置下次写入自动迁移;Host 头必须是回环自身(先于 401 返回 403,防 DNS rebinding)。
- 所有工具路径过 `assertWithinAllowedRoot`;且比渲染层 IPC 更严——move/copy 的**目的地**也必须在 roots 内。
- 写操作分级:sidecar 级(标签/描述)免审批;文件级(move/copy/delete/zip/create)推送审批弹窗,**无窗口 / 60s 超时 / 拒绝一律视为拒绝**(fail-closed)。
- 只读模式(默认开)拒绝一切变更工具;删除仅回收站,不提供永久删除。
- JSON-RPC batch 元素数上限 32(`MAX_BATCH_ELEMENTS`,[mcp-http.ts](../src/main/mcp/mcp-http.ts)):4 MiB body 上限单独不足以阻止单请求塞入十万条小调用串行占用主线程;超限 413。
- MCP 配置在 POSIX 上以 `0o600` 落盘(见 §12):无可用密钥库时该文件含明文 bearer token,不能让同机其他用户读到。

## 12. 进程权限与敏感文件模式(2026-11)

- **权限默认拒绝、按真实用途精确放行**:[main.ts](../src/main/main.ts) 的 permission request / check 共用 fail-closed 策略。只有主界面与 `json-viewer` 的 `clipboard-sanitized-write`、`image-viewer` 的 `fullscreen` 可放行,而且必须同时满足:请求来自当前主窗口的 `webContents`、顶层页面是开发服务器或打包后的精确 renderer URL、frame URL / origin 与主界面或对应扩展精确匹配;扩展 iframe 还校验 `embeddingOrigin`。摄像头 / 麦克风 / 定位 / 通知 / MIDI、外站与相似域、任意 `file://`、其他扩展及异常路径一律拒绝。
- **敏感文件 0600 与日志保留上界**:`<userData>/crash.log` 与 MCP 配置(`mcp-config.json`,可能含明文 bearer token)在 POSIX 上以 `0o600` 落盘([crash-guard.ts](../src/main/crash-guard.ts)、[mcp-config.ts](../src/main/mcp/mcp-config.ts) 经 [atomic-write.ts](../src/main/atomic-write.ts) 新增的 `AtomicWriteOptions.mode`)。crash.log 先打开 fd,**写前** `fchmodSync(fd, 0o600)` 修正历史 0644 文件,再追加并关闭;chmod 失败时不写入本次敏感内容,外层 best-effort 崩溃处理仍继续。活动日志追加后若将超过 1 MiB 会先轮换为唯一 `crash.log.1`,不截断单条记录;轮换失败会警告并继续保留当前记录。MCP 配置经 atomic-write 在同一 fd 上 `chmod(mode)`,并于 datasync、close 与 rename 前完成;权限强化失败会上抛、清理 tmp 且不替换原文件,不再静默以宽权限发布。Windows 跳过 POSIX mode。
- **崩溃日志脱敏**:主进程致命异常与 renderer 上报都先过 `sanitizeErrorDetail` 再写盘 / 弹窗:任意详情归一为字符串、去控制字符、截断到 4000 字符,并把 home 目录前缀替换成 `~`——崩溃报告常被贴进 issue,原始 stack 的绝对路径会把账号名一起带出去。
- **已接受取舍**:① CSP `img-src` 保留 `http(s)`(§3)——Mapique 地图瓦片从 OSM / 用户自建瓦片服务器加载,去掉即废地图;HTML 仍过 DOMPurify,扩展 iframe 另受自身 CSP 约束。② 目录缩略图 / 背景的 source 图片可位于位置外(§2 末)——来自原生选择框,服务只读源、只写目标 `.whale/`;残余风险是被注入的渲染层可绕过对话框把任意图片路径当 source(结果只落成缩略图 jpg),随"位置外选图"能力接受,记录于 [boundary-guards.test.ts](../src/main/ipc/boundary-guards.test.ts)。

## 13. 第三方依赖审计与残余告示(2026-11)

- 直接补丁升级为 `electron@42.11.18`、`electron-builder@26.18.0`、`concurrently@9.2.5`、`rimraf@6.1.4`、`webpack-dev-server@5.2.7`，再执行不带 `--force` 的 `npm audit fix` 更新兼容的传递补丁。完整审计从 49 项（3 critical）降为 27 项（0 critical），`--omit=dev` 从 20 项降为 12 项（0 critical）；审计数量按受影响依赖节点计，不等于 12 个独立漏洞。
- 剩余运行时节点全部位于 Excalidraw 的 Mermaid 传递链与 ECharts 5。`@excalidraw/excalidraw@0.18.1` 已是当前上游版本，其固定传递依赖没有同版本线内的完整修复；不通过降级 Excalidraw、跨 major 覆盖 nanoid/KaTeX 或强升 Mermaid 适配器来制造“审计归零”。
- ECharts 6 的升级与 `echarts-wordcloud@2.1.0` 的 `^5.0.1` peer 和深路径注册方式不兼容，因此保留 `echarts@^5.6.0`。当前所有 HTML tooltip 的用户名称都在 sink 经 `escapeHtml`（§1 与 `escape-html.test.ts`），这是已知上游告示下的应用层缓解，不声称替代未来兼容升级。
- 其余完整树节点来自 drawio-offline 的旧 electron-updater、electron-builder / typescript-eslint 的 minimatch、webpack-dev-server / sockjs 的 uuid 等开发或构建链。它们不进入运行时白名单；对构建配置受信、dev server 仅本机使用的当前模型，不采用跨 major 降级或强制 overrides。后续上游出现同线修复时再收敛。
