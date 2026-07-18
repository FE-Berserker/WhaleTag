← 返回 [plan.md](../plan.md)

# 03. 标签系统

> `wsd.json` 聚合 sidecar、标签库、标签组、互斥家族(评分/工作流/象限/smart date/期间)、颜色三级回退、`InlineTagInput`、`tagDisplayLabel`。

## 1. 存储:纯 sidecar,不做文件名嵌入

**只用 `wsd.json`**:标签、描述、颜色写在这里。**不嵌入文件名**(`name[tag1 tag2].ext` 形式),打标绝不改动文件名 / 文件夹结构,便于迁移、版本控制、同步工具不被污染。

`src/shared/tags.ts` 仍保留 `extractTags` 的读侧兼容(识别已有 `[tag]` 文件名),**只作为读取语义,不作为写入手段**。

## 2. 聚合 sidecar `.whale/wsd.json`

同目录所有打标签的文件合并到一个目录级 JSON,key 为 basename,**稀疏存储**(没打标的文件不占条目)。首次打标时才创建。

[src/main/sidecar.ts](../src/main/sidecar.ts):

- `readSidecars(dir)` 读 wsd.json(整目录)+ `migrateLatLngInPlace`(老 `lat/lng` 字段转 `geo:lat,lng` tag)
- `readSidecar(filePath)` 单文件读 —— 优先 wsd.json,缺失回退老 per-file `<file>.json`(搬迁兼容)
- `readSidecardsForPaths(paths)` 批量读,Pass 1(并行)按父目录分组读 wsd.json,Pass 2(并行)缺失的逐个 `readSidecar`
- `writeSidecar` / `removeSidecar` / `moveSidecar` / `copySidecar` 走 read-modify-write + 主进程 per-directory 写锁串行化
- 写盘 = `atomicWriteJson`(.tmp + fsync + rename)

**per-file 写锁**(`[src/main/dir-lock.ts](../src/main/dir-lock.ts)`):同目录写串行,跨目录并发。

## 3. 标签库 / 标签组

- **侧栏标签库**([src/renderer/components/TagLibrary.tsx](../src/renderer/components/TagLibrary.tsx)):可拖、可点击筛选
- **标签组**([src/renderer/components/TagGroups.tsx](../src/renderer/components/TagGroups.tsx)):组有自己的颜色,组内 tag 自动继承
- **per-location 标签库描述**:`.whale/wtaglib.json` —— 每 tag 一条描述文字
- **批量打标**保留各文件原 `description`

## 4. 互斥家族(同源规则)

| 家族 | 形态 | 互斥规则 | 颜色 |
|---|---|---|---|
| 评分 rating | `1star` `2star` `3star` `4star` `5star` | 1 文件至多 1 个 | 统一金 `#ffcc24`(不被 per-tag / group 覆盖) |
| 工作流 workflow | 阶段名(由 WorkflowManager 配置) | 1 文件至多 1 个 | 按阶段颜色,fallback 绿 `#008000` |
| 象限 quadrant | `urgent-important` 等 4 值 | 1 文件至多 1 个 | red / amber / blue / grey |
| smart date | `20260704` 等 7 种日期紧凑形 | 1 文件至多 1 个 | 无内置色,按 group / per-tag |
| 期间 period | `20260704-20260710` | 1 文件至多 1 个 | 紫 `#8b5cf6`(可被 per-tag / group 覆盖) |
| 坐标 geo | `geo:lat,lng` | 多份 | 红(`<LocationOnIcon>`) |

**实现位置**:`[src/shared/smart-tags.ts](../src/shared/smart-tags.ts)` 暴露:

- `withSingleRating(tags)` / `withSingleWorkflow(tags)` / `withSingleQuadrant(tags)` / `withSingleDateTag(tags, now?)` / `withSinglePeriodTag(tags)`
- `isStaleDateTag(tag, now?)`(`smart-tags.ts:403-407`)
- `isAnyDateShapeTag(tag)`(`smart-tags.ts:421-424`,主进程迁移 + 渲染层 PropertiesTray 用)
- 所有写路径统一走 `normalizeSmartTags(tags, now?)` 收敛 —— 同族"last wins",跨族不动

**smartFunctions 验鲜**:`smartFunctionalityOfTag(tag, now)` 对过期日期(`now` 视角下不再鲜)返回 null,降级为 `日期` chip 折叠(见 §6)。

## 5. 颜色三级回退

[src/renderer/domain/tag-colors.ts](../src/renderer/domain/tag-colors.ts) `getTagColor(tag, tagColors, groups)` 优先级:

1. `isRatingTag(tag)` → `RATING_COLOR = '#ffcc24'`(永远统一金,**不允许覆盖**)
2. `isPeriodTag(tag)` → `PERIOD_COLOR = '#8b5cf6'`(可被 per-tag / group 覆盖)
3. `tagColors[tag]` —— 用户自定义 per-tag 色
4. 组内 → 继承组色
5. workflow / quadrant / geo → 各自专用色 / fallback
6. `undefined` → 使用默认 outlined

