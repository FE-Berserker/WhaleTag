
← 返回 [plan.md](../plan.md)

# 20 · 扩展文件链接相对路径(drawio + excalidraw)

> **2026-07-29 规划并实现**的 feature 方案追踪(plan.md §F「不做未来计划」的**经确认例外**,同 [docs/15](./15-perf-audit.md)/[16](./16-cross-platform.md)/[19](./19-code-audit.md))。本文记录**方案设计与实现路径**;POC 结论见 §8,进度见 §12,评估不做的移到文末「开放问题」。
>
> **状态:✅ 已实现(2026-07-29),单元测试覆盖双向 round-trip。** 剩 [§12](#12-状态追踪) 末项「真机端到端 + 存量回归」(需 `npm run dev` 手测:拖文件入画布 → 移动目录 → 重开,链接不断)。

---

## 1. 背景与目标

drawio / excalidraw 扩展支持把目录树里的文件/文件夹**拖进画布**,生成一个带缩略图的单元格,**链接回源文件**(点击在 Whale/OS 打开)。

- 现状:链接以**绝对路径**存盘(drawio `file:///C:/...` URL;excalidraw 绝对路径字符串)。
- 问题:**整体迁移目录**(移动 / 复制 / 发给别人)后,绝对路径失效,链接全断。

**目标**:磁盘上存**相对路径**(相对 `.drawio`/`.excalidraw` 所在目录),目录整体迁移后链接不断。**运行时行为(点击打开)零变化**。

## 2. 现状(link 机制)

| 扩展 | link 存储形式 | 点击转发 | host 处理 |
|---|---|---|---|
| drawio | `<UserObject link="file:///C:/...">`([drop-xml.ts:77 toFileUrl](../src/extensions/drawio-editor/drop-xml.ts#L77)) | drawio `openLink` 事件 → [app.tsx:70 handleOpenLink](../src/extensions/drawio-editor/app.tsx#L70) | `openLinkExternally` → `file://` 走 `shell.openPath` |
| excalidraw | image element `link: "<绝对路径>"`([app.tsx:155](../src/extensions/excalidraw-editor/app.tsx#L155)) | excalidraw `onLinkOpen` → [app.tsx:256-266](../src/extensions/excalidraw-editor/app.tsx#L256-L266)(非 `http(s):` 才转发) | 同上 `openLinkExternally` |

两者点击链都**已走 host**(`openLinkExternally`),机制通。

## 3. 硬约束(为什么 link 可行、图片不行)

- **link 是纯字符串**,编辑器不"加载"它(只点击时转发 URL)→ **无 CSP / CORS / fetch 问题**。
- 对比:图片相对路径不可行 —— drawio 用 fetch 加载图片([drop-xml.ts:46-50](../src/extensions/drawio-editor/drop-xml.ts#L46-L50) `mxSvgCanvas2D.image GET`),而 `whale-file://` 被跨源 fetch CORS 硬挡([extension-types.ts:265](../src/shared/extension-types.ts#L265))、iframe CSP `img-src` 也不含 `whale-file://`([index.html:7](../src/extensions/drawio-editor/index.html#L7))。图片只能 data URL 嵌入(现状)。
- **本方案只做"文件链接",不做图片相对路径**(图片仍是 data URL 嵌入,见 §11 开放问题)。

## 4. 方案总览:存相对 / 加载重写绝对 / 保存还原(双向)

磁盘存相对路径;**加载时**重写成与现状一致的绝对形式(drawio `file://`、excalidraw 绝对路径)喂给编辑器/host;**保存时**把绝对 link 还原成相对(若指向文件目录内)。**host 的 `openLinkExternally` 与点击逻辑零改动**(运行时永远收到绝对)。

```
磁盘:  <UserObject link="./sub/foo.png">          (.drawio)
加载:  decode → link "./sub/foo.png" → file://<abs> → loadXml
运行:  drawio 点击 → openLink(file://<abs>) → host openPath   (不变)
保存:  getXml(compressed) → decode → link file://<abs> → "./sub/foo.png" → 存盘
```

## 5. drawio 实现(compressed XML round-trip)

**关键事实**([drawio-bridge.ts:175-184, 211](../src/extensions/drawio-editor/drawio-bridge.ts#L175-L184)):
- `getXml()` 返回 **compressed wire format**(`<mxfile><diagram>base64(deflateRaw(uri-enc))</diagram></mxfile>`)。
- `loadXml()` 接受 **raw uncompressed**(`<mxGraphModel>`)。
- 已有 `decodeDrawioDiagram`([drop-xml.ts:361](../src/extensions/drawio-editor/drop-xml.ts#L361));**无** `encodeDrawioDiagram`([drop-xml.ts:407 注释](../src/extensions/drawio-editor/drop-xml.ts#L407))。

**加载**(改 [app.tsx:94-102](../src/extensions/drawio-editor/app.tsx#L94-L102) 的 load effect):
1. `file.content` → `decodeDrawioDiagram`(compressed→raw;raw 则 no-op,见 [:368](../src/extensions/drawio-editor/drop-xml.ts#L368))。
2. DOMParser 扫描所有 `<UserObject link="<相对>">`,相对路径 → `toFileUrl(resolveAbsolute(rel, dirname(file.path)))`。
3. `loadXml(改后 raw)`。

**保存**(在 [app.tsx:112-126](../src/extensions/drawio-editor/app.tsx#L112-L126) 的 save effect 里):
1. `getXml()` → compressed → `decodeDrawioDiagram` → raw。
2. DOMParser 扫描 `link="file://..."`,若指向 `dirname(file.path)` 内 → `toRelative(abs, baseDir)` 还原相对;目录外保留绝对。
3. 存盘(格式见 §8 POC)。

**难点 / 待 POC**:
- **存盘格式(POC 已决:存 raw)**:原保存的是 compressed(`save(getXml())`)。改 link 后**直接存 decode 出的 raw**,不补 `encodeDrawioDiagram`。理由:磁盘格式只被我们自己的 `decodeDrawioDiagram` 消费(drawio 从不直接读磁盘文件,只收 `loadXml`;`decompressSync` 格式无关,自往返无虞),而存 raw 更兼容外部 drawio(原生读未压缩 `.drawio`),且与 [useNewDrawio](../src/renderer/hooks/useNewDrawio.ts) 的 `EMPTY_DRAWIO`(本就是 raw)格式一致。**硬约束**([useNewDrawio 注释](../src/renderer/hooks/useNewDrawio.ts#L13-L24)):drawio 的 loader 仅在 `<diagram>` **有文本内容**时才 decompress;raw 形式要求 `<diagram>` 紧跟 `<mxGraphModel>` 且**中间无空白**。`decodeDrawioDiagram` 先 `removeChild` 清空再 `appendChild` mxGraphModel、`XMLSerializer` 不插空白 → 不变量保持(与线上 `insertLinkedThumbnail` 的 decode→loadXml 同路径,已验证)。
- DOMParser 改 `link` 属性后 drawio 正常 load —— 已知 image 那套就是这么 round-trip(`appendSnippetToDiagram`),单元测试覆盖(`drop-xml.test.ts` 的 `rewriteDrawioLinks*` + 稳定 round-trip 用例)。
- link 可能出现在 `<mxCell>` 而非 `<UserObject>`(drawio 序列化变量,见 [drop-xml.ts:16-20](../src/extensions/drawio-editor/drop-xml.ts#L16-L20))→ 扫描按属性 `[link]` 覆盖两种(测试含直接 `<mxCell link=>` 用例)。

## 6. excalidraw 实现(JSON link 重写)

明文 JSON,无压缩,**比 drawio 简单**。

- **加载**(在 [app.tsx:66-84 applyScene](../src/extensions/excalidraw-editor/app.tsx#L66-L84) 里):`restore` 后遍历 image 元素,`link` 若为相对 → `resolveAbsolute(rel, dirname(path))`。
- **保存**(在 [app.tsx:86-96 doSave](../src/extensions/excalidraw-editor/app.tsx#L86-L96) 里):`computeJson()` 序列化后扫描 `"link": "<绝对>"` 目录内 → `toRelative`;或序列化前改 scene 元素 `.link`。

## 7. 共享路径工具(纯函数,新建 `extensions/shared/relpath.ts`)

```ts
/** 绝对 → 相对(若 target 在 baseDir 内,正斜杠;否则 null = 保留绝对)。 */
export function toRelative(absoluteTarget: string, baseDir: string): string | null;
/** 相对 → 绝对(相对 baseDir 解析;已是绝对则原样)。 */
export function resolveAbsolute(relOrAbs: string, baseDir: string): string;
```

- **基准**:`dirname(file.path)`(当前 `.drawio`/`.excalidraw` 目录)。
- **跨平台**:相对路径统一正斜杠 `./sub/foo.png`;Windows 盘符路径归一(`C:\` ↔ `C:/`)。
- **目录外**:返回 null → 保留绝对(默认策略,见 §11)。
- 配套单测:平台分支、`..` 逃逸、UNC、CJK、已经是相对/绝对的输入。

## 8. POC(结论)

POC 四项全部用**代码分析 + 既有测试**闭环回答,无需 GUI 手测:

- [x] **drawio `getXml()` 输出格式 = compressed**。bridge 变量命名 `compressed` + 直接喂 `decodeDrawioDiagram`(atob→inflate);既有 [drop-xml.test.ts](../src/extensions/drawio-editor/drop-xml.test.ts) `decodeDrawioDiagram` 用例用真实 fflate 压缩 payload 验过解码。
- [x] **存 raw,drawio 下次加载正常**。`loadXml` 接受 raw 已被线上 `insertLinkedThumbnail`(`decode→appendSnippet→loadXml(raw)`)证明;`decodeDrawioDiagram` 对 raw 是 no-op(测试 `returns the payload unchanged if already uncompressed`)。**决定存 raw,不实现 `encodeDrawioDiagram`**(理由见 §5)。
- [x] **DOMParser 改 `<UserObject link>` 后 drawio 加载 + 点击转发**。运行时 link 恒为绝对 `file://`(加载时 rel→abs 重写),drawio 看到的与改动前逐字节一致 → 点击转发 `openLink`→host 零变化。DOMParser 改写→loadXml 同 `appendSnippetToDiagram` 路径(已验证),并由 `rewriteDrawioLinks*` 单测 + 稳定 round-trip 用例锁定。
- [x] **excalidraw JSON `link` 字段 = `element.link`**。insert 写([app.tsx:155](../src/extensions/excalidraw-editor/app.tsx#L155))、onLinkOpen 读([:259](../src/extensions/excalidraw-editor/app.tsx#L259));`serializeAsJSON` 产出 `{elements:[…]}`,扫描 `elements[].link` 即可(见 [excalidraw-links.ts](../src/extensions/excalidraw-editor/excalidraw-links.ts) + 单测)。

## 9. 工作量

| 项 | 估算 |
|---|---|
| 共享 `relpath.ts` + 单测 | ~0.5 天 |
| drawio compressed round-trip(含 POC + 可能的 encode helper) | ~1 天 |
| excalidraw JSON link 重写 | ~0.5 天 |
| 端到端 + 存量回归 | ~0.5 天 |
| **合计** | **~1.5–2 天** |

## 10. 存量迁移(渐进)

- 老文件 link 已是绝对:加载时不改(运行时绝对),**下次保存**时若在目录内自动转相对。
- 用户无需一次性转换;打开 → 保存即迁移。
- 跨平台迁移:相对路径正斜杠,Win/Mac/Linux 通用。

## 11. 开放问题

- **目录外文件策略**(默认:保留绝对 `file://`)。是否允许 `../` 相对?风险:多级 `../` 不可读、迁出后断。→ 默认保留绝对,除非明确要 `../`。
- **图片相对路径**:本方案不做(§3 约束)。若未来要,需加载时把相对路径图片读成 data URL 嵌入 + 保存还原未变者(双向,比 link 复杂得多)。
- **link 出现在 drawio 非 `<UserObject>` 位置**(直接 `<mxCell link=>`):扫描覆盖测试。
- **excalidraw `element.link` 的 host 处理**(✅ 已确认,无需改 host):[ExtensionHost.tsx:684-693](../src/renderer/components/ExtensionHost.tsx#L684-L693) 的 `openLinkExternally` 对非 `http(s):` 一律走 `ipcApi.openNative` → `shell.openPath`,**裸路径与 `file://` 都已支持**。本方案运行时 link 形式不变(drawio 绝对 `file://`、excalidraw 绝对裸路径),host 零改动。

## 12. 状态追踪

- [x] POC §8 四项(代码分析 + 既有测试闭环)
- [x] 共享 [`extensions/shared/relpath.ts`](../src/extensions/shared/relpath.ts) + [`relpath.test.ts`](../src/extensions/shared/relpath.test.ts)(平台分支 / 大小写 / UNC / CJK / `..` 拒绝 / round-trip)
- [x] drawio 加载重写(rel→abs)+ 保存还原(abs→rel,存 raw):[`drop-xml.ts`](../src/extensions/drawio-editor/drop-xml.ts) `rewriteDrawioLinksToAbsolute/Relative` + [`app.tsx`](../src/extensions/drawio-editor/app.tsx) load/save effect + 单测
- [x] excalidraw 加载重写 + 保存还原:[`excalidraw-links.ts`](../src/extensions/excalidraw-editor/excalidraw-links.ts) + [`app.tsx`](../src/extensions/excalidraw-editor/app.tsx) `applyScene`/`doSave` + 单测
- [ ] 真机端到端 + 存量回归(`npm run dev`:拖文件入 drawio/excalidraw → 存盘看 link 变 `./…` → 移动整个目录 → 重开 → 点击缩略图仍能打开;老绝对链接文件打开→保存后自动迁移)
- [ ] 回写 [docs/07-extensions.md](./07-extensions.md) 现状说明(link 相对路径已支持)—— 待真机验证后补
