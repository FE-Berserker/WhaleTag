← 返回 [plan.md](../plan.md)

# Whale 前端功能核对清单

> **手动核对清单** — 逐项核对每个功能是否正常工作。
> 用法:把 `- [ ]` 改成 `- [x]` 逐项过一遍。
> 文档反映**当前代码**,不复述历史;每节指向对应模块文档的细节。
> 核对时发现描述与实际代码不符 → 直接修代码 + 修文档,不要在不通过的状态下打勾。

---

## 核对进度总览

| # | 模块 | 进度 |
|---|---|---|
| 一 | 视角系统 | ___ |
| 二 | 扩展系统 | ___ |
| 三 | 文件浏览与 IO | ___ |
| 四 | 标签系统 | ___ |
| 五 | 搜索与索引 | ___ |
| 六 | 缩略图管线 | ___ |
| 七 | UI 主题与外观 | ___ |
| 八 | AI 助手 | ___ |
| 九 | 设置面板 / 数据层 | ___ |

---

## 一、视角系统 (Perspectives)

### 通用核对项(所有视角共有)

- [ ] 9 类视角在顶部 view toggle 工具栏全部出现(`grid`/`list`/`gallery`/`task`/`calendar`/`mapique`/`folderviz`/`tagcloud`/`knowledge-graph`)
- [ ] 视角类型 + 卡片尺寸按文件夹持久化到 `.whale/wsm.json`,重开同一文件夹恢复
- [ ] 全局默认视角写入 settings,reload 应用后保持
- [ ] 视角切换与当前激活标签联动
- [ ] 工具栏深度 Slider(1–5)对所有视角可见,200ms 防抖后所有视图的条目随深度更新

### 网格 / 列表视图 (Grid / List)

- [ ] Grid 卡片按 `entrySize` 排列
- [ ] List 行密度三档(compact 32 / normal 56 / comfortable 72px)
- [ ] 列头 4 列(name / size / modified 可排序,tags 不可点)
- [ ] 列宽可拖(list,6px 隐形热区;clamp name 120–600 / size 48–128 / modified 64–200)
- [ ] 列头右键弹列显隐 toggle 菜单
- [ ] 列宽 + 列显隐持久化
- [ ] F2 在焦点行触发内联重命名
- [ ] 键盘导航:↑↓ Shift+↑↓ Home/End Enter Space Esc Del
- [ ] 输入框内按 ↑↓ 不触发列表导航
- [ ] 行内 tag chip 第 5 个起改为 `+N` chip
- [ ] 斑马纹开关 + 相对时间开关(工具栏 IconButton)
- [ ] 多选右键 tag chip 出现"从 N 个文件移除 X" + "Invert selection"
- [ ] 右键单文件 "在资源管理器中显示" 高亮并选中
- [ ] 右键单文件 / 单文件夹菜单内嵌 InlineTagInput

### 画廊视图 (Gallery)

- [ ] Gallery 仅显示 image / video,等高网格
- [ ] 双击图片弹 lightbox,Esc 关闭
- [ ] 大视频(mp4)秒开、可拖进度(206 Partial Content)
- [ ] tray 开合 / 窗口缩放,Gallery 列数实时重排
- [ ] 快速滚动万图目录无 IPC 风暴(IntersectionObserver + FIFO)
- [ ] 「显示 / 隐藏标签」按钮 + Shift/Ctrl 多选 + 键盘导航
- [ ] lightbox 预加载 ±1,翻 100 张内存稳定
- [ ] 图片 zoom / pan + tile 角标 + filmstrip

### 日历视图 (Calendar)

- [ ] 5 档:month / week / year / agenda / week-timeline / year-heatmap
- [ ] prev/next/today 三按钮 tooltip 按视图动态
- [ ] entry 右键弹 2 个日期领域动作
- [ ] day cell 右键弹「新建文件夹 / 新建文件」并自动打当天标签
- [ ] `auto` 第三档分组(优先 date tag)
- [ ] viewMode + grouping 持久化到 `whale.calendar.<locationId>`
- [ ] Period 横条:带期间标签的 entry 渲染跨日横条,跨周切片
- [ ] Range Filter 5 档 + DatePicker Popover
- [ ] Year heatmap + Week timeline
- [ ] 工具栏保存 / 另存为 / 复制为 PNG
- [ ] 设置 → 通用「显示农历」开关(zh 门控)

