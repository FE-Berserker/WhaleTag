← 返回 [plan.md](../plan.md)

# 02. 文件浏览与 IO

> 位置管理、目录浏览、文件操作(重命名 / 移动 / 复制 / 删除 / 新建 / 打开)、回收站、redux-persist 主进程同步 IO、allowedRoots 写保护、原子写。

## 1. 位置管理

- **本地文件夹位置**(本地路径,CRUD:`createLocation` / `updateLocation` / `deleteLocation`)
- **切换最近**:LRU(`reducers/recent.ts`),前进 / 后退栈
- **只读位置**:写拦截在 **renderer 层**(`IOActionsContextProvider.runAndRefresh` 早 throw + FileList/useListCommands 守卫 + 写按钮 disabled)。**注意**:`setAllowedRoots` 收到的 roots **包含**只读位置(Root.tsx 全量推送)——allowedRoots 只表达"配置的 location",主进程写 IPC 对只读位置**不会**早 throw;Whale 自身元数据如 `.whale/index.db` 仍会写入只读位置。

云存储(S3 / WebDAV)、导入导出、`.ts → .whale` 迁移工具均**不在范围**。详见 [docs/09-known-issues.md](./09-known-issues.md)。

## 2. 目录浏览

- **目录树**`[DirectoryTree](../src/renderer/components/DirectoryTree.tsx)` — 懒加载,展开/折叠
- **面包屑**`BreadcrumbNav` — 点各级跳转
- **虚拟滚动**`react-window` v2(列表行级别)
- **排序**列头点击 `sort.key + sort.order` 升 / 降

每个文件夹的视觉状态(viewMode / entrySize / 列配置等)持久化到 `.whale/wsm.json`,per-folder 恢复;切走切回保持。

## 3. 文件操作

| 操作 | 实现路径 |
|---|---|
| 重命名 | `fs:rename` → 写 new `wsm.json`/sidecar + delete 旧 |
| 移动 | `fs:move` 优先 rename;**跨卷 EXDEV** 回退 `fs.copyFile + fs.rm`(确保不静默失败) |
| 复制 | `fs:copyFile` 二进制复制;sidecar 单独 follow-up 写 |
| 删除 | 默认走 **`shell.trashItem`**(系统回收站);设置 `deleteToTrash: false` 走 `fs.rm` 永久删除;toast 附"打开回收站"按钮 |
| 打包 | `zipEntries` → Windows 用 PowerShell `Compress-Archive`,其余平台用 `zip -r`。POSIX 从**所有源的最近公共父目录**执行(`commonParentDir`),多选跨目录时条目仍保留相对路径(旧实现只取第一个源的目录,其余源被静默丢弃/重复);`zip` 未安装(Ubuntu Desktop 默认不装)时退回 `python3` + 内置 `zipfile` 脚本,布局相同(空目录不入包);目标已存在则拒绝,不覆盖 |
| 新建 | `createTextFile` / `createDirectory` —— **不覆盖已有**(不可变偏好);文本创建用 `writeFile(..., { flag: 'wx' })` 原子拒绝已存在目标,不靠 `existsSync` 预检查 |
| 打开 | 优先内置扩展(dispatch 选 `selectExtension`);无匹配走 `shell.openPath` |

> **Toast 严重度(2026-07-22)**:FileList 的 notice 是结构化 `{ text, severity, openTrash? }`,严重度由产生处显式携带(`showNotice(msg, severity?)`,默认 error)——**不再**从本地化文本前缀匹配推断(旧实现在 ja/ko 下前缀为空串恒真 → 错误全显示绿色成功;en/zh 下 moved/packaged 成功反显示红色)。成功:movedToTrash / deletedPermanently(warning) / tagsApplied / movedItems / packaged / importedItems / folderThumbnail·Background Set·Cleared。

**写路径必须经过 `assertWithinAllowedRoot`**(见 §6),保证只能修改已注册位置。

**主进程 IO 性能**(防 UI 冻结):

- `readTextFile`:chardet 只采样前 256KB(不扫整个 buffer);替换字符计数用 `indexOf` 循环(不建百万级 `match` 数组)。多 MB 老编码文件不再冻 UI 数百 ms
- `readFileBase64`:Main 用 `Buffer.toString('base64')` 一次编码,供扩展嵌图;避免 Renderer 对大 `Uint8Array` 逐字节转字符串。入口同样过 `assertWithinAllowedRoot`

## 4. 右键菜单

`EntryContextMenu.tsx` 聚合已有操作,场景分类:

