
← 返回 [plan.md](../plan.md)

# 19 · 代码质量审计与改进清单

> **2026-07-28** 的代码质量审计追踪清单(plan.md §F「不做未来计划」的**经确认例外**,同 [docs/15](./15-perf-audit.md) / [docs/16](./16-cross-platform.md))。每项完成后压成 1–2 行 ✅(保留「做了什么 + 关键坑」);评估**不做**的移到文末「已接受的取舍」。
>
> **审计方法**:6 维度并行静态扫描 —— ① 已知问题汇总(避免重复 docs/09/15/16)② 代码异味 ③ 类型安全 ④ 测试覆盖缺口 ⑤ 错误处理/异步 ⑥ 当前 working tree diff 审查。代码内生产路径几乎无 `TODO/FIXME/HACK` 标记,发现均来自代码本身与既有约定之间的落差。
>
> **范围与边界**:本篇聚焦**正确性 bug + 测试缺口 + 类型/可维护性**;**不重复** [docs/09](./09-known-issues.md)(已知坑主档)、[docs/13](./13-security.md)(安全模型/不在范围)、[docs/15](./15-perf-audit.md)(性能)、[docs/16](./16-cross-platform.md)(跨平台)。审计基线为 2026-07-28 的 working tree(含未提交的 md-editor / AI 改动),相关项已标注。

---

## 🔴 P0 — 真实正确性 bug(建议优先修)