### 看板视图 (Kanban)

- [ ] 横向滚动,阶段列按 WorkflowManager 配置,右侧固定「未分类」
- [ ] 卡片缩略图 + 文件名 + tag chips(最多 4 个 + +N)
- [ ] 拖拽换列写互斥 stage 标签
- [ ] 多选拖拽:所有已选中项一起移动
- [ ] KanbanEntryMenu:移动阶段 / 优先级 / 期间 / 编辑标签 / 打开 / 删除
- [ ] 列头右键:新建文件夹/文件 + 管理阶段
- [ ] 只读位置拖拽禁用 + 菜单项 disabled
- [ ] 卡片键盘:Enter / Space / Delete(只读时不响应 Delete)

### 矩阵视图 (Matrix)

- [ ] 2×2 紧急×重要 + 底部未分类托盘
- [ ] 拖卡换象限写互斥 quadrant 标签
- [ ] MatrixEntryMenu(同 KanbanEntryMenu 三段式)
- [ ] 象限空白背景右键弹「新建文件夹 / 新建文件」并自动打该象限标签
- [ ] 只读位置写菜单项 disabled

### Gantt 视图

- [ ] Task 第三档子视图 ToggleButton 三选一(默认 kanban)
- [ ] **纯 DOM 横向滚动时间轴**(`GanttTimeline` 子组件,无 ECharts 无 dataZoom)
- [ ] Day/Week/Month zoom 是工具栏 `Select`(`useGanttZoom`,localStorage `whale-task-gantt-zoom`)
- [ ] 快捷区间 1w/2w/1m/1q 是工具栏 `ToggleButtonGroup`(`useGanttRange`,localStorage `whale-task-gantt-range`)
- [ ] 拖拽改时间:整体平移 + 左右边缘 resize(`useBarDrag`)
- [ ] Triage drop = `onRemoveEntryDateTag(entry)`
- [ ] 数据源 = period 标签,无新元数据
- [ ] 子视图持久化到 localStorage `whale-task-subview`(非 per-folder)
- [ ] 只读位置工具条 disabled + canDrop=false + Triage 锁图标

### 地图视图 (Mapique)

- [ ] 左侧 Leaflet 地图 + 右侧详情面板布局
- [ ] `geo:` 标签 markercluster 聚合 + marker 右键 5 项领域操作
- [ ] 复制坐标写入剪贴板 + notice
- [ ] 托盘三档过滤 + react-window 虚拟滚动 + 键盘导航
- [ ] per-location 偏好持久化(`whale.mapique.<locationId>`)
- [ ] **添加/清除标签只原地更新 marker,整张 Leaflet 地图不重建** (forceRender 不重挂)

### 目录可视化 (FolderViz)

- [ ] 4 图:tree / radial / treemap / sunburst
- [ ] 深度来自全局 `viewDepth`,FolderViz 自带滑块已删
- [ ] vizType 持久化到 `whale.folderViz.<locationId>`(只保 vizType)
- [ ] 故意把 settings 的 `viewDepth` 改成 99,reload 后 fallback 到 **1**(非 3)
- [ ] 节点右键(目录):进入 / 在资源管理器中打开 / 设文件夹缩略图
- [ ] 工具栏搜索框,非匹配节点 opacity 0.2

### 标签云 (TagCloud)

- [ ] 标签按文件数 sqrt 字号
- [ ] 分类筛选 ToggleButton 含 geo 类别
- [ ] geo 标签渲染为 emoji `📍 36.1,117.8`
- [ ] 日期 smart-tag 显示本地化
- [ ] dark theme AA 对比度足够
- [ ] 字号随容器尺寸自适应
- [ ] LoadingOverlay / EmptyHint / ErrorBanner 共享三件套(同 Mapique / KG)

### 知识图谱 (KnowledgeGraph)

