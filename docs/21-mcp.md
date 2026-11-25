← 返回 [plan.md](../plan.md)

# 21. 本地 MCP 服务器

> 0.5.0 起内置 AI 助手被移除,由**本地 MCP(Model Context Protocol)服务器**取代:智能在外部 AI 客户端(Claude Desktop、ZCode 等),WhaleTag 只提供受护栏保护的"手"。

## 1. 一句话与动机

外部 AI 客户端通过 MCP 协议对用户已打开的位置(location roots)进行**搜索、读取、打标、归纳落笔、整理与打包**。所有操作走主进程既有模块——allowedRoots 约束、sidecar 联动搬移、回收站、索引 worker 原样生效,没有第二套 FS 实现。

## 2. 模块地图

| 文件 | 职责 |
|---|---|
| [src/main/mcp/mcp-config.ts](../src/main/mcp/mcp-config.ts) | 配置(`<userData>/mcp-config.json`,原子落盘,主进程所有):`enabled` / `port` / `token` / `readOnly`。token 经 `safeStorage` 加密落盘(无可用密钥库时回退明文,见 §7);默认**关 + 只读** |
| [src/main/mcp/mcp-http.ts](../src/main/mcp/mcp-http.ts) | **无 Electron 依赖**的协议核心:Bearer 鉴权(定时安全比较)、JSON body 读取、有状态 Streamable HTTP 会话(每 `mcp-session-id` 一个 `McpServer` + `StreamableHTTPServerTransport`)。可被官方客户端 SDK 端到端测试 |
| [src/main/mcp/mcp-tools.ts](../src/main/mcp/mcp-tools.ts) | 20 个工具的注册与实现,直接调用 `sidecar.ts` / `index-worker-host` / `ipc/fs-read` / `ipc/fs-write`;全文抽取走 worker RPC(`fulltext:extract`),PDF 上限常量取自 `fulltext-limits.ts` |
| [src/main/mcp/mcp-smart-tag-catalog.ts](../src/main/mcp/mcp-smart-tag-catalog.ts) | 从 `shared/smart-tags.ts` 派生 JSON 安全的智能标签目录:规范值、UI 别名、互斥规则、动态日期格式与 WGS-84 地理坐标约定 |
| [src/main/mcp/mcp-approval.ts](../src/main/mcp/mcp-approval.ts) | 写操作审批闸:fail-closed(无窗口 / 60s 超时 / 拒绝 = 全部视为拒绝) |
| [src/main/mcp/mcp-location-requests.ts](../src/main/mcp/mcp-location-requests.ts) | 添加位置的主进程 → 渲染层请求协调:单窗口定向投递、15s 确认超时、退出时释放等待者;不直接改 Redux 持久化文件 |
| [src/main/mcp/mcp-server.ts](../src/main/mcp/mcp-server.ts) | Electron 壳:监听 127.0.0.1(配置端口被占则回退随机端口)、生命周期(`initMcpServer` / `shutdownMcpServer`)、审批推送、状态快照 |
| [src/main/mcp/ipc-mcp.ts](../src/main/mcp/ipc-mcp.ts) | `mcp:*` IPC:设置 UI 轮询状态 / 推开关 / 审批作答 / 添加位置完成确认 |
| [src/shared/mcp-types.ts](../src/shared/mcp-types.ts) | `McpStatus` / `McpApprovalRequest` / `McpAddLocationRequest` 契约 |
| [src/renderer/components/McpSection.tsx](../src/renderer/components/McpSection.tsx) | 设置 → MCP 服务器面板(开关 / 只读开关 / endpoint / token 显隐与再生成) |
| [src/renderer/components/McpApprovalDialog.tsx](../src/renderer/components/McpApprovalDialog.tsx) | 审批弹窗(MainLayout 挂载,一次一条,重载后通过 `mcp:pendingApprovals` 拉回**当前队首**):明细列**完整路径**(可滚动,超 20 条显式标注未展示数),Deny 为默认焦点——快速 Enter 永不等于放行 |

依赖:`@modelcontextprotocol/sdk`(纯 JS,打进 main bundle)+ peer `zod` / `@cfworker/json-schema`。

## 3. 工具面(20 个)