### P0-1. redux-persist 落盘跳过 `datasync` ✅
[persist-storage.ts:80-81](../src/main/persist-storage.ts#L80-L81) 用 `fsp.writeFile(tmp) + fsp.rename`,**未 `fd.datasync()`**,也没用 [atomic-write.ts](../src/main/atomic-write.ts) 的 `pid+counter` 唯一 tmp 名。而 atomic-write.ts:57-60 自己的注释明确警告「Without it, a crash after rename could expose a partially-flushed temp」—— 这正是 [docs/02 §redux-persist](./02-file-io.md) 与 plan.md §E.6「`writeFileSync(.tmp)+renameSync`」反复强调的故障类。同仓 sidecar/index/thumbnail 都走 `atomicWriteJson/Bytes`,唯独这条**最敏感的 settings 写**手写半成品。**✅ 已修(2026-07-28)**:[persist-storage.ts](../src/main/persist-storage.ts) `persistWrite` 改调共享 `atomicWriteText` —— 复用 sidecar/index/thumbnail 同款 `datasync` + pid+counter 唯一 tmp(顺手删 dead `tmpPathForKey`、文件头注释更新为 atomic+durable)。

### P0-2. `computeOrphanImages` 路径未做大小写归一 → Windows/macOS 误删已引用图片 ✅
[md-render.ts:1016-1025](../src/extensions/md-editor/md-render.ts#L1016-L1025)(**working tree 未提交**)只做 `\`→`/` 斜杠归一,注释也只提斜杠。`resolveRelativeImagePath` 输出按 md 源 casing,`listDirectory` 返回磁盘 casing;大小写不敏感 FS 上 md 写 `./Assets/x.png` 而磁盘是 `assets/x.png` 时会被判为孤儿。配合 `deleteToTrash=false` = **永久删除已引用图片(数据丢失)**。**✅ 已修(2026-07-28)**:[md-render.ts](../src/extensions/md-editor/md-render.ts) `computeOrphanImages` 的 `norm` 改为 `\`→'/' + toLowerCase`;补回归测试 `case-insensitive match (Win/macOS default FS)`(`Assets/x.png` 磁盘 vs `assets/x.png` 引用)。

### P0-3. AI `maxTurns` clamp 错位 + 两处 `buildSnapshot` 重复 ✅
**working tree 未提交**。新导出的 [clampMaxTurns](../src/renderer/components/ai/buildSnapshot.ts)(clamp [1,1000],NaN→200)只被 `buildAiSnapshot` 调用,而 `buildAiSnapshot` 仅服务于 `InlineEditModal` —— [inlineEdit.ts:123](../src/main/ai/inlineEdit.ts#L123) 硬编码 `maxTurns:1`,**根本不读 snapshot.maxTurns**。真正消费的是聊天路径 [buildClaudeOptions](../src/main/ai/providers/claude/buildQueryOptions.ts) 读 `settings.maxTurns`,它走 [useAiStream.ts](../src/renderer/components/ai/useAiStream.ts) 里那份**本地** `buildSnapshot`,裸传 `s.aiMaxTurns`、**无 clamp / 无 NaN 兜底**。store 被外部改成 NaN/0/负数时(`Math.max(1, Number(x)||200)` 只挡 UI 输入,不挡直改 store / 旧数据)`query()` 会报错。**✅ 已修(2026-07-28)**:[useAiStream.ts](../src/renderer/components/ai/useAiStream.ts) 删本地 `buildSnapshot`,三处调用(title-gen / prewarm / send)改用共享 `buildAiSnapshot` → `maxTurns` 走 `clampMaxTurns`;[buildQueryOptions.ts:139](../src/main/ai/providers/claude/buildQueryOptions.ts#L139) 读 `snapshot.maxTurns` 自动拿到 clamped 值。

---

## 🟠 P1 — 安全 / 数据模块零测试(回归保险)

审计时整个 `src/main/ipc`(11 个源文件)**仅 1 个**有测试;下列各项现已补齐测试或确认已有覆盖(初次扫描对 P1-2/P1-3 「无测试」的判断有误,实为已有)。

### P1-1. `fs-write.ts` — 数据丢失 + 路径遍历 ✅
[fs-write.ts](../src/main/ipc/fs-write.ts)(439 行)。文件头声明「失败必 reject,绝不让 renderer 把失败的 IO 当成功」—— 现用 [ipc.test.ts](../src/main/ipc.test.ts) 的 IPC rig 覆盖**写侧**:fs:rename 的源/目标越界拒绝、目标已存在不静默覆盖、源缺失时 IO 失败必 reject(不假成功)、fs:mkdir 越界+正常、fs:delete 越界。读侧越界早已在同文件 `read-side allowedRoots guards` 覆盖;`assertWithinAllowedRoot` 本身在 [allowed-roots.test.ts](../src/main/allowed-roots.test.ts)。

### P1-2. `ipc/extensions.ts` — 归档 Zip Slip + 转换器 spawn ✅(已有覆盖)
[extensions.ts](../src/main/ipc/extensions.ts)(439 行)只是 `ipcMain.handle` 薄转发到 [archive.ts](../src/main/archive.ts) 的 `listArchive/readArchiveEntry/extractArchive`,而 **Zip Slip 防线(`isSafeEntryPath` 含 `..` 深度检查)已在 [archive.test.ts](../src/main/archive.test.ts) 覆盖**:`../evil.txt`(ZIP)、`../../escape.txt`(TAR)均断言被 skip 且不落盘到 dest 之外。转换器 spawn 路径经 `assertWithinAllowedRoot`(已覆盖)。

### P1-3. `migrate-date-tags.ts` — 一次性全库迁移 ✅(已有覆盖)
[migrate-date-tags.ts](../src/main/migrate-date-tags.ts)(368 行)已有 [migrate-date-tags.test.ts](../src/main/migrate-date-tags.test.ts) 充分覆盖:纯函数变换(7 prefix 全集 / 互斥折叠 / period / 跨家族 / null 防御)、`runMigration` 集成(`.bak-dateprefix` 备份创建、二次运行幂等不重写不重备份、wsm.json 同形、损坏 JSON 优雅报 error 不覆写、空 roots)、`triggerStartupMigration` once-guard。**遗留(低优先级)**:`.catch(()=>null)`([:294-303](../src/main/migrate-date-tags.ts#L294-L303))外层吞非内层-catch 的抛出 —— 现有 corrupt-JSON 用例覆盖了主路径,但「外层吞 withLock/atomicWrite 抛出致 totalErrors 不增」的 edge 仍未直接断言。

### P1-4. `dir-lock.ts` — 并发互斥锁 ✅
[dir-lock.ts](../src/main/dir-lock.ts)(51 行)。新建 [dir-lock.test.ts](../src/main/dir-lock.test.ts) 覆盖:同 key 串行(并发高水位 = 1)、不同 key 并行、**拒绝隔离**(reject 任务不污染后续队列 —— 核心不变性)、返回值/拒绝传播、50 任务长链保序、drain 后再 lock 仍工作。chains Map 的内存有界是内部不变性(未 export,行为测试覆盖不到,功能正确性已覆盖)。

### P1-5. `shell-quote.test.ts` — 注入唯一防线 ✅
[shell-quote.test.ts](../src/main/shell-quote.test.ts) 已扩展「adversarial inputs」describe:POSIX 下分号/与号/管道/$/反引号/圆括号/重定向等元字符在单引号内原样、CJK 路径、换行与控制符、NUL 字节、单引号 close-reopen(中和 `';echo pwned` 注入);Windows 下 `%VAR%`(加引号但 `%` 原样,锁定「真正的 % 防护在上游 runUserCommand」契约)、各元字符触发引号、CJK+空格、换行。

### P1-6. `secretStore.ts` — 加密往返 + 明文不泄露 ✅
[secretStore.ts](../src/main/ai/security/secretStore.ts)(118 行)。新建 [secretStore.test.ts](../src/main/ai/security/secretStore.test.ts):用 require.cache 注入 reversible(非 identity)cipher 的 electron stub,覆盖加密往返、**blob 不含明文 canary**、missing secret 返空、空值删除、clearSecret、**stale undecryptable blob 被清理并报 unset**。真实加密强度由 Electron/OS-keychain 保证,本测试锁定「经 encrypt/decrypt 才存、绝不存明文」契约。

---

## 🟡 P2 — 一次性消除 ~30 处生产 `any`(低成本高收益)

类型逃逸高度集中在**渲染层 ECharts 回调**(`params: any` / `node: any`)。定义一个共享 ECharts param 类型或直接从 `echarts` 导入 `CallbackDataParams`:

### P2-1. ECharts 回调集群 ✅
- [FolderVizView.tsx](../src/renderer/components/FolderVizView.tsx)(11 处:`:259,296,316,321,334,336,348,437,465,514,549`)
- [TagCloudView.tsx](../src/renderer/components/TagCloudView.tsx)(7 处:`:317,336,366,470,474,493,498`)
- [folderviz.ts](../src/renderer/domain/folderviz.ts)(6 处:3 个 `): any` 返回 + 3 个 `result: any`,三函数 `toEChartsTree/Treemap/Sunburst` 结构相同 → 抽一个 `EChartsTreeNode` 接口)
- [CalendarView.tsx](../src/renderer/components/CalendarView.tsx)(2 处:`:1487,1514`,`(echarts as any).graphic` 应改 `echarts/core` 静态导入)

**✅ 已修(2026-07-28)**:[folderviz.ts](../src/renderer/domain/folderviz.ts) 定义 `EChartsFolderVizNode`(path/isDirectory/fileCount/itemStyle/label/collapsed/children),三个 `toECharts*` 返回它 + 透传 fileCount;[FolderVizView.tsx](../src/renderer/components/FolderVizView.tsx) node/data 走该类型、formatter/handler 走本地 `FolderVizChartParam`,顺带修 `echartsData.size`→`value`(类型化暴露的原 bug:rootSize 在 any 下拿不到值);[TagCloudView.tsx](../src/renderer/components/TagCloudView.tsx) wordCloud + heatmap 两套 param 类型;[CalendarView.tsx](../src/renderer/components/CalendarView.tsx) formatter union + `echarts.graphic.LinearGradient`(echarts/core 已注册 GraphicComponent,去 `as any`)。共 ~26 处生产 `any` 消除,type-check 通过。

### P2-2. `DirectoryTree.tsx` 节点类型逃逸 ✅
[DirectoryTree.tsx:101-106](../src/renderer/components/DirectoryTree.tsx#L101-L106) `nodes: any` / `renderFolder: (n: any)` / `renderFile: (n: any)`(带 3 个 eslint-disable)。**✅ 已修(2026-07-28)**:定义 `TreeFolderNode`/`TreeFileNode`/`TreeNode` 判别联合(原注「已有 DirectoryTreeNode 类型」不准),TreeRow 的 nodes/renderFolder/renderFile 全类型化、去 3 个 eslint-disable,`node.kind` discriminant 自动 narrow。`:679` 的 `as any` **保留**(react-window v2 的 `rowProps` 类型 `ExcludeForbiddenKeys` 反向要求 index/style,是库类型限制,加注释标注)。

### P2-3. 主进程复制粘贴的 `as unknown as` ⏸️(评估后保留)
[archive.ts:459](../src/main/archive.ts#L459) 与 [thumbnail.ts:174](../src/main/thumbnail.ts#L174) 的 `stdout as unknown as Buffer`;[index-worker-host.ts:133](../src/main/index-worker-host.ts#L133) 与 [thumb-worker-host.ts:126](../src/main/thumb-worker-host.ts#L126) 的 `.on('error')` 断言。**评估(2026-07-28)后保留**:`execFileBuffer` 抽 helper 要求 archive + thumbnail 都改,但 thumbnail 的 ffmpeg 提取带 ~1s/0 fallback 重试逻辑,抽 helper 需重构该路径,风险 > 收益(archive 单独抽不消除复制粘贴);`onUtilityProcessError` 仅消除 2 处 cast + 重复注释却需新建文件 + 2 处 import,ROI 低。这 4 处 `as unknown as` 全有注释、范围窄、不暴露不可信输入(`src/main` 生产代码零 `: any`),保留现状可接受。

> **无需动**:`src/shared`(零逃逸)、`src/main/ipc`、`src/main/allowed-roots.ts`、`src/main/ai/security/*`、`src/main/shell-quote.ts` 类型均严密;`src/main` 8 处 `as unknown as` 全有注释、范围窄、不暴露不可信输入。全仓零 `@ts-ignore` / `@ts-nocheck`。

---

## 🟡 P3 — 重复模板 & 超大组件(可维护性)

### P3-1. localStorage 读写模板各写一份
[perspective-prefs.ts:70-90](../src/renderer/domain/perspective-prefs.ts#L70-L90) 已有 `readPrefs/writePrefs`(try/catch、永不抛),但 [FolderVizView.tsx:80-115](../src/renderer/components/FolderVizView.tsx#L80-L115)、3 个 gantt hooks(`useGanttRange:58` / `useGanttZoom:26` / `useGanttTagFilter:73`)、[TaskView.tsx:25](../src/renderer/components/TaskView.tsx#L25)、[BackgroundPlayerContextProvider.tsx:77,108](../src/renderer/hooks/BackgroundPlayerContextProvider.tsx#L77-L108) 都各写一份等价 `try{JSON.parse(localStorage.getItem(k))}catch{}`。迁移到现成 helper。

### P3-2. `clampFontSize` 双胞胎
[text-editor/editor-stats.ts:255-293](../src/extensions/text-editor/editor-stats.ts#L255-L293) 与 [md-editor/md-context.ts:28-53](../src/extensions/md-editor/md-context.ts#L28-L53) 几乎逐字相同(`clampFontSize` + `FONT_SIZE_KEY` + getter/setter),下游 CodeMirror theme CSS(`text-editor/index.ts:345-346` 与 `md-editor/md-theme.ts:60-61`)也重复。抽到 `extensions/shared/editor-prefs.ts`。

### P3-3. 超大组件拆分
- [FileList.tsx:170](../src/renderer/components/FileList.tsx#L170) —— **单文件 1800 行单组件**,优先级最高。
- [md-render.ts](../src/extensions/md-editor/md-render.ts)(2517 行,markdown 渲染管线)、[ebook-viewer/index.ts](../src/extensions/ebook-viewer/index.ts)(1751 行)按域拆。
- [SettingsDialog.tsx](../src/renderer/components/SettingsDialog.tsx)(2200 行)已有天然 section 边界(`AiSection` / `FulltextSection` / `GeneralSection` 等),机械拆分成本低。

### P3-4. extension viewer `getPref/setPref` 拷贝
[font-viewer/index.ts:387-399](../src/extensions/font-viewer/index.ts#L387-L399) 与 [html-viewer/index.ts:224-236](../src/extensions/html-viewer/index.ts#L224-L236) 的 `STORAGE_PREFIX` getPref/setPref 逐字相同 → 抽 `extensions/shared/viewer-prefs.ts`。

### P3-5. `drawio-editor` iframe 销毁 TODO
[drawio-editor/app.tsx:107](../src/extensions/drawio-editor/app.tsx#L107) 是全仓**唯一**真正标记的未完成功能(`TODO: figure out a cleaner teardown`)。生产代码其余无 FIXME/HACK。

---

## ✅ 已记录在 docs、不在本篇重复

以下团队**已知并跟踪**,避免在此重复报告:

| 项 | 出处 |
|---|---|
| 位置级 AES-256-GCM 加密 / 安全审计日志未做;扩展能力「全有或全无」;md-editor CSP `unsafe-inline`(mermaid v11 限制);postMessage `targetOrigin:'*'` 收窄 | [docs/13](./13-security.md) §1/§12/§13、[docs/07 §10](./07-extensions.md)、[docs/09 §18.4.3](./09-known-issues.md) |
| mac 代码签名硬阻塞;Linux DE fallback 链 / 图标 / 递归监听;`safeStorage` headless 不可用 | [docs/16](./16-cross-platform.md) B-1 / C-2~C-5 |
| `strictNullChecks` 未开;`dir-lock.ts chains` Map 无界增长;`readSidecars` 每目录重读;`extractPdfText` 整 PDF 读内存;`loadFolderThumbnail` 无 LRU | [docs/09 §30](./09-known-issues.md)、[docs/02 §10](./02-file-io.md)、[docs/15](./15-perf-audit.md) P2-1/P3-5 |
| AI MCP / FileToolbar 未做 v1;macOS notarization 阻塞自动更新 | [docs/11](./11-ai.md) §7/§13、[docs/18](./18-auto-update.md) |
| Mapique 地名搜索已尝试并回退(勿照原样重试) | [docs/05 §10](./05-perspectives.md) |

---

## 已接受的取舍

(暂无。若后续评估某项**不做**,在此登记理由 + 指向相关 docs,而非留在主体。)