- [ ] React Flow v12 标签↔文件二部图,放射状确定性布局
- [ ] 节点不互相遮挡
- [ ] 张力滑块已移除
- [ ] Fit 按钮回到画框
- [ ] LoadingOverlay / EmptyHint / ErrorBanner 共享三件套
- [ ] 暗色模式无白框(Controls / MiniMap / Background)
- [ ] 切主题即时生效
- [ ] 旧 `ViewMode = 'mindmap'` 自动 migrate 到 `'knowledge-graph'`
- [ ] `'kanban' / 'matrix'` 自动 migrate 到 `'task'`

---

## 二、扩展系统 (Extensions)

### 通用

- [ ] 双击文本/代码/图片/PDF/媒体/Office/电子书/图表/压缩包/CAD 文件,在 Whale 面板内打开对应扩展
- [ ] 双击无匹配扩展的文件回退 `shell.openPath`
- [ ] 右键「Open With...」子菜单
- [ ] Settings → Extensions 可设置用户默认扩展
- [ ] 编辑器修改后脏标记 + Save 触发 `.whale/revisions/` 备份
- [ ] 启动清理 30 天前旧 revision
- [ ] 切 en↔zh 扩展工具栏文案实时更新
- [ ] dark 主题首帧无白闪
- [ ] 双层 iframe 拓扑(drawio / excalidraw)加载无 CSP 拦截

### json-viewer / html-viewer

各查看器底部状态栏、搜索、源码切换、theme 闪烁修复、大文件保护等共性项。

### text-editor / md-editor

CodeMirror 6,查找/替换、字体缩放、Wrap、代码折叠、状态栏、`requestSelection`/`applyReplacement` AI 编辑桥。

- [ ] md-editor 编辑区右键:Undo/Cut/Copy/Paste/Select All、Bold/Italic/Link/Heading 子菜单、Insert Callout/Table、Find/Go to Line、Wrap/Zoom、Export as HTML 齐全且生效,动作后菜单关闭
- [ ] md-editor 只读文件右键:编辑类项(Cut/Paste/Bold/Italic/Link/Heading/Insert)全禁用,Copy/Select All/Find/Export 可用;空选区时 Cut/Copy 禁用
- [ ] md-editor 预览区右键:Copy 复制选中文本 + Export as HTML;Esc / 点击外侧关闭菜单

### image-viewer / heic-viewer

image-viewer 11 种格式,jpg/jpeg/png/gif/webp/bmp/avif/tiff/tif/ico/svg;Lightbox + zoom/pan/rotate/flipH/flipV;`F` 全屏。heic-viewer libheif-js wasm 解码。

### pdf-viewer / media-player / office-viewer / ebook-viewer

- pdf-viewer:**iframe 内 pdfjs 浏览器版**(CJK 字体自动回退)+ fake worker + `HostBinaryDataFactory` + wasm 经 host IPC
- media-player:10 视频 + 16 音频;视频/原生音频用 `whale-file://` 流式 URL(206 Range);APE/WMA/AIFF/AMR/AC3/DTS/MPC/WV/DSF 走 `whale-audio://` 实时 ffmpeg→Opus 流式(首播 ~1s 出声,边转边播,tee 写 `.whale/transcodes/` 缓存,再开秒开 + 可拖动);`.opus` MIME `audio/opus`
- office-viewer:`requestOfficeConvert` → 主进程 soffice 转 PDF → `officePdfContent` 推回 → iframe 内 pdfjs 浏览器版渲染到 `<canvas>`(与 pdf-viewer 共用 `src/extensions/shared/pdfjs-in-iframe.ts` 抽象);支持 `doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp` 9 种;**PDF 已缓存到 `.whale/transcodes/<basename>.pdf`**(仿 audio-convert cache);soffice 加 `--norestore --nologo --nofirststartwizard` + stderr 捕获;启动用 `detectInitialTheme()`;仅手动 +/- 缩放,无 fit / 旋转 / 跳页 / 键盘导航;未装 LibreOffice 报 `'LibreOffice (soffice) not found'`,无引导
- ebook-viewer:EPUB/CBZ/FB2 直读,MOBI/AZW/AZW3 经 Calibre 转 EPUB;阅读进度持久化 + 选区高亮 + Ctrl-F

