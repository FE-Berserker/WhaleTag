← 返回 [plan.md](../plan.md)

# 22. 局域网只读访问

> 桌面端在设置里手动开启后,同一 Wi-Fi 下的手机 / 平板用浏览器配对,即可只读浏览位置、按文件名与标签搜索、预览与下载;没有任何写入 / 删除入口,也不会构建索引、缩略图或 `.whale/` 缓存。

---

## 1. 范围与开关

- 默认关闭。唯一的开关在桌面端设置页的「局域网」分类里;启动后主进程才在 `0.0.0.0` 的**临时端口**上开 HTTP 服务。
- 状态全部是会话级的:token、端口、cookie 会话都只在主进程内存里,**不落盘**。应用退出(或重启)后回到关闭状态,下次要重新开、重新配对。
- 桌面控制面只对内:IPC 通道 `lan:getStatus` / `lan:start` / `lan:stop` 注册在主进程([src/main/ipc/lan.ts](../src/main/ipc/lan.ts)),**不暴露给 Web 客户端**;手机端能调用的只有 §5 的只读 API。
- 服务对外只做两件事:提供只读 JSON API(`/api/*`)与移动端静态资源(`dist/mobile`)。它不代理桌面渲染层,也不复用 `whale-file://` 协议。

## 2. 桌面端面板(Settings > 局域网)

组件:[src/renderer/components/LanSettings.tsx](../src/renderer/components/LanSettings.tsx);分类登记在 [SettingsDialog.tsx](../src/renderer/components/SettingsDialog.tsx) 的 `SECTIONS`(`id: 'lan'`,标签键 `settingsSectionLan`,中文「局域网」)。

- 顶部固定一条黄色安全提示(同一 Wi-Fi、只读、令牌仅本次会话有效),不随运行状态隐藏。
- 一行状态文字(`role="status"`)显示「运行中 / 已停止」;开始 / 停止按钮在请求进行中禁用并显示「启动中 / 停止中」。
- 运行中显示配对用的 base URL:多网卡时用下拉框选一个地址,单网卡直接显示文本。切换只影响展示的 URL,不影响服务端监听哪个地址。
- **Copy** 把配对链接 `<baseUrl>#token=<URL 编码后的 token>` 写进剪贴板并给出已复制提示;剪贴板失败单独提示。
- **二维码** 编码同一个配对链接:仅在运行中且拿到 URL 时才 `import('qrcode')` 动态生成 220×220 的 data URL,停止时不加载编码器;生成失败显示错误提示。token 只进剪贴板和二维码编码器,面板**不**把 token 渲染成可读文本。
- 运行中每 2000ms 轮询一次 `lan:getStatus`:主进程可能因网卡变化或位置变化自己停掉(§7),轮询用于及时把面板翻回「已停止」并移除已经失效的二维码。

## 3. 配对:临时 token → HttpOnly cookie

1. 桌面端 Copy 或扫码得到 `http://<内网 IP>:<端口>/#token=<base64url token>`。
2. 手机打开链接后,移动端从 `location.hash` 读出 `token`,先用 `history.replaceState` 把 fragment 从地址栏抹掉,再发起配对。fragment 本身不会发给服务器,也不留在刷新后的地址里。
3. 配对请求:`POST /api/session`,带 `Authorization: Bearer <token>` 与固定头 `X-Whale-Request: read-only`。
4. 校验通过返回 `204`,并下发 `Set-Cookie: whale_lan_session=<32 字节随机 base64url>; HttpOnly; SameSite=Strict; Path=/`。cookie 里是服务端内存里生成的**会话 id**,不是 pairing token 本身。
5. 之后每个 API 请求靠 cookie 认证;缺 cookie 或会话已清 → `401` + `WWW-Authenticate: Cookie`,移动端回配对页并提示会话过期。
6. 手动配对:没带 fragment 时移动端显示配对页(密码输入框 + 「连接」),填桌面端给的 token 即可,失败提示「配对失败」。
7. 失败限速:同一来源地址 **60 秒内 5 次失败**即 `429` + `Retry-After`(秒);成功一次清零。内存里最多保留 64 个会话,超出丢最旧。

