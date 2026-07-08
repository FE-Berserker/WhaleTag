# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