- 行 / 多选 / 空白 / 目录树节点 / 位置条目 — 各自适用的子集
- 「在资源管理器中打开」 = `shell.showItemInFolder` / macOS `open -R <path>`(Win10+ 会高亮 + 选中文件)
- 「Open With…」子菜单列出所有匹配扩展 + 系统应用
- 「复制路径」 = `navigator.clipboard.writeText(entry.path)`(OS-native 绝对路径;粘贴到 Finder / 资源管理器 / 终端均可) —— 主列表 [EntryContextMenu](../src/renderer/components/EntryContextMenu.tsx) 单文件分支与目录树 [DirectoryTree](../src/renderer/components/DirectoryTree.tsx) 的节点右键菜单都提供;目录树的菜单额外挂本地 Snackbar(底部左侧)反馈成功 / 失败,使用 i18n key `copyPathDone` / `clipboardUnavailable`

## 5. 历史

前进 / 后退按钮 + LRU 最近目录列表。

## 6. allowedRoots 写保护

[src/main/allowed-roots.ts](../src/main/allowed-roots.ts):

- `setAllowedRoots(roots: string[])` 注册可写根目录
- `assertWithinAllowedRoot(filePath)` 校验给定路径在某个 root 下;**空集合 = 拒绝所有写**(fail-closed,`allowed-roots.ts:47-49` 抛 "Refused: no configured locations")
- 对称路径用 `fs.realpathSync` 解析目标(不存在则递归解析存在的父目录再拼尾部,`allowed-roots.ts:27-39` `resolveGuardPath`),防止 symlink 逃逸;`setAllowedRoots` 也对 root 做 `realpathSync`(不可达 fallback 到 `path.resolve`)
- Windows 大小写归一(`isSameOrDescendant` 调用前 `toLowerCase()`)
- **只读位置**(`isReadOnly=true`)的写拦截在 renderer 层(IOActions / FileList / useListCommands 守卫);allowedRoots **包含**只读位置(见 §1 上方条目),主进程写 IPC 不对其早 throw
- **读取也受限**:`fs:listDirectory` / `fs:listDirectoryRecursive` / `folderMeta:read` 与文件读取一样过 `assertWithinAllowedRoot` —— 目录枚举能揭示位置外有哪些文件,递归扫描还会把缓存写进 `<dir>/.whale/`,所以不能只防"读内容"。`fs:pathExists` 这个无校验、渲染层从未调用的死通道已删除(暴露面只减不增)。渲染层首次挂载时子 effect 早于 Root 的 `setAllowedRoots`,因此列目录前先 `await waitForAllowedRoots()`。侧车批量读(`sidecar:readMany*`)仍不校验 root:它只返回调用方已给出文件名对应的元数据,无法枚举目录。

**renderer 侧 await helper**(`src/renderer/services/allowed-roots.ts`):

`setAllowedRoots` 走 `ipcRenderer.invoke` 是异步的,而 React 子 → 父的 effect 顺序会让子组件在父 `setAllowedRoots` 之前先发出写 IPC(`index:build` / `tagLibrary:read`),被 fail-closed 拒绝后 effect 不重跑(典型表现:TaskReminder 启动警告 + 永不再弹)。

为对齐"何时发写 IPC"和"何时根目录到位",提供两个 module-scope helper:

- `setAllowedRootsAndWait(roots)` — `Root.tsx` 用它替代裸的 `ipcApi.setAllowedRoots`,记下 in-flight promise
- `waitForAllowedRoots()` — 子组件在发写 IPC / 列目录前 `await` 它;没有 in-flight 注册时先让出一个 microtask,让同一轮 commit 里父 effect 的注册先落地(Root 的 effect 在子之后同步执行)

不要新增同步 IPC(`sendSync`);`await` 的是已经 in-flight 的同一个 promise,不增加 round trip。完整原因 + 替代方案评估见 [docs/09-known-issues.md §16](./09-known-issues.md)。

## 7. 原子写

[src/main/atomic-write.ts](../src/main/atomic-write.ts):

```
writeFileAtomic(path, write):
  fd = open(path.tmp, 'w')
  await write(fd)        # 调用方通过 fd.writeFile / fd.write 写入
  fd.datasync()          # fsync
  fd.close()
  rename(tmp, path)      # atomic on same fs
```

