← 返回 [plan.md](../plan.md)

# 21. 本地 MCP 服务器

> 0.5.0 起内置 AI 助手被移除,由**本地 MCP(Model Context Protocol)服务器**取代:智能在外部 AI 客户端(Claude Desktop、ZCode 等),WhaleTag 只提供受护栏保护的"手"。

## 1. 一句话与动机

外部 AI 客户端通过 MCP 协议对用户已打开的位置(location roots)进行**搜索、读取、打标、归纳落笔、整理与打包**。所有操作走主进程既有模块——allowedRoots 约束、sidecar 联动搬移、回收站、索引 worker 原样生效,没有第二套 FS 实现。

## 2. 模块地图

| 文件 | 职责 |
|---|---|
| [src/main/mcp/mcp-config.ts](../src/main/mcp/mcp-config.ts) | 配置(`<userData>/mcp-config.json`,原子落盘,主进程所有):`enabled` / `port` / `token` / `readOnly`。默认**关 + 只读** |
| [src/main/mcp/mcp-http.ts](../src/main/mcp/mcp-http.ts) | **无 Electron 依赖**的协议核心:Bearer 鉴权(定时安全比较)、JSON body 读取、有状态 Streamable HTTP 会话(每 `mcp-session-id` 一个 `McpServer` + `StreamableHTTPServerTransport`)。可被官方客户端 SDK 端到端测试 |
| [src/main/mcp/mcp-tools.ts](../src/main/mcp/mcp-tools.ts) | 18 个工具的注册与实现,直接调用 `sidecar.ts` / `index-worker-host` / `ipc/fs-read` / `ipc/fs-write` / `fulltext.ts` |
| [src/main/mcp/mcp-approval.ts](../src/main/mcp/mcp-approval.ts) | 写操作审批闸:fail-closed(无窗口 / 60s 超时 / 拒绝 = 全部视为拒绝) |
| [src/main/mcp/mcp-server.ts](../src/main/mcp/mcp-server.ts) | Electron 壳:监听 127.0.0.1(配置端口被占则回退随机端口)、生命周期(`initMcpServer` / `shutdownMcpServer`)、审批推送、状态快照 |
| [src/main/mcp/ipc-mcp.ts](../src/main/mcp/ipc-mcp.ts) | `mcp:*` IPC:设置 UI 轮询状态 / 推开关 / 审批作答 |
| [src/shared/mcp-types.ts](../src/shared/mcp-types.ts) | `McpStatus` / `McpApprovalRequest` 契约 |
| [src/renderer/components/McpSection.tsx](../src/renderer/components/McpSection.tsx) | 设置 → MCP 服务器面板(开关 / 只读开关 / endpoint / token 显隐与再生成) |
| [src/renderer/components/McpApprovalDialog.tsx](../src/renderer/components/McpApprovalDialog.tsx) | 审批弹窗(MainLayout 挂载,一次一条,重载后通过 `mcp:pendingApprovals` 恢复队列):明细列**完整路径**(可滚动,超 20 条显式标注未展示数),Deny 为默认焦点——快速 Enter 永不等于放行 |

依赖:`@modelcontextprotocol/sdk`(纯 JS,打进 main bundle)+ peer `zod` / `@cfworker/json-schema`。

## 3. 工具面(18 个)

**发现(只读)**:`whale_roots`(位置 + 索引状态,客户端第一个该调的)、`whale_search`(FTS trigram 名/路径/标签)、`whale_advanced_search`(SearchQuery 结构化过滤)、`whale_fulltext_search`(正文搜索 + snippet)、`whale_build_fulltext`(增量建正文索引)、`whale_list_tags`(distinct 标签 + 标签库描述)、`whale_list_directory`。

**读取(归纳的输入)**:`whale_read_text`(编码自适应读文本,offset/limit 分页)、`whale_extract_text`(单文件抽取:`fulltext.ts` 的 `extractText`,支持 PDF/HTML/文本类;**office 不支持**)、`whale_get_meta`(≤200 路径批量读 sidecar)。

**整理——元数据级(免审批,不碰用户文件)**:`whale_apply_tags`(加/移标签,`updateFileTags` 加锁合并,写入前经 `normalizeSmartTags` 规范化——与 UI 打标行为同源,外部客户端写不出 UI 不会产生的标签形态)、`whale_write_description`(写 sidecar description——**归纳结果的推荐落点**,可搜索、UI 可见)。

**整理——文件级(需审批)**:`whale_move_files` / `whale_copy_files` / `whale_create_folder` / `whale_delete_files`(仅回收站,不提供永久删除)/ `whale_zip_files` / `whale_create_text_file`(报告落盘,拒绝覆盖)。

## 4. 安全模型(与 docs/13 §11 对应)

1. **只监听 127.0.0.1**,永不暴露局域网;默认关闭,需在设置里显式开启。
2. **Bearer token**:每次请求必带 `Authorization: Bearer <token>`,`timingSafeEqual` 比较;token 本地生成,设置页可显隐 / 复制 / 再生成。
3. **allowedRoots 硬约束**:所有工具的路径先过 `assertWithinAllowedRoot`;且 MCP 比渲染层 IPC **更严**——move/copy 的**目的地也必须在 roots 内**(`assertBothEndsInside`,渲染层的拖拽豁免不适用于外部客户端)。
4. **写分级**:sidecar 级(标签/描述)免审批;文件级(move/copy/delete/zip/create)推 `mcp:approvalRequest` 到窗口,用户明确点"允许"才执行;无窗口 / 60s 超时 / 拒绝一律 fail-closed。
5. **只读模式**(默认开):所有变更工具(含打标)直接拒绝,搜索与读取不受影响。
6. **数据神圣**:删除仅回收站;所有批量操作逐条收集错误、绝不静默吞;createTextFile 拒绝覆盖已存在文件。
7. **Host 校验**:仅接受 `127.0.0.1` / `localhost` / `[::1]` 的 Host 头(先于 token 检查返回 403)——浏览器里的恶意页无法经 DNS rebinding 以同源方式探测端点。

## 5. 会话与生命周期

- 有状态 Streamable HTTP:`POST /mcp` initialize 建会话,后续请求带 `mcp-session-id` 复用 transport;`DELETE /mcp` 终结会话;`GET` 405(无服务端主动流)。
- `initMcpServer()` 在 bootstrap 注册(配置 enabled 才监听);`before-quit` 时 `shutdownMcpServer()` 拒绝未决审批并释放端口。启动失败只打日志,绝不阻塞应用启动。
- 端口默认 7433,被占则回退随机端口;设置页显示真实 endpoint。

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
- 测试:`mcp-approval.test.ts` 覆盖审批闸全部 fail-closed 路径;`mcp-http.test.ts` 用**官方客户端 SDK** 走通 401 / initialize / tools 列表 / 只读工具调用 / 未审批变更拒绝的端到端链路(electron 模块在测试中以 stub 注入)。
- token 明文落盘 `<userData>/mcp-config.json`(设置页可一键再生成)——任何能读该文件的本地进程可完全冒充客户端;换取设置页直接展示 / 复制,属本地工具的通行取舍。MCP 配置变更在生命周期队列内**先原子落盘再生效**,切换后立即崩溃不丢状态。