### archive-viewer

支持 9 种:`zip / tar / tgz / tbz2 / txz / gz / bz2 / xz / 7z`,后 8 种经主进程 `7zip-bin` 解码。

### excalidraw-editor / drawio-editor

- excalidraw-editor:scene restore + dirty + 拖入嵌入
- drawio-editor:双层 iframe + `?proto=json` 结构化协议;`EMPTY_DRAWIO` 单行零空白;`export` action(不是 `autosave`/`save`)bridge 三事件统一映射;Editor `modified` 默认 false,Save 按钮不依赖 dirty

### cad-viewer

- Tier 0:stl/obj/glb/gltf/ply(WebGL)
- Tier 1:dxf(2D/3D 切换 + ACI 颜色)
- Tier 1.5:step/stp/iges/igs/brep(occt-import-js wasm)
- Tier 2:dwg(dwg2dxf / ODA File Converter)

### font-viewer

支持 ttf / otf / woff / woff2;字号滑块 14–96px;`.eot` 不被打开(legacy IE 格式)

---

## 三、文件浏览与 IO

- [ ] 新增本地文件夹位置,保存后出现在位置列表
- [ ] 编辑位置名称 / 路径,保存生效
- [ ] 删除位置(确认后从列表移除)
- [ ] 标记只读的位置:右键 / 工具栏写操作禁用 + 提示
- [ ] 目录树展开/折叠 + 面包屑跳转
- [ ] 大目录滚动流畅(react-window v2)
- [ ] 选中 → 重命名 / 移动(含跨卷 EXDEV 回退)/ 复制 / 删除 / 新建 / 双击打开
- [ ] 删除按 `settings.deleteToTrash` 走系统回收站或永久删除
- [ ] toast 中「打开回收站」按钮直达
- [ ] 写操作对未注册 `allowedRoots` 的路径被拦截 + 提示
- [ ] 行 / 多选 / 空白 / 目录树节点 / 位置条目右键菜单
- [ ] 右键目录树行(文件夹 / `showFiles=true` 时的文件)菜单含「复制路径」+ Snackbar 提示「路径已复制到剪贴板」/ 失败「剪贴板不可用」
- [ ] 右键「在资源管理器中打开」高亮并选中
- [ ] 前 / 后退 + LRU 最近目录
- [ ] 列头全选复选框:三态(unchecked / checked / indeterminate)
- [ ] PropertiesTray:单选显示图标 + 名称 + 类型 + 大小 + mtime + 路径 + 标签 + 描述;多选显示「N 项已选中」+ 共同标签
- [ ] 托盘可折叠 + 拖拽调整宽度 200–600px,持久化
- [ ] 只读位置标签 / 描述 / 重命名禁用,可查看
- [ ] Del 键删除在多视角可用
- [ ] 只读位置 Del 静默忽略
- [ ] input / textarea / contenteditable 内 Delete 保持原生行为

---

## 四、标签系统

### 基础与编辑器

- [ ] 侧栏「标签库」面板可见
- [ ] 标签按标签组分组,组有自己的颜色
- [ ] 点击标签筛选当前文件列表
- [ ] 单文件可在 PropertiesTray 编辑标签(增 / 删 chip)
- [ ] 多选可批量打标,各文件原 description 保留
- [ ] 拖拽打标(从标签库拖到文件 / 选中文件)
- [ ] InlineTagInput:Enter / Space / Blur 提交,Backspace 删最后 chip,点容器空白聚焦
- [ ] geo 标签不出现在文本编辑器中
- [ ] 只读位置 chip 不带 ×,不渲染输入框
- [ ] 旧 `TagEditDialog` 弹窗已不存在
- [ ] TagMetaDialog 可改颜色 + 重命名

### 颜色规则

- [ ] 普通标签 per-tag 颜色生效
- [ ] 组内标签继承组色
- [ ] 工作流 / 象限 / geo 按各自规则
- [ ] `1star`..`5star` 始终金色(`RATING_COLOR`),不被 per-tag / group 覆盖

### TaskReminder