刷新页面不会丢会话:没有配对 fragment 时,移动端挂载先拿 `/api/roots` 试现有 cookie,`401` 才回配对页。带 `#token=` 的首次自动配对由配对流程独占建会话,不并行发未认证的 roots 探测;配对成功后也只加载一次位置列表。

## 4. 移动端 Web 客户端

源码:[src/mobile/](../src/mobile/)。独立于桌面 renderer 的 bundle(target `web`),自带 `styles.css` 与 [i18n.ts](../src/mobile/i18n.ts)(5 语言 en / zh / zh-TW / ja / ko,不共用桌面 locale 文件)。

- 顶部是紧凑的品牌、只读状态与语言栏；位置选择和子目录面包屑独立成导航区。面包屑由完整目录栈驱动，返回上一层、点击中间层级和回到根目录都恢复对应名称与父级。内容区提供带搜索图标的填充搜索框、横向标签 chips、项目计数与列表 / 网格切换。
- 手机默认是 76px 左对齐紧凑列表行,显示图标或图片、文件名、大小 / 日期和进入箭头;网格在手机为 2 列、平板为 3 列、宽屏为 4 列。平板列表采用居中限宽布局,不把手机行直接拉满。每层最多 500 项,超出时服务端标 `truncated`,页面明确提示只显示前 500 项。
- 安全栅格图片直接在列表 / 网格里用同源 `/api/file` 原图做视觉预览,加载失败回退文件图标;SVG / HTML 等主动内容不内联。这里不生成或写入任何缩略图缓存(§6)。
- 搜索框 300ms 防抖；搜索与标签过滤始终查询整个当前位置（不是当前子目录）。在子目录里激活任一过滤条件会退出目录上下文并隐藏面包屑，清除过滤后回到该位置根目录。有过滤时走 `/api/search`，无过滤时走 `/api/list`。标签 chips 来自 `/api/tags`（索引里的 distinct 标签），单选，可一键清除。
- 索引缺失时 `/api/tags`、`/api/search` 返回 `indexUnavailable: true`,页面提示「先在桌面端建索引」;此时目录浏览、预览、下载**照常可用**,因为列表读的是目录 + sidecar。
- 预览:图片 / 视频 / 音频内联(`<img>` / `<video>` / `<audio>` 直接指向 `/api/file`);纯文本用 `Range: bytes=0-262143` 取前 256 KiB,并校验 `Content-Range`,被截断时提示「只显示前 256 KiB」;PDF **不内联**,只显示「出于安全只提供下载」;其它类型提示不支持预览并引导下载。
- 下载走 `/api/file?...&download=1`,`Content-Disposition: attachment`,文件名带 RFC 5987 的 `filename*=UTF-8''…`(中文名不乱码)。
- 任何已建立会话的 API 请求返回 `401` → 清理本地文件状态、回配对页并提示会话过期；预览读取错误只显示通用提示，不反射底层路径或异常。
- 位置与目录请求分别管理 loading，错误以消息键保存；切换语言只更新文案，不重新请求 roots / list / tags / search。
- 请求生命周期：每个请求带 `AbortController` 与 **15 s** 超时（[src/mobile/request.ts](../src/mobile/request.ts)）；组件卸载、切目录 / 换位置、改过滤条件、点重试都会取消上一个请求，弱网超时落到可重试的错误态而不是永久转圈（主动取消不提示错误）。
- 预览失败降级：内联 `<img>` / `<video>` / `<audio>` 触发 `onError` 时换成与列表缩略图失败的同一套降级块并保留底部下载；同时用 `HEAD /api/file` 探测一次，`401` 照常清会话回配对页，其它失败只显示通用「预览无法加载」，细节只进 console。
- 配对失败只显示本地化消息键：`401` → 配对失败、`429` → 稍后再试、其余（网络 / 超时 / 其它状态码）→ 通用连接失败；不展示底层 `message`。
- 标签接口失败**不清空**已有 chips：保留原标签并显示带「重试」的警告条；底部「刷新」同时重拉 tags 与当前内容；没有共享位置时「刷新」改为重新请求 `/api/roots`，不再是无动作的死按钮。
- 索引缺失且正在过滤时只显示「先在桌面端建索引」的警告，不再同时显示「没有匹配的文件或标签」（后者在索引缺失时是假结论）。
- 可访问性：结果区带 `aria-busy`，loading / 空态用 `role="status"` 播报；`<html lang>` 与 `document.title` 随语言切换更新；12px 次要文本（结果计数、大小 / 日期、预览元信息）统一用 `--mobile-muted`，对白底与页面底色均 ≥4.5:1。
- 文本预览：`200` 响应缺 `Content-Length`（或该头为空 / 非法）时按「已截断」处理并取消 body，不读取无界内容。

