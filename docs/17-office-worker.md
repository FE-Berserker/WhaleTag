← 返回 [plan.md](../plan.md)

# 17. Office→PDF 常驻 UNO Worker

> P3-3([docs/15](./15-perf-audit.md))的落地:保活一个 LibreOffice UNO listener,让 Office→PDF 转换不再每次 spawn 全新 `soffice` 进程。冷启动只发生一次,后续转换复用已初始化的进程(~200–500ms,vs 每次 spawn 的 2–5s)。

## 1. 为什么常驻

两个 Office→PDF 调用点 —— office-viewer 开档([convertOfficeToPdf](../src/main/office-convert.ts))与 office 缩略图([encodeOfficeThumb](../src/main/thumbnail.ts))—— 原本每次都 `execFile(soffice, --convert-to pdf)`。Windows 上 `soffice` 冷启动 2–5s(加载 ~200MB DLL + 初始化 UNO 运行时 + profile)。[office-cache.ts](../src/main/office-cache.ts) 已让**重开同一文档**秒开;剩余痛点是**首次**打开每个不同 office 文档、以及**批量**生成 office 缩略图时的冷启动叠加。

根本解:保活一个 soffice listener,冷启动只付一次,后续转换复用。

**为什么是 Python worker**:Node.js 至今(2026)没有成熟的 UNO bridge 客户端。LibreOffice 自带 `python` + `pythonuno`,是跨平台驱动常驻 listener 的唯一可靠路径(unoconv / unoserver / paperless-ngx 同方案)。

## 2. 架构

```
首次 office 转换(惰性 spawn):
  Node host ──spawn(cwd=LO/program)──▶ python worker(常驻)
                                          │ ① pick_free_port → soffice listener
                                          │   (--accept=socket,port=N;urp; 独立 profile)
                                          │ ② UnoUrlResolver.resolve(重试 ~6s)
                                          │ ③ Desktop(模块级单例,worker 生命周期内复用)
                                          └ stdout: {"kind":"ready","listenerPid":N}

后续转换(进程已热):
  Node host ──stdin {reqId,srcPath,outPdfPath}──▶ worker
       worker: loadComponentFromURL(Hidden) → storeToURL(FilterName) → doc.close()
  Node host ◀──stdout {reqId,ok}──── worker
  Node 读 outPdfPath(已有 tmpDir/cache 逻辑不变)

回退:worker unavailable(python 缺失 / import uno 失败 / listener 起不来 /
      ready 超时 / 连续崩溃)→ cooldown 期内直走现有 execFile(零 regression)
```

PDF 走 **write-to-path**(worker `storeToURL` 直接写到 caller 指定的 `outPdfPath`),不走 stdio bytes —— PDF 常常几十 MB,base64 over JSON 膨胀 33% 且要全量缓冲。

## 3. 文件

| 文件 | 职责 |
|---|---|
| [uno-worker.py](../src/main/office-worker/uno-worker.py) | Python 桥接端:启动 listener、UNO 连接、Desktop 缓存、转换、stdin JSON 协议、graceful teardown |
| [office-worker-host.ts](../src/main/office-worker/office-worker-host.ts) | Node host:惰性 spawn、reqId 关联、ready 握手、cooldown FSM、崩溃重 spawn、shutdown tree-kill。照搬 [index-worker-host.ts](../src/main/index-worker-host.ts) 骨架,改用 `child_process.spawn` + 行 JSON |
| [office-worker-python.ts](../src/main/office-worker/office-worker-python.ts) | 发现能 `import uno` 的解释器(LO 自带 python 优先,系统 `python3-uno` 兜底),镜像 [sofficeBinary()](../src/main/office-binary.ts) 的 inflight+memo 形状 |
| [office-worker-script.ts](../src/main/office-worker/office-worker-script.ts) | 脚本路径 resolver(packaged 走 `extraResources`,dev 走源码) |

接入点:`convertOfficeToPdfVia`([office-convert.ts](../src/main/office-convert.ts))是两调用点合并的共享核心 —— worker 优先,execFile 兜底,`sofficeSemaphore.run` 包两路。`convertOfficeToPdf`(office-viewer)与 `encodeOfficeThumb`(thumbnail)都改成它的薄壳,顺便删掉重复的 spawn body。

## 4. 消息协议(行分隔 JSON over stdio)

**stdin → worker**:`{"reqId":"...","srcPath":"...","outPdfPath":"..."}`

**worker → stdout**:
- `{"kind":"ready","listenerPid":N}` —— boot 成功(一次)
- `{"kind":"fatal","reason":"no-uno"|"no-listener","message":"..."}` —— boot 失败
- `{"kind":"log","level":"...","message":"..."}` —— 诊断
- `{"reqId":"...","ok":true}` —— 单次转换成功
- `{"reqId":"...","ok":false,"error":{"name","message","stack"}}` —— 单次转换失败

worker 用 `python -u` 启动 + 每 `emit()` 强制 `flush=True`(管道 block-buffer 会吞掉 `ready` → host 10s 超时)。

## 5. 回退 + cooldown FSM

host 模块级状态:`unavailableUntil`、`consecutiveBootFailures`,指数退避 30s→60s→120s→…→10min。