- [ ] 设置开启 + 选监控位置 → 重启弹待办清单
- [ ] 无 pending 文件时不弹
- [ ] dev mode 双挂载 guard 不会失效
- [ ] 待办含监控位置下(含子目录)所有 pending 文件
- [ ] Enter 打开聚焦条目
- [ ] workflow 状态以彩色 chip 展示

### 存储

- [ ] 打标后文件名不被修改(不出现 `name[tag].ext`)
- [ ] 标签写入 `.whale/wsd.json`(目录级聚合)

### Smart Date / Period

- [ ] 7 个 smart date functionality 走紧凑形存储(`20260704` 等),无 `today-` 前缀
- [ ] **`now` 鲜度 = 当前 1 分钟**(不是 5 分钟)
- [ ] 过期日期折叠为 `日期` chip(neutral 灰),不展示具体值
- [ ] 期间标签 `YYYYMMDD-YYYYMMDD` 与日期并存,独立互斥家族,深紫 `#8b5cf6`
- [ ] 标签库"日期组"簇视觉合簇:`smart:` × 7 + `period:` + `date:`
- [ ] `PeriodTagDialog`:`end >= start` 校验(允许单日);`onConfirm(period, start, end)`
- [ ] 拖 `period:` chip 到文件行 / 多选 selection 弹对话框;不应用到日历 DayCell

> `useNow()` hook 当前仅 3 个调用点(FileList / PropertiesTray ×2 / TagMetaContextProvider)。其他 `tagDisplayLabel` 走默认 `now = new Date()`。

---

## 五、搜索与索引

- [ ] SearchBar:输入关键字 + Enter 触发,文件名 + 标签模糊匹配,命中高亮
- [ ] 全文搜索 snippet 形式展示上下文,大目录不爆内存
- [ ] 每个 root 下 `.whale/index.db` 可见
- [ ] 文件 mtime 变后,下次索引更新条目
- [ ] 首次大目录索引时 UI / IPC 不冻结(`INGEST_BATCH=1000` + setImmediate yield)
- [ ] AdvancedSearchDialog:类型 / 扩展名 / 大小 / 日期 / 标签(含 / 排除)/ AND / ANY 组合
- [ ] 保存的搜索可调用 / 管理
- [ ] 文本抽取覆盖纯文本 / Markdown / HTML / 代码 / PDF

---

## 六、缩略图管线

### T1–T5 + T8

- [ ] 视频首帧(ffmpeg `-ss 1`)
- [ ] PDF 首页(pdfjs + napi canvas + sharp)
- [ ] Office 首页(经 LibreOffice 转 PDF + 复用 pdf)
- [ ] 电子书封面(EPUB/CBZ/FB2/MOBI/AZW/AZW3)
- [ ] 字体预览(Aa + pangram + 数字)
- [ ] 文件夹缩略图 / 背景(wst.jpg + wsb.jpg)
- [ ] 失败静默回退 FileTypeIcon

### Excalidraw / Draw.io / CAJ / MIDI

- [ ] `.excalidraw` 不出缩略图,显示品牌图标
- [ ] `.drawio / .dio` 不出缩略图,显示品牌图标
- [ ] `.caj` 双击走 `shell.openPath`,无 Whale 渲染路径
- [ ] `.mid / .midi` 不出缩略图

### FileTypeIcon(39 类)

- [ ] 常见 19 个主类(见 [docs/06-thumbnails.md §5](./06-thumbnails.md))
- [ ] 3D 品牌色细分(`ma/mb/max/skp/c4d/3dm/ztl/zpr/sldprt/sldasm/slddrw` 等)
- [ ] 多段名(`archive.tar.gz`)取最后一段
- [ ] 文件夹图标不被 FileTypeIcon 接管
- [ ] 各固定色在浅色与深色主题都可清晰辨认

### 缓存 / 生命周期

- [ ] 命中缓存无重新生成闪烁
- [ ] delete / rename / move / copy → `.whale/thumbs/<basename>.jpg` 跟随清理
- [ ] 同一文件并发只生成一次(in-flight 去重)
- [ ] 单文件失败不影响其它
- [ ] 扩展名大小写不敏感

### ThumbIcon 加载队列