**发现(只读)**:`whale_roots`(位置 + 索引状态,客户端第一个该调的)、`whale_search`(FTS trigram 名/路径/标签)、`whale_advanced_search`(SearchQuery 结构化过滤)、`whale_fulltext_search`(正文搜索 + snippet)、`whale_build_fulltext`(增量建正文索引)、`whale_list_tags`(位置中已有标签 + 标签库描述)、`whale_smart_tag_catalog`(完整内置智能标签语义,无需位置或索引)、`whale_list_directory`。

**读取(归纳的输入)**:`whale_read_text`(编码自适应读文本,offset/limit 分页)、`whale_extract_text`(单文件抽取:经 `fulltext:extract` RPC 在 index worker 里调 `fulltext.ts` 的 `extractText`(pdfjs 解析不占主进程;主进程侧勿直接 import `fulltext.ts`,会连带 `index-db.ts` 触发 worker 守卫),支持 PDF/HTML/文本类;**office 不支持**;PDF 超过 128 MiB(常量在 `fulltext-limits.ts`)直接报错,不再整文件读进内存)、`whale_get_meta`(≤200 路径批量读 sidecar)。

**位置(需审批)**:`whale_add_location`(绝对路径指向已存在目录,`realpath` 规范化;允许自定义名称与位置只读标记,名称中的控制字符与 bidi 控制符会被替换,避免伪造审批文案)。用户批准后先等待 `known-roots.json` 授权记录落盘,再由渲染层走标准 `addLocation` → 从 dispatch 后的 Redux 最新状态同步 allowed roots → `persistor.flush()`,确认后才返回 `persisted: true`;不需要退出或重启 WhaleTag。任一步失败会撤销刚添加的位置并重新同步、落盘,避免重试产生同路径重复项。同一规范化 root 重复添加是幂等操作,不再次弹审批,也不改名称或只读设置。文件/标签工具在确认后即可使用;**此工具不构建搜索索引**,结果的 `indexing.triggered` 为 `false` 并带提示:文件/标签搜索需在界面选中位置后,在搜索栏点击 **Build index**(仅激活位置不会自动建立索引),正文搜索另调 `whale_build_fulltext`,实际状态以 `whale_roots` 为准。

**整理——元数据级(免审批,不碰用户文件)**:`whale_apply_tags`(加/移标签,`updateFileTags` 加锁合并,写入前经 `normalizeSmartTags` 规范化)、`whale_write_description`(写 sidecar description——**归纳结果的推荐落点**,可搜索、UI 可见)。

智能标签调用顺序是 `whale_smart_tag_catalog` → `whale_apply_tags`;`whale_list_tags` 只表示位置里已经出现过的词汇,不是内置目录。目录由共享定义派生并明确返回:

- **看板工作流**:默认 `not-started` / `in-progress` / `completed` / `abandoned` / `planned`,这五个内置值由 MCP 自动保持同族互斥;用户可在 Workflow Manager 自定义阶段,但主进程无法取得实时阶段清单,因此只要变更涉及自定义阶段,就应在同一次 `whale_apply_tags` 调用中把所有旧工作流阶段放入 `remove`。默认值不等于永远完整的实时列清单。
- **任务象限**:`urgent-important` / `urgent-unimportant` / `noturgent-important` / `noturgent-unimportant`,同族互斥;**评分**:`1star`…`5star`,同族互斥。
- **动态日期与周期**:目录列出 `today` / `now` / `nextWeek` 等 UI 别名对应的 `YYYYMMDD`、`YYYYMM`、`YYYYMMDDTHHMM` 等存储形式,以及 `YYYYMMDD-YYYYMMDD` 周期格式。`whale_apply_tags` **不解析 UI 别名**,例如必须写 `5star` 而不是 `star5`、写 `in-progress` 而不是 `workflowInProgress`;动态日期需先计算成规范存储值。
- **地图**:`geo:<latitude>,<longitude>` 是 WGS-84 十进制坐标,纬度 −90…90、经度 −180…180,不属于互斥族,sidecar 中可并存多个坐标标签;Mapique 只显示首个有效坐标,地图 / EXIF 界面编辑会把旧坐标替换为单个新值。若要通过 MCP 改变地图显示点,应在添加新 `geo:` 标签的同一次 `whale_apply_tags` 调用中移除旧 `geo:` 标签。不同智能标签族可以共存;除上述自定义工作流限制外,受支持的互斥族由 `normalizeSmartTags` 保留新值并淘汰旧值。

