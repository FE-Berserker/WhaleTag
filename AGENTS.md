# AGENTS.md — 子智能体工作约定

> 所有子智能体（architect / code-reviewer / debugger / test-runner / lint-guard / security-auditor / docs-writer / commit-helper / judge）在本仓库工作时遵循本文件。
> 项目原则、架构细节、已知坑的**权威来源是 [plan.md](plan.md) 与 [docs/](docs/) 目录**，本文件只固化"动手时必须知道的操作约定"。

## 项目一句话

Whale：本地优先、离线、隐私安全的 Electron 文件管理与打标应用（Electron + React + TypeScript，MIT 开源）。三进程模型：Main（全部 FS IO / SQLite 索引 / 缩略图 / 扩展转换 / AI 子进程）→ Preload（`window.whale` 唯一桥）→ Renderer（React）。

## 常用命令

| 命令 | 作用 | 备注 |
|---|---|---|
| `npm run dev` | 开发模式（webpack watch + electronmon） | 环境残留 `ELECTRON_RUN_AS_NODE` 会让 Electron 退化成 Node，见 plan.md §C.1 |
| `npm run lint` | ESLint 全量（js/jsx/ts/tsx） | |
| `npm run type-check` | `tsc --noEmit` | **注意脚本名是 `type-check` 不是 `typecheck`** |
| `npm test` | 全量测试 | `pretest` 自动先跑 type-check；测试失败先看是类型错还是断言错 |
| `npm run build` | 产出 main + extensions + renderer | |
| `npm run package:win` | Windows 打包（electron-builder） | 打包排坑见 docs/14 |

**本仓库没有 CI**——`lint` / `type-check` / `test` 就是全部质量门禁，任何代码改动在宣布完成前必须三件套通过（由 test-runner / lint-guard 执行）。

## 测试约定

- 框架：Node 内建 `node:test`（`import { describe, it } from 'node:test'`），断言用 `node:assert/strict`，经 Electron `--test` 执行。
- **共置**：测试文件 `foo.test.ts` 放在被测文件旁边，不集中建 tests/ 目录。
- **自动发现**：`scripts/run-tests.cjs` 扫描 `src/` 与 `scripts/` 下所有 `*.test.ts(x)`，新增测试文件**无需登记清单**（旧的手工清单曾漏 8 个文件，勿走回头路）。
- 现状约 122 个测试文件，覆盖 main/renderer/shared/extensions 四层。

## 目录职责

- `src/main/`：Electron 主进程——FS IO、SQLite FTS5 索引（utilityProcess worker）、缩略图 worker、自定义协议（`whale-file/audio/extension`）、IPC handlers、AI CLI 子进程、原子写盘。
- `src/renderer/`：React 渲染层——components、redux、domain（**纯前端域逻辑放这里**）、hooks、services、theme、locales（i18n 5 语言）。
- `src/shared/`：main + renderer 双方引用的契约层（ipc-types、tags、extension-types 等类型与纯函数）。
- `src/extensions/`：8 个内置扩展查看器/编辑器（双层 iframe 拓扑），由 `scripts/build-extensions.js` 独立构建。

## 红线（security-auditor / 所有改代码的智能体）

1. **数据神圣**：任何 IO/删除操作 merge 优先于 wipe；错误必须上抛，绝不静默吞。
2. 路径必须过 `fs.realpathSync` 校验才能进 `setAllowedRoots`（symlink 逃逸，plan.md §C.3）。
3. 安全三件套不动摇：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层只经 `window.whale` 桥。
4. 持久化写盘必须 `writeFileSync(.tmp) + renameSync` 原子落盘（redux-persist 的 close-fallback 不能丢数据）。
5. 元数据只写 `.whale/` sidecar（JSON），**不改动用户文件名与文件夹结构**。

## 文档维护约定（docs-writer 重点）

- 编号文档 `docs/0X-*.md` 只描述**当前代码行为**，不写历史变更；**改代码就同步改对应模块文档**。
- **不动 plan.md**——它是纯导航页，明确"不做未来计划"；roadmap 落到对应 docs 的"已知取舍/遗留"章节。
- 新增模块文档：头部加 `← 返回 [plan.md](../plan.md)`，并登记进 plan.md 索引表（这是唯一允许改 plan.md 的场景）。
- 跨文档引用格式：plan.md → `./docs/0X.md`；docs 互引 → `./0X.md`；docs 指源码 → `../src/...`。
- 审计追踪类文档（docs/15、19、20）遵守"完成即压缩成 ✅ 1-2 行"的闭环约定。
- `CHANGELOG.md`：Keep a Changelog 风格，**中文段落 + 英文段落成对**，按 Added/Fixed 分节；发版时补齐。**版本号要同时改 `package.json` 和 `release/app/package.json` 两处**。

## 提交约定（commit-helper 重点）

- Conventional Commits，scope 用模块名，描述用英文：如 `feat(extensions): requestListDirectory + requestDeleteFiles RPC`、`fix(office-viewer): timeout the three pending request Maps`、`feat(drawio,excalidraw): relative file links for diagram embeds`、`release: 0.4.5`。
- commit-helper **只生成提交信息，从不执行 git commit**；实际提交由用户决定。

## 已知坑速查（进新模块前必读）

权威列表在 [plan.md §C](plan.md) 与 [docs/09-known-issues.md](docs/09-known-issues.md)，最常踩的六条：

1. `unset ELECTRON_RUN_AS_NODE` 是 dev 启动硬约束。
2. `autoMergeLevel1` reconciler 比较引用——返回新对象的纯函数会跳过 slice rehydration。
3. 路径须过 `fs.realpathSync` 才能进 `setAllowedRoots`。
4. `'system'` 主题模式绝不能直接流入 `createTheme.palette.mode`。
5. drawio/excalidraw 双层 iframe：扩展协议 + CSP + 协议注册三件套缺一不可。
6. redux-persist 写盘必须 tmp+rename 原子操作。

## 平台备注

- 开发机 Windows + Git Bash；仓库文本文件为 LF，勿引入 CRLF。
- 国内网络环境：打包/AI 依赖下载有镜像与离线方案，排坑记录在 docs/14。