每条分支都有 `getTagColor.test.ts` 单测覆盖。

**自动上色(M9)**:[TagMetaContextProvider](../src/renderer/hooks/TagMetaContextProvider.tsx) 发现未上色的新 tag 时,`pickTagColor` 选"最少用"的调色板色,并**攒成一个 `setTagColors` 批量 action 一次 dispatch**(累加着算 → 每个 tag 拿到不同色),而不是逐个 `setTagColor`(每个一次同步 persist 写)。打开一个有很多新 tag 的目录从 N 次 fsync → 1 次。

## 6. Smart Date 与 `日期` 折叠

[src/shared/smart-tags.ts](../src/shared/smart-tags.ts) 7 个日期类 functionality 的存储值与鲜度窗口:

| functionality | 存储值(紧凑) | 鲜度判定(`now` 视角) | 过期降级 |
|---|---|---|---|
| `now` | `20260704T1430` | **同一分钟内**(`now` 降级前为默认)—— 严格 ≈ 60s,不是 5 min | 折叠到 `日期` chip |
| `today` | `20260704` | `now` 的本地日期 ≡ 存储值 | 折叠到 `日期` chip |
| `yesterday` | `20260703` | `now` 的前一天 ≡ 存储值 | 折叠到 `日期` chip |
| `tomorrow` | `20260705` | `now` 的后一天 ≡ 存储值 | 折叠到 `日期` chip |
| `nextWeek` | `20260713` | 指向下周一;当 `now` ≥ 该周一 → stale | 折叠到 `日期` chip |
| `currentMonth` | `202607` | `now` 的本地年月 ≡ 存储值 | 折叠到 `日期` chip |
| `currentYear` | `2026` | `now` 的本地年 ≡ 存储值 | 折叠到 `日期` chip |

**鲜度谓词**内联在 `smartFunctionalityOfTag` 内(`smart-tags.ts:688` 用 `resolveSmartTag(fn, now)` 直接比较),过期的 `now` 视角返回 null。

`useNow()` hook([src/renderer/hooks/useNow.ts](../src/renderer/hooks/useNow.ts))每分钟 tick 提供 `now`。**当前仅 3 个调用点**(`FileList.tsx` ×1,`PropertiesTray.tsx` ×2,`TagMetaContextProvider.tsx` ×1)。其他 `tagDisplayLabel(tag, t)` 调用走默认 `now = new Date()` —— 在用户长时间停留时,**当日的 chip 在跨日后不会自动重渲染**(直到下次显式 tick)。后续优化:统一在 hook 内驱动,或向上下文注入。