## 5. HTTP 接口

所有接口都要求来源与目标是私网地址、Host 为字面 IP 且端口正确(§8);除 `/api/session` 外只接受 `GET` / `HEAD`(其它方法 `405` + `Allow: GET, HEAD`)。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/session` | 用 Bearer token 换 cookie 会话;`204` / `401` / `403`(缺 `X-Whale-Request`) / `429` |
| `GET`/`HEAD` `/api/roots` | 共享位置 `{ roots: [{ id, name }] }` |
| `GET`/`HEAD` `/api/list?rootId[&id]` | 单层目录;省略 `id` = 位置根;`{ rootId, id, name, path, parentId, entries, truncated }` |
| `GET`/`HEAD` `/api/tags?rootId` | 索引里的全部标签 `{ tags, indexUnavailable }` |
| `GET`/`HEAD` `/api/search?rootId&q&tag` | 文件名 / 标签检索 `{ entries, indexUnavailable }` |
| `GET`/`HEAD` `/api/file?rootId&id[&download=1]` | 单文件;支持 `Range` 与 `HEAD`;`download=1` 强制附件 |
| `GET`/`HEAD` `/`, `/assets/**` | 移动端静态资源;`dist/mobile` 不存在时 `404 Mobile client is not built` |

- 条目 id 是 base64url 编码的**相对路径**,不是绝对路径;每次使用都重新 `realpath` 校验(必须在 root 内、不含 `.whale` 段、无 `..`),越界 `403`、不存在 `404`。
- `/api/list` 的 `id` 最多出现一次;`.whale` 目录对 Web 端不可见;排序是目录优先 + `localeCompare`。每个条目仍逐个 `realpath` 复核,读不到(`403` / `404` / `EACCES`)的条目直接丢弃而不是报错。
- `/api/search`:`q` 只接受一个、≤512 字符;`tag` 最多 16 个、每个 ≤128 字符;固定 `tagMatch: 'all'`、`type: 'any'`,即「文件名子串 + 全部指定标签」,不支持类型 / 大小 / 时间 / 排除标签这些桌面高级查询条件。命中结果同样逐个落盘复核,已删除或越界的丢弃。
- `/api/file`:单段 `Range` → `206` + `Content-Range: bytes start-end/size`;不满足的范围 → `416` + `bytes */size`;格式错 → `400`;`HEAD` 只回头。**不支持多段 Range,也没有 `If-Range`**,不做断点续传的额外状态。
- 错误统一是 `{ error: string }`;每个响应都带 `Cache-Control: no-store`、CSP、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。

## 6. 只读保证:不做什么

这是本功能的核心约束,实现上不是"靠 UI 隐藏按钮",而是根本没有写路径:

- **没有写接口**:不存在上传 / 删除 / 移动 / 重命名 / 打标 / 改 sidecar 的端点;唯一的非 GET 是 `POST /api/session`,它只下发 cookie。
- **索引只读**:查询走 worker 的 `index:readonly-advanced` / `index:readonly-tags`,SQLite 以 `readonly: true, fileMustExist: true` 打开并 `PRAGMA query_only = ON`,用完立即关闭。**刻意不走 `getDb()`**——它会设 WAL 模式并执行 SCHEMA,两者都是写。索引不存在就直接返回 `indexUnavailable`,绝不创建 `.whale/` 目录或 `index.db`。
- **sidecar 只读**:标签读取走 `readSidecarsReadOnly()`,不加写锁、不导入 legacy JSON、不持久化经纬度换算、不创建 `.whale/wsd.json`;元数据畸形或不可读时不会改写文件,列表降级为文件名标签并返回 `metadataUnavailable: true`,移动端明确提示 sidecar 标签暂不可用,不会让整个目录变成 500。
- **不建缩略图、不写缓存**:图片给的是原文件;浏览一层目录不会产生缩略图文件、索引条目或任何缓存。
- **不递归**:一次只读一层目录(搜索是索引查询,不是扫描)。
- **主动内容只下载**:`.html` `.htm` `.xhtml` `.xml` `.svg` `.svgz` `.js` `.mjs` `.cjs` `.pdf` 一律 `Content-Disposition: attachment`,即使 `download=0` 也不内联渲染——即便 CSP 有疏漏,也不会在本机 origin 上执行手机传来的脚本。
- 标签值与桌面端同源:`mergeTags(文件名解析结果, sidecar 标签)`,Web 端看到的就是桌面端看到的那份元数据,只是不能改。

## 7. 生命周期:什么时候会停

| 触发 | 行为 |
| --- | --- |
| 桌面点「停止」 | 清 token、清所有会话、`closeAllConnections()` + destroy 全部 socket,手机端下一次请求直接失败 |
| 网卡地址集合变化 | 每 2000ms 比对一次网卡快照指纹,变化即自动停止(切 Wi-Fi / 断网 / DHCP 换 IP / VPN 起停) |
| 位置(allowed roots)变化 | 增删位置后总是执行停止/取消([fs-roots.ts](../src/main/ipc/fs-roots.ts)),包括尚在启动或排队启动的实例,避免已移除的位置还能经旧快照访问 |
| 应用退出 | `before-quit` 里与 MCP 服务器一起 `shutdownLanServer()`,最多等 2 秒 |

启动与停止采用 last-command-wins:每个操作在任何 `await` 前登记代次,后续停止会使所有待启动/排队启动失效;迟到的 `listen` 回调也会立即关闭。停止是"全清"语义:token 置空、会话清空,重新开始会换新 token、通常也换新端口(临时端口),面板里的旧二维码/旧链接立即失效。因为主进程会自己停,面板必须轮询(§2)才能不显示过期二维码。

## 8. 安全边界

- **只服务私网**:来源与目的地址都必须是回环 / 私网 / 链路本地(10/8、127/8、172.16–31、192.168/16、169.254/16、`::1`、`fc00::/7`、`fe80::/10`),否则 `403`。公网、NAT 后、走运营商或 VPN 出口的访问一律拒绝。
- **绑定地址白名单**:虽然监听 `0.0.0.0`,但只接受启动快照里存在的本机网卡地址;`Host` 头必须是**字面 IP**(任何域名都拒)、端口必须等于实际监听端口、地址必须在白名单里——DNS rebinding 因此不成立。`Origin` 若存在必须是 `http://<允许的 IP>:<端口>`,带凭据 / 路径 / 查询 / hash 一律拒;`Sec-Fetch-Site` 只允许 `same-origin` 与 `none`,跨站请求 `403`。
- **token 与会话**:token 是 32 字节随机(base64url),只存在主进程内存、只在本次会话有效,比较用 `timingSafeEqual`;cookie 是独立的会话 id,带 `HttpOnly`(页面脚本读不到)、`SameSite=Strict`、`Path=/`、无 `Domain`。明文 HTTP 下不能设 `Secure`。
- **限速与上限**:每来源 60 秒 5 次认证失败即 `429` + `Retry-After`;URL ≤ 8192、API body ≤ 1 KiB、拒绝 `Transfer-Encoding`、单连接最多 100 请求、最多 64 个会话。
- **响应头**:CSP 无 inline script,`object-src 'none'`、`frame-ancestors 'none'`、`form-action 'self'`;静态资源另加 `Cross-Origin-Resource-Policy: same-origin`。
- **不防嗅探**:数据面是明文 HTTP,没有 TLS。同一网段 / 同一 Wi-Fi 上的其他设备可以抓包看到目录内容、文件和配对请求里的 `Authorization` 头(配对链接的 fragment 本身不进网络)。只应在可信局域网使用。
- **Windows 防火墙**:首次在 `0.0.0.0` 上监听时系统会弹「是否允许访问」;必须勾选**专用网络**。仓库不自带防火墙规则,拒绝后手机端表现为连不上(超时)。
- 剪贴板 / 二维码里的链接本身就是配对凭据:截图、录屏、聊天转发等于把这次会话的 token 给了别人,用完点「停止」即失效。