**整理——文件级(需审批)**:`whale_move_files` / `whale_copy_files` / `whale_create_folder` / `whale_delete_files`(仅回收站,不提供永久删除)/ `whale_zip_files` / `whale_create_text_file`(报告落盘,拒绝覆盖)。

## 4. 安全模型(与 docs/13 §11 对应)

1. **只监听 127.0.0.1**,永不暴露局域网;默认关闭,需在设置里显式开启。
2. **Bearer token**:每次请求必带 `Authorization: Bearer <token>`,`timingSafeEqual` 比较;token 本地生成、**加密落盘**(见 §7),设置页可显隐 / 复制 / 再生成。复制按钮在状态加载完成前 `disabled`(此时面板显示的是 `…` 占位,复制占位值等于骗人);剪贴板被拒(权限策略 / 文档未聚焦)时把 `errorMessage` 显示在面板里,不假装复制成功。
3. **allowedRoots 硬约束**:所有工具的路径先过 `assertWithinAllowedRoot`;且 MCP 比渲染层 IPC **更严**——move/copy 的**目的地也必须在 roots 内**(`assertBothEndsInside`,渲染层的拖拽豁免不适用于外部客户端)。
4. **写分级**:sidecar 级(标签/描述)免审批;文件级(move/copy/delete/zip/create)与**扩大可读范围的添加位置**推 `mcp:approvalRequest` 到窗口,用户明确点"允许"才执行;无窗口 / 60s 超时 / 拒绝一律 fail-closed。审批**一次只弹一条**(FIFO):只有队首会被广播并开始计时,排队请求的 60s **从它被显示时**才开始(旧实现让第二条在看不见的队列里烧完超时 → 用户从未见过的对话框被自动拒绝);队列上限 `MAX_PENDING_APPROVALS = 8`,超出立即拒绝而不是无限堆积。
5. **只读模式**(默认开):所有变更工具直接拒绝(含打标、描述、添加位置、以及会写索引的 `whale_build_fulltext`),搜索与读取不受影响。闸门是两道:调用开始前查一次,审批等待(最长 60s)返回后**再查一次**——等待期间用户打开只读,已点过的"允许"也不能放行;切换只读为开时立即 `denyAllPending()`,不让无效对话框继续挂在屏幕上。**位置的只读标记同样生效**:MCP 的写入工具复用主进程 `fs-write` / `sidecar` 函数，其中已接入 `assertWritable`，目标落在用户标记为只读的位置时直接拒绝（即使 MCP 的全局只读开关是关的）。
6. **数据神圣**:删除仅回收站;所有批量操作逐条收集错误、绝不静默吞,且**整批全失败时结果标 `isError`**(成功外壳 + errors 数组会让客户端误判);createTextFile 拒绝覆盖已存在文件。
7. **位置 root 是容器,不是条目**:`assertNotLocationRoot` 拒绝把配置的 root 本身作为打标 / 写描述 / move / copy / delete 的目标——root 的 sidecar 会落在边界**上一层目录**,而整根删除只值一个泛化对话框。root 内的普通条目不受影响。
8. **读上限 16 MiB**:`whale_read_text` 先 `stat()` 再整文件解码,非文件或超限直接报错并指向有 2 MB 读 / 200 KB 出上限的 `whale_extract_text`——避免客户端读一个多 GB 日志把主进程打爆。
9. **Host 校验**:仅接受 `127.0.0.1` / `localhost` / `[::1]` 的 Host 头(先于 token 检查返回 403)——浏览器里的恶意页无法经 DNS rebinding 以同源方式探测端点。

## 5. 会话与生命周期

