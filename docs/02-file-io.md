← 返回 [plan.md](../plan.md)

# 02. 文件浏览与 IO

> 位置管理、目录浏览、文件操作(重命名 / 移动 / 复制 / 删除 / 新建 / 打开)、回收站、redux-persist 主进程同步 IO、allowedRoots 写保护、原子写。

## 1. 位置管理

- **本地文件夹位置**(本地路径,CRUD:`createLocation` / `updateLocation` / `deleteLocation`)
- **切换最近**:LRU(`reducers/recent.ts`),前进 / 后退栈
- **只读位置**:`isReadOnly: true` 时**写路径根本不在 `allowedRoots` 里**(`assertWithinAllowedRoot` 早 throw)+ UI 写按钮 disabled + 提示

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
| 新建 | `createTextFile` / `createDirectory` —— **不覆盖已有**(不可变偏好) |
| 打开 | 优先内置扩展(dispatch 选 `selectExtension`);无匹配走 `shell.openPath` |

**写路径必须经过 `assertWithinAllowedRoot`**(见 §6),保证只能修改已注册位置。

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
- **只读位置**(`isReadOnly=true`)在 setAllowedRoots 时不传入此 root → 对应写 IPC 早 throw → UI 写按钮自然 disabled

**renderer 侧 await helper**(`src/renderer/services/allowed-roots.ts`):

`setAllowedRoots` 走 `ipcRenderer.invoke` 是异步的,而 React 子 → 父的 effect 顺序会让子组件在父 `setAllowedRoots` 之前先发出写 IPC(`index:build` / `tagLibrary:read`),被 fail-closed 拒绝后 effect 不重跑(典型表现:TaskReminder 启动警告 + 永不再弹)。

为对齐"何时发写 IPC"和"何时根目录到位",提供两个 module-scope helper:

- `setAllowedRootsAndWait(roots)` — `Root.tsx` 用它替代裸的 `ipcApi.setAllowedRoots`,记下 in-flight promise
- `waitForAllowedRoots()` — 子组件在发写 IPC 前 `await` 它(没注册时直接 resolve)

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

- 写文件前先清理目标目录下 `<basename>.*.tmp` 残留(崩溃遗留)
- 用于 sidecar、索引迁移标志、redux-persist 写盘

## 8. redux-persist(主进程同步 IO)

**位置**:`%APPDATA%/WhaleTag/persist/whale-root.json`。redux-persist 的 root key = `whale-root`(在 `src/renderer/store/configureStore.ts:33`),文件名由 `persistDir() + sanitize(key) + '.json'` 拼出(`persist-storage.ts:47-52`),特殊字符替换为 `_`,本 key 无需替换。

**为什么不走 localStorage**:Chromium 异步 flush;OS 强杀 / 3s close-fallback 会丢最后几毫秒的写。主进程同步 IO(`writeFileSync(.tmp) + renameSync`)保证 `setItem` 返回时字节已落盘。

**架构**:

```
renderer
  └─ storage.getItem/setItem (src/renderer/store/storage.ts)
       └─ window.whale.persistReadSync / persistWriteSync
            └─ ipcRenderer.sendSync('persist:readSync' / 'writeSync')
                 ↓
main
  └─ persistRead / persistWrite
       ├─ persistDir() lazy   ← app.getPath('userData') 首次解析
       ├─ readFileSync / writeFileSync(atomic .tmp + renameSync)
       └─ console.error on failure
```

**白名单**(`configureStore.ts`):`locations` / `settings` / `taglibrary` / `workflow` / `recent` / `savedsearches` / `extensions` / `ai`。`extensions` 走 `createTransform` 只持久化 `userDefaults` + `enabledOverrides`,运行时 `registry` 重新加载。

**Flush 流程**:window `close` → `event.preventDefault()` → renderer 发 `app:request-flush` → `persistor.flush()` 排空 → main 收到 `app:flush-complete` → `mainWindow.destroy()`。3 秒内没收到触发 `closeFallback` `setTimeout` 强 destroy。

**`autoMergeLevel1` reconciler 行为**:每个 slice key 单独处理 —— `originalState[key] !== reducedState[key]` 时**跳过该 slice 的 rehydration**。所以 sanitize / migrate 这类函数必须**逐键比较,真改了才替换 `base`**;否则 reconciler 看到引用变化 → 整个 slice 落回默认(典型症状:`themeMode` / `viewDepth` 关闭重启后回到默认值)。

## 9. 已知坑(本模块反复踩过)

完整列表见 [docs/09-known-issues.md](./09-known-issues.md);本模块重点:

- `electron .` 直启时 `app.getName()` 退化为 `"Electron"` → userData 落到 `AppData/Roaming/Electron/`,与打包应用两套入口。修:`pinUserDataToProductName()` 在 `whenReady` 之前 pin 到 `WhaleTag`
- atomic-write 缺 fsync/datasync 可能在掉电时丢数据 → 必须 `fd.datasync()`
- `assertWithinAllowedRoot` symlink 逃逸 → 必须 `realpathSync` 解析
- redux-persist settings slice 被 skip rehydration → 关闭重启回默认值 → 根因是 `sanitizeKeybindings` 这类总返回新对象,要看 `autoMergeLevel1` 行为
- Windows `explorer /select,path` 用 `child_process.execFile` 加引号会被 comma 拆分 → 改 `shell.showItemInFolder`