## 9. 构建与打包

- 移动端是独立 web target:`npm run build:mobile`([webpack.config.mobile.prod.ts](../.erb/configs/webpack.config.mobile.prod.ts))→ `release/app/dist/mobile/`,资源路径 `/`,文件名带 contenthash,`index.html` 由 `HtmlWebpackPlugin` 从 [src/mobile/index.html](../src/mobile/index.html) 生成(内含 meta CSP 与 `viewport-fit=cover` 移动端视口)。`npm run build` 已包含这一步。
- 开发态用 `npm run build:mobile:dev` / `npm run watch:mobile`(不压缩、带 source map、`output.clean: false`);`npm run dev` 已并行启动 `watch:mobile`。**没有独立 dev server**:页面与 API 同源,都由主进程 HTTP 服务提供。
- 主进程按 `path.resolve(__dirname, '../mobile')` 找静态目录(即 `dist/mobile`),`realpath` 解析失败就只提供 API(开发时可以只跑接口)。
- 打包:`resources/builder.json` 的 `files` 已含 `dist/**/*`,`dist/mobile` 自动进 `app.asar`,**不需要** mobile 专用 `extraResources`。
- 冒烟:`npm run test:lan` → `scripts/packaged-lan-smoke.js`,挂在手动触发的 `packaged-smoke.yml`(步骤名 `Smoke read-only LAN desktop and mobile clients`);`ci.yml` 的 lint / type-check / test / build:mobile 门禁不含 LAN 冒烟步骤。脚本用真实打包应用和独立移动 BrowserWindow 验证配对、目录 / 搜索 / 标签、文本 Range、原生下载、图片解码、390px 两列网格与 76px 列表、768px 三列网格、停止失效和 `.whale/` 业务内容不变;截图通过 `animations: 'disabled'` 强制结束有限动画，并保留 Dialog opacity 与 DOM 断言，避免把过渡帧误当稳定视觉。