**降级展示**:过期日期不再显示具体值,统一折叠进 **`日期` chip`,显示文本 "日期 (n)"(en/zh 同),`STALE_DATE_FOLD_COLOR = '#9e9e9e'` 中性灰,`HistoryIcon` 图标。在 `TagLibrary` 渲染时位于标签库"日期组"簇内最后一项。

**标签库"日期组"视觉**:

```
┌─ 日期 ──────────────────────────┐
│ [今天(5)] [本月(12)] [今年(8)] │
│ [📅 期间(3)]                   │  ← period: 折叠(深紫)
│ [🕘 日期(17)]                  │  ← date: 折叠(中性灰,过期聚合)
└────────────────────────────────┘
```

`smart:` 簇 / `period:` chip / `date:` chip 共享外框 + 浅底色 + 顶部 overline "日期"。每个 chip 仍独立 clickable / draggable(数据模型独立)。

`tagDisplayLabel(tag, t, now = new Date())` 返回:

- active smart date → i18n 模板名("今天" / "本月" 等)
- active `now` → 紧凑时间戳字符串 `YYYY-MM-DD HH:MM`(**非** i18n 模板)
- 过期 → 落回紧凑字符串(由 `date:` 折叠 chip 接管显示)
- period → `t('tagPeriodRange', { start, end })` 紧凑短格式

## 7. 期间标签拖拽

用户从标签库拖 `period:` chip 到文件行 / 文件夹行 / 多选 selection:

1. Row visual fade to `opacity: 0.5`(drop accept)
2. drop 时**不立即写**,弹 [src/renderer/components/PeriodTagDialog.tsx](../src/renderer/components/PeriodTagDialog.tsx)
3. 对话框含 起始日 / 截止日 两个 date picker;`end >= start` 校验(允许单日)
4. 确认 → 写 `YYYYMMDD-YYYYMMDD` 紧凑形;取消 / Esc / 关闭均不写

日历 DayCell **不接** `period:` drop(期间属"跨日",日历单格无自然落入)。

对话框状态住在 [src/renderer/containers/MainLayout.tsx](../src/renderer/containers/MainLayout.tsx),`usePeriodTagDialog()` hook 暴露:

```ts
type DialogState = {
  defaultStart?: string;
  defaultEnd?: string;
  anchorPosition?: { x: number; y: number };  // Gantt 点击时弹,跟着锚点
  onConfirm?: (period: string, start: string, end: string) => void;
}
openDialog(state: DialogState): void;  // 注意:无 entry,dialog target-agnostic
closeDialog(): void;
```

`onConfirm(period, start, end)` 拿到紧凑 `YYYYMMDD-YYYYMMDD` 与起止日期串。

## 8. `InlineTagInput` 编辑器

[src/renderer/components/InlineTagInput.tsx](../src/renderer/components/InlineTagInput.tsx) chip 编辑器:

- **chip 渲染**:已有标签渲染为可删除 MUI `Chip`,使用 `chipSx(getTagColor(...), false, tagShape)` 着色
- **提交语义**:`Enter` / `Space` / `Blur` 任一触发 `commit()`,把 `input.trim()` 推给 `onAdd` 并清空输入框。**避开逗号**(geo `geo:lat,lng` 含逗号)
- **Backspace + 空输入** → 删除最后一个可见 chip(token-input 标准 affordance)
- **点容器空白自动 focus** 到 input(`data-tag-input` 选择器);点 chip 的 `×`(`MuiChip-deleteIcon`)不抢焦点
- **geo 标签隐藏**:`visibleTags = withoutGeoTags(tags)`,由 Mapique 写
- **只读模式**:`readOnly` 时不渲染 `InputBase`,chip 不带 `×`;无标签时显示 `t('noTagsYet')` 占位
- **MUI 9 API**:`InputBase` 的 `inputProps={{ 'data-tag-input': true }}` 仍可用;无需 `slotProps` 迁移

`PropertiesTray` 接管单文件 + 多选两路标签编辑流(原 `TagEditDialog` 已删除)。Mapique 详情面板的 chip 行为不变。

## 9. `TagMetaDialog`

在 chip 上右键打开,编辑**单个标签的元数据**:

- 改颜色(per-tag override)
- 重命名

不影响侧栏 / 标签库其它 chip。

## 10. 标签库合簇

`TagLibrary.tsx` `TagGroups.tsx` 把以下折叠键渲染为独立 chip(cluster 视觉,数据仍独立):

- `geo:`(Location 簇,独立)
- `smart:<fn>` × 7(日期组,模板名 + count)
- `period:`(日期组内)
- `date:`(日期组内最后一项,过期聚合)
- 其它普通 tag(可拖,按 group 分组)

`TagMetaContextProvider.allTags` 注入折叠键的 `count`(纯渲染辅助,不写入 sidecar)。

## 11. 存量数据迁移(主进程启动后台扫描)

[src/main/migrate-date-tags.ts](../src/main/migrate-date-tags.ts) 一次性迁移老前缀格式:

```ts
migrateSidecarTags(tags): { tags: string[]; changed: boolean }
  // 纯函数:剥离 (today|yesterday|tomorrow|now|week|month|year)- 前缀
  // + 用 isAnyDateShapeTag 收敛 date + period 家族 last-wins

runMigration(allowedRoots): Promise<MigrationResult>
  // 启动后台 scan 所有 .whale/wsd.json / .whale/wsm.json,per-file 原子写
  // 首次备份生成 <file>.bak-dateprefix + .whale/_migration-state.json 标志
  // 二次运行幂等(只看 changed)
```

**触发时机(2026-07-18 修复)**:首次**非空** `fs:setAllowedRoots` 推送时触发 —— [ipc.ts](../src/main/ipc.ts) handler 里 `triggerStartupMigration(getAllowedRoots())`(once-guard 防 location 增删的重推送重跑;空推送不消耗 guard,渲染层 rehydration 前可能先推一次 `[]`)。原先在 `bootstrap()` 里跑时 roots 必为空(渲染层尚未挂载),迁移从未真正执行 —— 见 [docs/09 §26](./09-known-issues.md)。

## 12. 已知取舍

- `tagDisplayLabel` 不在 `now` 状态下显示 i18n 模板名(因为精度到分钟,显示原 `2026-07-04 14:30` 比"此刻"更有信息量)
- 期间家族"过期"无专门折叠(与 `date:` 共用 `isDateLikeShape` 边界,但通过 `isPeriodTag` 排除)
- 文件夹元数据(`.whale/wsm.json` 的 `tags`)也对日期家族做互斥收敛,批量子目录打标时每个子目录各自互斥
- `InlineTagInput` 调用 `tagDisplayLabel(tag, t)` 不传 `useNow()` —— chip 不动态刷新鲜度,等待下次 render(整体优化未做)
- `nextWeek` 在它指向的那个**周一**就会 stale(过了当日 0:00 立刻降级)
- `now` smart tag 的 60 秒鲜度窗口写死在 `smart-tags.ts` 的内联比较,未抽出常量;后续若调阈值,需在测试同步
- `TagLibrary.tsx` 标签列表未虚拟化(clusterTags / otherTags 直接 `.map` 全量渲染),大库几百上千标签时全量 DOM(2026-07-18 审阅;SearchBar 有 SQL `QUERY_LIMIT=50` 兜底故无需)