- [ ] IntersectionObserver + 200px lookahead
- [ ] FIFO 队列 `MAX_CONCURRENT = 4`
- [ ] 快速滚动到底再滚回,"滚过"cell 填上缩略图(IO `observed` 双向同步)

---

## 七、UI 主题与外观

### 11 种主题模式

- [ ] 设置 → 通用可见 **11 个主题模式**(3 个经典 + **8 个策划**)
- [ ] 经典:light / dark / system;system 跟随 OS 实时变化
- [ ] 策划 8 个:`warm-paper` / `midnight-plum` / `frosted-mint` / `deep-ocean` / `dawn-blush` / `forest-ink` / **`soft-amber`** / **`high-contrast`**
- [ ] 退出重启 system 模式不粘在退出时的明暗

### 持久化

- [ ] 选任一主题模式后关闭重启模式被还原(redux-persist)
- [ ] 老用户存量 `themeMode = 'light' / 'dark' / 'system'` 升级后正常显示

### 快捷切换

- [ ] `FileToolbar` 右侧主题循环按钮(`data-testid="theme-quick-toggle"`)
- [ ] 循环顺序:light → dark → system → 8 个策划模式 → 回到 light

### 主题工厂与解析

- [ ] 任意策划深色主题下 UI 不抛对比度错误(说明 `'system'` 未漏流入 `createTheme`)
- [ ] 扩展视图(drawio / excalidraw)在 system + 深色 OS 下按深色渲染
- [ ] canvas 视角配色随主题预设变化

### 配色预设

- [ ] whale 浅 `#0ea5e9`、深 `#818cf8` + zinc 中性色
- [ ] 策划主题深色 primary:`midnight-plum #c084fc`、`deep-ocean #38bdf8`、`forest-ink #34d399`

---

## 八、AI 助手

> 完整 spec 见 [docs/11-ai.md](./11-ai.md)。

### 侧栏与布局

- [ ] 侧栏底栏 AI 切换钮展开 AiPanel(MainLayout 最右栏)
- [ ] AiPanel 开启时 FileList 内层 tray 自动隐去

### 流式输出

- [ ] AiPanel 输入并发送,主进程真实 Claude CLI 流式文本(逐 token)
- [ ] 取消按钮中断当前流式轮次
- [ ] 错误经 `ai:error` 在 UI 显示
- [ ] 消息气泡 markdown 渲染

### 工具与批准

- [ ] ToolCall 折叠卡显示工具名 / 摘要 / 状态 / 输入 / 结果
- [ ] ThinkingBlock 折叠
- [ ] subagent 子消息嵌套在父 ToolCall 卡片
- [ ] 工具调用弹 ApprovalModal
- [ ] `ai:resolveApproval` 正确回传
- [ ] 只读 location 下 Write/Edit/MultiEdit/NotebookEdit/Bash 被自动拒绝
- [ ] plan mode 下 ExitPlanMode 渲染 input.plan 为可读文本

### 输入条

- [ ] ModelPicker 切换 sonnet / opus / haiku
- [ ] PermissionToggle 切换 normal / yolo / plan
- [ ] ContextGauge 显示上下文占用百分比 + token 数 tooltip,≥80% 转黄

### 文件上下文

- [ ] 恰好选中 1 个文件时 ContextChip 显示文件名
- [ ] 回形针开关控制是否作为 current note 附加(默认开)
- [ ] 小文本文件(白名单扩展 + ≤ `MAX_INLINE_BYTES = 50_000`)内容内联

### 多标签 / 历史 / 持久化

- [ ] AiTabs 多标签 + 新建 + 切换
- [ ] 历史 Menu:打开 / 删除
- [ ] 关再开会话与消息正文保留(redux-persist,**上限 50**,按 `updatedAt` 驱逐最旧已关闭)
- [ ] 本地兜底标题:首条用户消息前 40 字;AI 生成标题(HTTP only)上限 60 字符

### API Key

- [ ] 设置页能设 / 清除 key,显示已设 / 未设状态(**不回显明文**)
- [ ] safeStorage 不可用时拒绝存储

### HTTP provider