## 10. 限制与取舍

- 明文 HTTP,不做 TLS(证书、自签、HTTPS 混淆都要另立项)。
- 只读:不能打标 / 改名 / 移动 / 删除 / 上传,也不能编辑 sidecar。
- 搜索依赖桌面端已建好的索引;不建索引、不建全文索引,只覆盖「文件名子串 + 标签」,不支持桌面高级查询的类型 / 大小 / 日期 / 排除标签条件,标签过滤固定「全部满足」且单选。
- 图片预览直接读同源原图,没有服务端缩略图:安全栅格图在列表和网格里直接显示,加载失败回退图标;不生成缓存的代价是大图片仍按原文件流量与解码成本计算。
- 单层浏览 + 500 项截断,没有分页 / 游标协议;超大目录首次加载会慢一些(每项都要 `realpath` 复核)。
- 按设备管理的能力很弱:没有独立的设备列表、踢下线、持久白名单;「停止」对全体生效,重启即换 token 和端口。
- 网络抖动会触发自动停止:只要网卡地址集合变化就停(包括 VPN 起停),多网卡 / 移动热点场景比较敏感。
- 只支持同一私网:跨网段、公网、手机走 4G/5G 或 VPN 出网都不能用。
- PDF / HTML / SVG / JS 只下载不预览。
- 移动端 i18n 是独立字典(`src/mobile/i18n.ts`),与桌面 renderer 的 locale 文件互不依赖,文案改动要两边都改。

跨模块的取舍清单另见 [docs/09-known-issues.md](./09-known-issues.md) §36;安全边界汇总见 [docs/13-security.md](./13-security.md) §14。