- 有状态 Streamable HTTP:端点**精确匹配** `/mcp`(与 `/mcp/`),其余路径 404——不再用 `startsWith('/mcp')` 放行 `/mcpfoo` 之类前缀。`POST /mcp` initialize 建会话,后续请求带 `mcp-session-id` 复用 transport;`DELETE /mcp` 终结会话;`GET` 405(无服务端主动流)。
- **会话闲置回收**:每个会话记录 `lastSeen`(initialize 与每次复用请求都会刷新),后台 sweeper 每 60s 清一次,默认闲置 **30 分钟**回收(选项 `sessionIdleMs`,设 0 关闭;`sessionSweepMs` 控制扫描周期,定时器 `unref()`,不拖住进程退出)。回收/未知的 `mcp-session-id` 返回 **404**(协议语义:客户端应重新 initialize),不是 400。
- **会话数上限 32**(选项 `maxSessions`):新建会话前若已满,先按 `lastSeen` 驱逐最久未用的一个再建,而不是拒绝新人——客户端不发 `DELETE` 时把上限做成硬拒绝会卡死 MCP;被驱逐方下次调用拿 404,按协议重新 initialize 即可。
- **请求体上限 4 MiB**:按 UTF-8 字节数统计,超限返回 **413** 并在响应后 drain 剩余字节;不在读到一半时 `req.destroy()`(那会让客户端只看到连接重置)。
- `initMcpServer()` 在 bootstrap 注册(配置 enabled 才监听);`before-quit` 时**等待** `shutdownMcpServer()`(拒绝未决审批、释放端口,最多 2s,避免退出时仍有工具调用落在没有窗口的进程上)。启动失败只打日志,绝不阻塞应用启动。
- **关闭不挂在 keep-alive 上**:停止服务时先 `server.close()`,同一 Promise 内再 `closeAllConnections()`——外部客户端保持长连接也不会让设置页开关或退出卡住;监听成功后内部状态才发布,绑定失败不会泄漏半个 core(重试也不会留下孤儿实例)。
- 端口默认 7433,被占则回退随机端口;设置页显示真实 endpoint。
- **并发写不互相覆盖**:move/copy 的「目标不存在」检查与真正写入在目标目录的 `withLock` 临界区内完成(跨调用也串行;MCP 客户端会并行发请求),`cp` 用 `force:false + errorOnExist`——两个并发操作抢同一个目标名时只有一个成功,另一个明确报错,绝不会静默替换;EXDEV 跨盘回退的 copy-then-delete 同样带 `errorOnExist`。
- **添加位置串行确认**:添加调用排队执行,审批后再查一次重复 root,避免并发产生同名重复位置;渲染层确认等待最长 15s,服务停止立即拒绝等待者。超时后迟到的确认可能被忽略,因此错误会明确提示先用 `whale_roots` 核查再重试,绝不把未确认状态报告为已持久化。
- **索引状态不伪装**:`whale_roots` 对每个位置单独 try/catch,索引 worker 失败时返回该位置的 `error` 字段,而不是把它伪装成"文件数为 0 的空位置"。`whale_search` / `whale_advanced_search` 要求文件/标签索引已 ready,`whale_fulltext_search` 要求正文索引;新加位置不会由添加工具隐式建索引,客户端必须先检查状态,不能把未索引位置的 0 条结果解释为目录为空。
- **审批弹窗不乐观消失**:作答先发 IPC 并等主进程确认(`mcpResolveApproval` 返回 `{ ok, settled }`)。`settled: true` 才关闭弹窗;请求已超时/被清空时关闭并提示"已超时";**IPC 失败时弹窗留在原地**并提示失败——此时客户端仍被阻塞,静默消失会让人误以为已答复,工具调用却要等到 60s 超时才失败。弹窗显示剩余秒数(每秒按渲染时的时钟重算,不用挂载时的快照——否则挂载后才到达的请求会先显示 61s),作答在途时两个按钮都禁用,避免重复提交;挂载时拉取队首补回 reload 前后的未决请求,拉取失败会报错而不是装作没有请求。
- **配置容错**:`mcp-config.json` 读入后经 `normalizeMcpConfig()` 归一——非对象 JSON(`null` / 数组 / 标量)回退默认值并告警(此前会在 bootstrap 抛 TypeError),端口限定 1..65535 整数,token 过短/含空白则重新生成;损坏文件会带错误日志回退,不再静默换 token。写入走串行队列(`schedulePersist`/`persistNow`),后写的设置不会被先发起的落盘覆盖;落盘失败时 `persistNow` **重新抛错**,`mcp:*` 调用 reject 而不是返回一个只存在于内存的状态(旧行为只记日志:UI 显示已切换,重启后回退)。三个 setter(`setMcpEnabled` / `setMcpReadOnly` / `regenerateMcpToken`)落盘失败时按字段把缓存改回原值,内存状态与磁盘保持一致。

## 6. 外部客户端接入示例

ZCode / Claude Desktop 等 Streamable HTTP 客户端配置:

```json
{
  "mcpServers": {
    "whaletag": {
      "type": "http",
      "url": "http://127.0.0.1:7433/mcp",
      "headers": { "Authorization": "Bearer <设置页复制的 token>" }
    }
  }
}
```

