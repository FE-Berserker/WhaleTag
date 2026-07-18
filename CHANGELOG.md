# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-07-18

### Added

- **pdf-viewer large-file streaming**: PDFs stream via `whale-file://` Range requests (pdfjs `getDocument({url, rangeChunkSize})`) instead of base64-encoding the whole file through IPC + postMessage — eliminates the O(n²) renderer string concat and ~3× peak memory on big PDFs.

### Performance

- **Office→PDF keep-alive UNO worker** (P3-3): a long-lived LibreOffice UNO listener (Python worker in a utility process) replaces per-conversion `soffice` spawns — cold start happens once, subsequent Office→PDF conversions reuse the initialized process (~200–500ms vs 2–5s per spawn). Falls back to the legacy `execFile` path when Python/UNO is unavailable.
- **dwg/ebook IPC zero-copy** (P1-4): `convertDwgToDxf` / `convertEbookToEpub` handlers return the Buffer directly (Electron IPC serializes it to `Uint8Array`) instead of allocating a fresh `ArrayBuffer` + `.set()` memcpy on every open.

### Fixed

- **UNC network share playback** (`\\server\share\...`): `whale-file://` / `whale-audio://` URL encode/decode now handles UNC paths — the server is encoded as the URL host (WHATWG `file://` semantics) and recovered on decode, instead of being dropped by Chromium's host normalization (which surfaced as a 403). ASCII server names only; a non-ASCII server is rejected with a clear error rather than a silent bad URL.

## [0.3.0] - 2026-07-16

### Added

- **Audio playback + transcoding**: in-app background music dock that keeps playing across view switches; `whale-audio://` protocol serves transcoded audio; media-player extension + dock wired through ExtensionHost. Audio conversion pipeline reuses the cache/semaphore pattern.
- **`whale-file://` HTTP Range support**: `<video>`/`<audio>`/`<img>` can scrub and load metadata without re-downloading from byte 0. Range math factored into a unit-tested `protocol-range.ts`.
- **office-viewer**: cached-thumbnail placeholder during cold LibreOffice convert + rAF scroll-synced "cur / total" page indicator.
- **i18n**: ja / ko / zh-TW locales (en / zh / zh-TW / ja / ko), with a key/plural/placeholder alignment test.

### Performance

- **Cold start**: heavy native deps (sharp / @napi-rs/canvas / exifr / jschardet / iconv-lite) lazy-loaded via `createRequire` instead of eager top-level imports; thumbnail generation bounded by a shared `Semaphore(4)` across file + folder paths.
- **Renderer**: memoized `EntryTagChips` / `ThumbIcon`; virtualized Kanban / Matrix card stacks (`react-window`); narrowed Redux selectors + stable empty-reference constants; ResizeObserver guards.
- **Main**: `importExternal` parallelized; `atomicWrite` stale-temp scan memoized per target; ODA binary probe + immutable wasm/pdf asset reads cached.

### Fixed

- `EntryContextMenu` test no longer hangs the single-process `npm test` run (final MUI Modal portal now unmounted in `after()`).
- `MapiqueView` tray-filter test updated for the Select-based filter (was ToggleButton).

## [0.1.0] - 2026-07-10

### Performance

- **Renderer bundle**: code-split the 9 perspective views via `React.lazy` (echarts / leaflet / @xyflow load on demand); initial entry 4.7 MiB → 0.94 MiB (-80%).
- **Main process**: archive extraction moved off the synchronous path (was a 60 s UI freeze); pdfjs / ffmpeg-static deferred off cold start; LibreOffice / ffmpeg / calibre / dwg2dxf spawns bounded by a shared concurrency semaphore (soffice serialized for profile-lock safety); binary-path probes memoized once per process.
- **Full-text index**: incremental rebuild (only mtime loaded into memory, not document bodies) + parallel walk/extraction; re-indexing an unchanged corpus is now near-free.
- **Re-render**: `FileListHeader` memoized; `useNow` shares a single 60 s interval across all consumers; new-tag colors assigned in one batched dispatch; `DirectoryContentContext` split into data/UI slices so a rescan no longer re-renders the tree/toolbar.
- **Directory tree**: virtualized (react-window) — expanding a large subtree no longer mounts thousands of rows.
- **EXIF cache**: batched writes (one fsync per folder vs one per image).

### Changed

- **Responsive layout**: the perspective switcher folds specialized views into an overflow menu below 720 px; below 1200 px the locations + directory-tree panels merge into a tabbed column; AI panel default width narrowed (420 → 380).

### Fixed

- AI tool-approval modal never appeared (`allowDangerouslySkipPermissions` was always on, shadowing `canUseTool`) — now scoped to `yolo` mode only.
- 8 unit-test files were silently never executed (hardcoded test list) — replaced with glob auto-discovery; a `pretest` type-check gate now catches type regressions before tests run.

## [0.0.1] - 2026-07-08

### Added

- Initial release of WhaleTag, a local-first, offline, privacy-respecting desktop file manager and tagging tool.
- **Locations**: local folder locations with read-only flags and LRU recent access tracking.
- **Browsing**: directory tree, breadcrumb navigation, and virtual scroll across list / grid / gallery views, with nine perspectives gated by a global `viewDepth`.
- **Perspectives**: list, grid, gallery, task (Kanban + Matrix + Gantt), calendar (five levels), mapique, folderviz, tag cloud, and knowledge graph.
- **Tagging**: `wsd.json` aggregate sidecar; mutex tag families (rating 1–5, workflow, quadrant, smart date ×7, period); inline tag editor; three-tier color fallback.
- **Search**: SQLite FTS5 index over filenames, tags (trigram), and full text; advanced `SearchQuery` with ten fields; saved searches.
- **Thumbnails**: image, SVG, video, PDF, Office, eBook, and font thumbnails plus folder thumbnails; 39 fallback file icons.
- **Themes**: 11 built-in themes (3 classic + 8 curated) plus system theme resolution before MUI.
- **Extensions**: 17 built-in viewers and editors; revision history; Open With support; archive viewer for 9 formats; CAD viewer with four tiers.
- **AI assistant**: embedded Claude Code CLI plus HTTP provider (Ollama / OpenAI-compatible); streaming sidebar; read-only guardrails; safeStorage key management.
- Security model: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; all file IO in the main process through `assertWithinAllowedRoot`.

### Changed

- README cleanup: removed remaining TagSpaces references.