- [ ] provider 选择 Claude / Ollama / OpenAI(两个共享同一 HTTP runtime)
- [ ] Ollama / OpenAI endpoint URL 可配
- [ ] OpenAI key 设置 / 清除(`ai:setOpenaiKey` / `ai:clearOpenaiKey` / `ai:hasOpenaiKey`)
- [ ] HTTP 工具系统默认开(`aiHttpTools`);关则纯聊天

### Claude CLI

- [ ] 「发现」按钮 + 手动覆盖 CLI 路径

### MCP UI(Claude only)

- [ ] 列表启用开关 + 删除 + 新增表单(name / transport / command+args+env / url)

### warm query

- [ ] 面板打开 / 切会话触发预热,首轮响应明显快于冷启动
- [ ] model / effort / permission 改动后热进程被丢弃

### inline-edit

- [ ] "✨ AI 编辑选中"按钮(text/md 编辑器 + HTTP provider + 非只读)
- [ ] InlineEditModal → AI 改写 → 回写选区

---

## 九、设置面板 / 架构 / 数据层

### 设置面板(8 个分类)

- [ ] 左侧分类导航:`general` / `view` / `keyboard` / `mapique` / `tags` / `notifications` / `ai` / `advanced`
- [ ] `WorkflowManagerDialog` 从 Settings → Tags & Workflow 进入

### 通用 General

- [ ] 设置项修改后 redux-persist 跨会话生效

### 视图 View

- [ ] 默认深度 / 默认条目尺寸 / 标签形状 / 默认视角

### AI(新增分类)

- [ ] AI enable / 模型 / 权限 / effort / CLI 路径 / load-user-settings / system prompt / env 覆盖 / API key / MCP 区(en/zh 双语)

### 全局深度控件

- [ ] 工具栏深度 Slider(1–5),70px,无 marks,`valueLabelDisplay="auto"`
- [ ] 拖动 Slider dispatch `setViewDepth`(clamp 1–5)
- [ ] 200ms 防抖在 `DirectoryContentContextProvider` 内(不是 slider),拖动 1→5 只触发 1 次递归 IPC
- [ ] 老用户升级自动得 `viewDepth = 1`

### 深度切换后的数据表现

- [ ] 默认 `viewDepth = 1` 等同"只看当前目录"
- [ ] 深度 ≥ 2 时 9 个视角均纳入子目录文件
- [ ] 深度 = 1 时 List 仍能看到当前目录子文件夹
- [ ] 深度 ≥ 2 时 List / Grid / Gallery 显示相对路径副标题
- [ ] 面包屑始终停在当前目录
- [ ] Calendar / Kanban / Matrix 在深度 > 1 时纳入子目录文件
- [ ] 同名跨目录文件 path-keyed 互不污染

### 截断与性能护栏

- [ ] 超过 `MAX_RECURSIVE_ENTRIES = 10000` 时截断 + Alert(`recursiveTruncated` 在 FileList 顶部)
- [ ] 深目录扫描期间 FileList 半透明遮罩
- [ ] **Alert 仅在 FileList 出现**;Gallery/Kanban/Matrix/Gantt/Calendar/Mapique/TagCloud/KG/FolderViz 各自根组件不含该 Alert

### 排序行为

- [ ] 深度 = 1 时 Sort by name 按 basename
- [ ] 深度 > 1 时 Sort by name **仍按 basename**(`compareEntries` 是 depth-blind);**没有** path-sort 与 `sortByPathHint` i18n 键
- [ ] size / modified / extension 语义不变

### 数据层共享三件套

- [ ] `LoadingOverlay` / `EmptyHint` / `ErrorBanner` 实际只在 **KnowledgeGraph + Mapique + TagCloud** 3 个视角用;其他视角各自实现 loading/empty 状态

### 各视图自带深度滑块已移除

- [ ] TagCloud / KG / Mapique / FolderViz 工具栏不再有深度滑块
- [ ] FolderViz `whale.folderViz.<id>` 不再含 `maxDepth`

### FileList Truncated Alert

- [ ] 截断提示只在 FileList 顶部 `<Alert>`;其他 8 个视角需自行判断(recursiveTruncated context 已暴露)