- **boot-time fatal**(python 缺 / `import uno` 失败 / listener 起不来 / ready 超时 / 连续 `MAX_BOOT_FAILURES=3` 次崩溃)→ `markUnavailable()` 设 cooldown + `resetOfficePythonCache()`,期间 `isAvailable()` 返 false,调用方(`convertOfficeToPdfVia`)catch `WorkerUnavailableError` 走 execFile。
- **run-time error**(单文档转换失败)→ 只 reject 该请求,worker 存活(不 markUnavailable)。
- `markAvailable()` —— 首次成功转换响应后(证明全链路通)。

## 6. 打包(extraResources,非 asar)

`.py` 不是 webpack asset([webpack.config.base.ts](../.erb/configs/webpack.config.base.ts) 无 `.py` loader),不进 `dist/`,进不了 `files`。且 `child_process.spawn` **非 asar-aware**(unlike `utilityProcess.fork`)。所以脚本走 electron-builder 的 `extraResources`:

```json
"extraResources": [{ "from": "src/main/office-worker", "to": "office-worker", "filter": ["**/*.py"] }]
```

落 `<resources>/office-worker/uno-worker.py`(真实 FS)。[resolveOfficeWorkerScriptPath()](../src/main/office-worker/office-worker-script.ts) 区分:packaged → `process.resourcesPath/office-worker/uno-worker.py`;dev → 源码路径(`__dirname` 在 dev 是 `release/app/dist/main`)。

## 7. UNO gotcha(实现红线)

每条都花过真金白银的调试时间:

1. `--accept` **不支持 `port=0`**(静默不 accept)→ Python `socket.bind(('localhost',0))` 预占端口,传字面量给 soffice。
2. `UnoUrlResolver.resolve` **无限阻塞** → 30×200ms 重试循环。
3. **Windows**:`import uno` 需 `cwd = LO program/` 目录(`pyuno.pyd` DLL 搜索路径)→ host spawn 必传 `cwd`。
4. `--accept` 值(`socket,host=..,port=N;urp;`)与 resolve 串(`...;urp;StarOffice.ComponentContext`)**尾段不同**,不可互换。
5. `PropertyValue` **无 kwargs 构造** → 分别 set `.Name`/`.Value`。
6. `loadComponentFromURL` **必须传 `(Hidden, True)`**(即使 `--headless`,否则某些平台闪帧)。
7. `doc.close(False)` **必须**(否则句柄泄漏,~100 文档后 listener OOM)。
8. `storeToURL` 非 `store`(`store` 写回源 URL);路径一律 `uno.systemPathToFileUrl()`(手拼 `file:///` 在 win 反斜杠+空格下会坏)。
9. FilterName 按文档 service 选(`calc/impress/draw_pdf_Export`),`writer_pdf_Export` 兜底(LO 对未知类型按内容派发)。

## 8. 关键 race:stale-child 事件

[office-worker-host.ts](../src/main/office-worker/office-worker-host.ts) 的 exit/error/stdout handler 开头都有 `if (c !== child) return` 守卫。原因:worker 崩溃后 host 惰性重 spawn(`killIndexWorker` 或下次 `ensureSpawned`),但**旧 worker 的 exit 事件可能在新 spawn 之后才到达**。此时 `dying` 已被新 doSpawn 重置为 false,旧 exit 会误走"unexpected exit"分支,污染新 child(误 reject 新 spawnPromise + 清新 child 引用)。守卫确保只处理当前活跃 child 的事件。这对生产也成立(不只是测试 Artifact)。

## 9. 测试

[office-worker-host.test.ts](../src/main/office-worker/office-worker-host.test.ts):用 `__setSpawnSpecResolverForTest` 注入一个假 worker(小 node 脚本,讲同一 JSON 协议,由 `WHALE_FAKE_WORKER_MODE` env 控制分支)。覆盖:happy、ready 超时、fatal、per-request 错误(不 markUnavailable)、unexpected exit + 惰性重 spawn、killOfficeWorker。host 暴露 `__resetStateForTest` 保证测试间状态隔离。

[office-convert.test.ts](../src/main/office-convert.test.ts) 与 [thumbnail.test.ts](../src/main/thumbnail.test.ts) 不变 —— 它们都传 `sofficePath:fakeBin`(`options.sofficePath != null` → 跳 worker → 走 execFile shim)。

真 LibreOffice 的端到端验证(首次开档 ~2–6s + listener boot,开**不同** docx <1s;Task Manager 杀 python.exe → 自动回退 execFile;cooldown 过后重生)属手动,见 [docs/15 P3-3 验证](./15-perf-audit.md)。

## 10. 生命周期

- **惰性 spawn**:首次 office 转换触发,`ensureSpawned` memoised(`spawnPromise`)。
- **`ensureSpawned` 在 `sofficeSemaphore` 外**([convertOfficeToPdfVia](../src/main/office-convert.ts))—— 避免 2–6s boot 阻塞其他转换;只有 `request()` 在 semaphore 内(Desktop 单线程,需串行)。
- **退出**:[main.ts](../src/main/main.ts) `before-quit` 调 `killOfficeWorker()`(挨着 `killIndexWorker` / `killAllAudioTranscodes`):SIGTERM python(让其 atexit 清 listener)→ tree-kill(Windows `taskkill /t /f` 级联 soffice 孙进程)→ 防御性 `process.kill(listenerPid, SIGKILL)`(POSIX 上 python 被 SIGKILL、atexit 没跑的兜底)。