- 写文件前先清理目标目录下 `<basename>.<pid>.<counter>.tmp` 残留(崩溃遗留;每个 target 每进程只 sweep 一次);只接受精确数字后缀,不会把 `foo.jpg.<pid>.<counter>.tmp` 误当成目标 `foo` 的临时文件
- 临时文件名带 `pid + 单调计数器` 后缀,同一 target 的并发写各有自己的 tmp,不会互相 rename 掉对方的文件
- **同一 target 的写串行排队,不同 target 并行**(模块级 `Map<string, Promise>`):既避免 sweep 删掉在途临时文件,也避免 Windows 上两个 rename 抢同一目标时的 `EPERM`;前一个写失败不会污染队列里的下一个
- 递归缓存 `loadRecursiveScan` 在入口重新校验 IPC depth:非有限值回退 3,其余取整并限制在 1–5,避免异常 depth 影响缓存路径或扫描工作量
- 用于 sidecar、索引迁移标志、redux-persist 写盘

**读语义:`ENOENT` 与空白文件视为"没有已保存数据"**。`wsd.json` 的读取入口 `loadWsd(dirPath)` 在文件缺失或内容为空白时返回 `null`(空白文件可由后续写入重建);非空的 JSON 解析失败、结构不合法(`Invalid aggregated sidecar format: <path>`)、以及非 ENOENT 的 IO 错误(权限 / EIO / 共享冲突)一律上抛,绝不会被当成"空数据"覆盖。这条约束防止把读失败误判为不存在 → 迁移或覆盖写回时抹掉真实元数据。

**写入失败保护与读取降级是两条不同路径**:sidecar 写入 / 修改遇到损坏或 IO 错误仍直接向调用者报错并保留原件;索引器 `readSidecars` 对坏目录记录 warning、以无 stored tags 继续索引文件;批量展示 `readSidecardsForPaths` 用 `Promise.allSettled` 跳过失败目录并返回其余健康结果,不让一个坏目录拖垮整个 location 或视图。

**损坏可见、恢复需确认**:UI 使用 detailed read,在健康数据正常展示的同时报告 `corrupt`(非法 JSON/结构,含 SHA-256)或 `unreadable`(IO)并保留持久 warning。只有用户对 corrupt 项确认后才调用恢复:Main 在 allowedRoots 与目录锁内重读并核对指纹,以 `wx` 排他写入 `wsd.json.corrupt-<时间>-<指纹>.bak` 保存捕获的原字节,再把可读取的 legacy 标签合并进新的有效聚合(legacy 文件本身不删除/不改动);指纹变化、已合法/空白/缺失均零写。失败保留原件和备份;成功后 UI 可定位备份并刷新。恢复保留 legacy 原文件时,删除最后一个标签会保留空聚合作为屏障,避免下次读取重新导入 legacy;无 legacy 的空目录仍删除空聚合。**legacy 迁移只删"确实解析成功"的文件**:[sidecar.ts](../src/main/sidecar.ts) 的 `readLegacySidecars` 把非法 JSON / 非对象文档归入 `corrupt`,迁移时只 `rm` 已解析路径,并把坏文件重命名为 `<name>.json.corrupt-<时间戳>`(字节原样保留,改名后不再匹配 `.json` 扫描,迁移不会反复重跑);重命名失败则留在原地并记录 warning,下次读取再试,绝不删除。

**读-改-写路径:损坏 ≠ 空**。`wsm.json`(folder-meta)与 `wtaglib.json`(per-location 标签库)的展示读取仍是宽松策略:缺失 / 非法都返回空(`folder-meta.ts` / `tag-library.ts`),因为它们只是视图偏好与描述文本。但**写入路径不再复用宽松读取**:`writeFolderMeta` / `setTagLibraryDescription` / `clearTagLibraryDescription` 经 [merge-read.ts](../src/main/merge-read.ts) 的 `readJsonForMerge` 取合并基底 —— 文件缺失返回 `null`(从空开始);JSON 损坏或外形不符时把原文件**隔离**为同目录 `<name>.corrupt-<ISO 时间戳>`(字节原样保留,永不删除),记录 warning 后从空开始,因此一次单字段修改不会把其余 tags / color / description / perspective 一起抹掉;非 ENOENT 的 IO 错误(权限 / EIO / 共享冲突)直接**上抛**,绝不当"空"覆盖。`wsd.json` 承载文件级标签,沿用更严格的 §7 策略(损坏上抛 + UI 确认恢复),不容许任何降级。

## 8. redux-persist(主进程 IO)

**位置**:`%APPDATA%/WhaleTag/persist/whale-root.json`。redux-persist 的 root key = `whale-root`(在 `src/renderer/store/configureStore.ts:32`),文件名由 `persistDir() + sanitize(key) + '.json'` 拼出(`persist-storage.ts`),特殊字符替换为 `_`,本 key 无需替换。