## 7. 已知取舍 / 遗留

- **office 文档抽取不支持**(docx/xlsx/pptx),`whale_extract_text` 会明确报错;后续可在 worker 里加转换管线。
- 有状态会话存在内存里,应用重启后客户端需重连(重新 initialize)。
- `whale_build_fulltext` 是长操作,大位置可能跑数分钟;客户端超时策略由客户端自己决定。
- 测试:`mcp-approval.test.ts` 覆盖审批闸全部 fail-closed 路径,外加 FIFO 队列语义(只广播队首、队首结算后才提升下一条、排队期间不烧超时、队列满了立即拒绝、退出时不弹出下一条);`mcp-http.test.ts` 用**官方客户端 SDK** 走通 401 / initialize / tools 列表 / 只读工具调用 / 未审批变更拒绝的端到端链路,并覆盖前缀/未知会话 404、4 MiB+1 → 413、闲置回收与关闭 sweeper(electron 模块在测试中以 stub 注入);`mcp-config.test.ts` 覆盖归一化矩阵(非对象 JSON、越界端口、坏 token、只读默认值)、读写往返,以及 token 加密落盘:旧明文自动迁移、无密钥库回退明文、密文损坏时退回同文件明文、两者都不可用时重新生成;`mcp-server.test.ts` 覆盖启停、端口回退、只读开关、keep-alive 连接下的快速停止与并发开关串行化;`McpApprovalDialog.test.tsx` 覆盖弹窗的确认语义(推送/挂载补拉、结算后才关闭、提前超时提示、IPC 失败保留弹窗并提示、倒计时、作答期间禁用按钮)。工具面守卫在 `mcp-http.test.ts` 的 "tool guards" 组里用真实配置的 root 走端到端:只读拒绝打标 / 建索引、root 本身拒绝打标(且父目录不落 `.whale`)、root 内普通文件可打标、目录拒绝当文本读;同一文件的 "tool surface" 组补上了**审批放行**路径与其余工具:list_directory / get_meta(打标后回读)/ write_description(保留既有标签)/ extract_text / create_folder / create_text_file(拒绝覆盖)/ copy_files / move_files / delete_files(回收站)/ zip_files,每一例都走真实审批队列(测试用 `bindApprovalTransport` 自动放行),因此"审批闸静默全放行"的回归会被抓住;`mcp-smart-tag-catalog.test.ts` 验证目录与共享定义同源、日期/坐标约定及别名警示,官方客户端端到端用例另覆盖只读目录读取、内置工作流/象限/评分/日期/周期互斥、多坐标写入、自定义工作流阶段需显式移除旧阶段的限制,以及 UI 别名保持字面量;`allowed-roots.test.ts` 覆盖 `isConfiguredRoot` 的归一化匹配;`fs-write.test.ts` 用两个并发 copy/move 抢同一目标名验证只有一个成功且既有目标字节不变,并覆盖 `commonParentDir` 的跨目录归档路径。
- 添加位置测试:`mcp-location-requests.test.ts` 覆盖窗口/投递失败、渲染层错误、超时与迟到确认、退出释放;`Root.test.tsx` 覆盖标准 action、dispatch 后最新状态同步、持久化 flush、失败回滚与确认顺序;`mcp-http.test.ts` 经官方客户端覆盖只读拒绝、文件路径拒绝、真实目录添加、root 立即可见、重复调用不再次审批、同路径并发仅投递一次以及名称控制字符清理;`known-roots.test.ts` 覆盖授权记录写入失败会随 flush 上抛。
- token 优先经 Electron 的 OS 密钥库(`safeStorage`)加密后落盘 `<userData>/mcp-config.json`(字段 `tokenEncrypted` + `tokenStorage: "safeStorage"`);机器上没有可用密钥库时回退明文(字段 `token` + `tokenStorage: "plain"`)并在日志里说明。旧明文配置在下一次写入时自动迁移为加密形态;密文读不出来(换机、密钥库被重置)时优先退回同一文件里的明文 token,两者都没有才重新生成并告警——此时持有旧 token 的客户端会拿到 401。注意 Linux 无 keyring 时 Electron 会用内置口令走 `basic_text` 后端,`isEncryptionAvailable()` 仍为真,这时的"加密"只有混淆强度,不能当作真正的密钥保护。MCP 配置变更在生命周期队列内**先原子落盘再生效**,切换后立即崩溃不丢状态。