**为什么不走 localStorage**:Chromium 异步 flush;OS 强杀 / 3s close-fallback 会丢最后几毫秒的写。主进程 IO(`fsp.writeFile(.tmp)` + `fsp.rename`)保证 `setItem` resolve 时字节已落盘。

**不再用 sendSync(2026-07-18)**:旧链路 `sendSync` + 同步 fs 双向阻塞(渲染主线程 + 主进程事件循环,被缩略图等 CPU 任务放大)。现为 async `invoke` + async fs,durability 语义不变(invoke resolve 时已落盘),`persist:*Sync` 通道已删;rehydration 走 `PersistGate`(index.tsx),退出 flush 握手(`persistor.flush()` → `app:flush-complete`)升级为 load-bearing —— 关窗前必须排干在途写。

**架构**:

```
renderer
  └─ storage.getItem/setItem (src/renderer/store/storage.ts,async)
       └─ window.whale.persistRead / persistWrite
            └─ ipcRenderer.invoke('persist:read' / 'write')
                 ↓
main
  └─ persistRead / persistWrite (async fs)
       ├─ persistDir() lazy   ← app.getPath('userData') 首次解析
       ├─ fsp.readFile / fsp.writeFile(.tmp) + fsp.rename(原子)
       └─ console.error on failure
```

**日志策略**(`persist-storage.ts`):每次 read/write **不**打 `console.log`(每次 state 变更 + 关机 flush 都跑,会显著拖慢主进程同步 IO);真实 IO 失败的 catch 分支保留 `console.error`(`eslint:recommended` 默认允许,且符合 plan.md §A「错误必须上抛」)。**删除(purge)失败必须上抛**:`persistDelete` 只把 `ENOENT` 当"已不存在"并正常返回,其余错误(EPERM / EBUSY / EIO)记录后**重新抛出** —— 否则 redux-persist 会以为 purge 成功,旧状态在下次启动时复活。详见 [docs/15-perf-audit.md](./15-perf-audit.md) P1-2。

**白名单**(`configureStore.ts`):`locations` / `settings` / `taglibrary` / `workflow` / `recent` / `savedsearches` / `extensions`。`extensions` 走 `createTransform` 只持久化 `userDefaults` + `enabledOverrides`,运行时 `registry` 重新加载。

**Flush 流程**:window `close` → `event.preventDefault()` → renderer 发 `app:request-flush` → `persistor.flush()` 排空 → main 收到 `app:flush-complete` → `mainWindow.destroy()`。3 秒内没收到触发 `closeFallback` `setTimeout` 强 destroy。

**`autoMergeLevel1` reconciler 行为**:每个 slice key 单独处理 —— `originalState[key] !== reducedState[key]` 时**跳过该 slice 的 rehydration**。所以 sanitize / migrate 这类函数必须**逐键比较,真改了才替换 `base`**;否则 reconciler 看到引用变化 → 整个 slice 落回默认(典型症状:`themeMode` / `viewDepth` 关闭重启后回到默认值)。

## 9. 已知坑(本模块反复踩过)

完整列表见 [docs/09-known-issues.md](./09-known-issues.md);本模块重点:

- `electron .` 直启时 `app.getName()` 退化为 `"Electron"` → userData 落到 `AppData/Roaming/Electron/`,与打包应用两套入口。修:`pinUserDataToProductName()` 在 `whenReady` 之前 pin 到 `WhaleTag`
- atomic-write 缺 fsync/datasync 可能在掉电时丢数据 → 必须 `fd.datasync()`
- `assertWithinAllowedRoot` symlink 逃逸 → 必须 `realpathSync` 解析
- redux-persist settings slice 被 skip rehydration → 关闭重启回默认值 → 根因是 `sanitizeKeybindings` 这类总返回新对象,要看 `autoMergeLevel1` 行为
- Windows `explorer /select,path` 用 `child_process.execFile` 加引号会被 comma 拆分 → 改 `shell.showItemInFolder`

## 10. 架构审阅遗留(2026-07-18)

- ~~persist 全链路同步阻塞~~ **已修(2026-07-18)**,细节见 §8。**未加 debounce/throttle**:写量与改前相同(每变更整包重写),只是不再阻塞双线程 —— "每写必落盘"优先于写放大优化。
- **`fs:readTextFile` 主线程解码**:整文件 jschardet + iconv + 两遍 U+FFFD 计数都在主事件循环,大 legacy 编码文件长占。
- `dir-lock.ts` 路径别名可能绕开同目录锁 → key 统一 `path.resolve` + `foldPath`;已 settled 的链尾会自删,Map 只保留仍有活跃任务的 key。
