/**
 * `.whale/` metadata layout — Whale's equivalent of TagSpaces' `.ts/` folder,
 * but a fresh design (filenames, schema). Foundation for the tagging & indexing
 * slices; only the constants are consumed so far.
 *
 *   folder/
 *   ├── my-file.txt
 *   └── .whale/
 *       ├── wsm.json     # folder metadata (tags/color/description/perspective)
 *       ├── wsd.json     # aggregated per-file sidecar (whole dir's tags/desc/color)
 *       ├── wsi.json     # search index (relative-path entries)
 *       ├── wsft.jsonl   # fulltext index (one record per line)
 *       ├── wst.jpg      # folder thumbnail
 *       ├── wsb.jpg      # folder background
 *       └── thumbs/
 *           └── my-file.txt.jpg    # file thumbnail
 */

/** Metadata folder name. */
export const META_DIR = '.whale';

export const FOLDER_META_FILE = 'wsm.json';
export const FOLDER_SIDECAR_FILE = 'wsd.json';
export const FOLDER_INDEX_FILE = 'wsi.json';
export const FOLDER_FULLTEXT_FILE = 'wsft.jsonl';
export const FOLDER_THUMB_FILE = 'wst.jpg';
export const FOLDER_BACKGROUND_FILE = 'wsb.jpg';

/** Subdirectory of `.whale/` holding per-file image thumbnails (`.jpg`). */
export const THUMBS_DIR = 'thumbs';

/** Subdirectory of `.whale/` holding transcoded audio caches (`.opus`).
 * Media-player can't play APE/WMA/etc natively, so the main process transcodes
 * them to Opus once and caches the result here (mirror of THUMBS_DIR). */
export const TRANSCODES_DIR = 'transcodes';

/** Subdirectory of `.whale/` holding recursive-listing caches (`d<depth>.json`),
 * one per (folder, depth). The recursive stat-walk (viewDepth > 1) is expensive
 * on big trees; this caches the flat `DirEntry[]` so repeat visits / depth
 * tweaks are instant. Invalidation: folder-mtime guard on read + fs-op hooks
 * (see src/main/recursive-cache.ts). */
export const INDEX_RECURSIVE_DIR = 'index-recursive';

/** Extensions Whale generates image thumbnails for (lowercase, no dot).
 * SVG is included so the host treats it as an image for drag / image-viewer
 * dispatch — but its thumbnail kind is `'svg'` (separate from the raster
 * pipeline), see `thumbKindOf` and `encodeSvgThumb` in `main/thumbnail.ts`. */
export const IMAGE_EXT = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'avif',
  'tiff',
  'tif',
  'ico',
  'svg',
]);

/** Extensions Whale generates video (first-frame) thumbnails for. */
export const VIDEO_EXT = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'm4v',
  'avi',
  '3gp',
  'ogv',
  'wmv',
  'flv',
]);

/** Extensions Whale generates PDF (first-page) thumbnails for. */
export const PDF_EXT = new Set(['pdf']);

/** Extensions Whale generates Office (first-page) thumbnails for. */
export const OFFICE_EXT = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
]);

/**
 * Extensions Whale generates ebook (embedded cover) thumbnails for. CBR is
 * excluded — it is RAR-compressed and would need a RAR decoder (CBZ is a plain
 * ZIP and is supported).
 */
export const EBOOK_EXT = new Set(['epub', 'mobi', 'azw', 'azw3', 'fb2', 'cbz']);

/**
 * drawio (diagrams.net) diagram files. `.drawio` and `.dio` are identical XML
 * (drawio shortens the extension to save bytes); the editor extension
 * (`src/extensions/drawio-editor/`) handles both, and the thumbnail pipeline
 * treats them the same way (render the first `<diagram>` in the mxfile).
 */
export const DRAWIO_EXT = new Set(['drawio', 'dio']);

/**
 * Archive (compressed-container) extensions the archive-viewer extension can
 * open. Phase 2+ supports `.zip`/`.tar`/`.tgz`/`.gz` via `fflate` and
 * `.tbz2`/`.txz`/`.bz2`/`.xz`/`.7z` via a main-process `7za` decoder. All
 * members must also live in `BINARY_EXT` so the host treats the archive as
 * binary for dispatch.
 */
export const ARCHIVE_EXT = new Set([
  'zip',
  'tar',
  'tgz',
  'tbz2',
  'txz',
  'gz',
  'bz2',
  'xz',
  '7z',
]);

/**
 * CAD / 3D exchange extensions the `cad-viewer` extension can open.
 *  - Tier 0 (Three.js native loaders, in-iframe): STL / OBJ / GLB / GLTF / PLY.
 *  - Tier 1 (dxf-parser, in-iframe): DXF.
 *  - Tier 1.5 (occt-import-js wasm, in-iframe): STEP / STP / IGES / IGS / BREP.
 *  - Tier 2 (external CLI converter → DXF): DWG (path-based; the host reads
 *    the DWG and shells out to LibreDWG `dwg2dxf` / ODA File Converter).
 * All members must also live in `BINARY_EXT` so the host pushes the bytes as
 * base64 to the extension (DXF is ASCII text but goes through base64 for a
 * uniform single code path, same as OBJ).
 */
export const CAD_EXT = new Set([
  'stl',
  'obj',
  'glb',
  'gltf',
  'ply',
  'dxf',
  'step',
  'stp',
  'iges',
  'igs',
  'brep',
  'dwg',
]);

/**
 * HEIC / HEIF extensions (Apple's default photo format, HEVC/H.265-coded) the
 * `heic-viewer` extension can decode (via libheif-js wasm). Chromium cannot
 * render these natively and sharp's bundled libvips lacks libde265, so HEIC is
 * **intentionally NOT in `IMAGE_EXT`**: `IMAGE_EXT` drives both sharp
 * thumbnails and the MediaLightbox double-click route, neither of which can
 * handle HEIC. Keeping it separate routes double-clicks through
 * `selectExtension` → heic-viewer. Members must also live in `BINARY_EXT` so
 * the host pushes the bytes as base64.
 */
export const HEIC_EXT = new Set(['heic', 'heif']);

/**
 * Audio extensions media-player CANNOT play natively (Chromium `<audio>` lacks
 * the decoders) but ffmpeg can transcode to Opus. The main process transcodes
 * these on open (cached under `.whale/transcodes/`) and feeds the Opus bytes
 * back to media-player. `.dff` (DSDIFF) is excluded — ffmpeg-static has no
 * demuxer for it; `.mid`/`.midi` need a soundfont synth, not a transcode.
 * Members must also live in `BINARY_EXT` (the host base64-injects the source
 * bytes — though media-player ignores them and sends the path back for the
 * host to read; kept binary so dispatch matches media-player).
 */
export const AUDIO_TRANSCODE_EXT = new Set([
  'ape',
  'wma',
  'aiff',
  'amr',
  'ac3',
  'dts',
  'mpc',
  'wv',
  'dsf',
]);

/**
 * Font extensions the `font-viewer` extension can render. Chromium's FontFace
 * API loads these directly from bytes (TrueType / OpenType / WOFF / WOFF2).
 * `.eot` is excluded — it's a legacy IE format Chromium can't parse. Members
 * must also live in `BINARY_EXT` so the host pushes the bytes as base64.
 */
export const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2']);

/** Returns the lowercase extension of `name` (no dot); '' if none. */
function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

/** True if `name`'s extension is a thumbnailable still-image format. */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.has(extOf(name));
}

/** True if `name`'s extension is a thumbnailable video format. */
export function isVideoFile(name: string): boolean {
  return VIDEO_EXT.has(extOf(name));
}

/** True if `name`'s extension is a thumbnailable PDF format. */
export function isPdfFile(name: string): boolean {
  return PDF_EXT.has(extOf(name));
}

/** True if `name`'s extension is a thumbnailable Office format. */
export function isOfficeFile(name: string): boolean {
  return OFFICE_EXT.has(extOf(name));
}

/** True if `name`'s extension is a thumbnailable ebook format. */
export function isEbookFile(name: string): boolean {
  return EBOOK_EXT.has(extOf(name));
}

/** True if `name`'s extension is a drawio (diagrams.net) file. */
export function isDrawioFile(name: string): boolean {
  return DRAWIO_EXT.has(extOf(name));
}

/** True if `name`'s extension is an archive the viewer can open. */
export function isArchiveFile(name: string): boolean {
  return ARCHIVE_EXT.has(extOf(name));
}

/** True if `name`'s extension is a CAD / 3D format the viewer can open. */
export function isCadFile(name: string): boolean {
  return CAD_EXT.has(extOf(name));
}

/** True if `name`'s extension is a HEIC/HEIF image the viewer can decode. */
export function isHeicFile(name: string): boolean {
  return HEIC_EXT.has(extOf(name));
}

/** True if `name`'s extension is audio media-player needs transcoded to play. */
export function isAudioTranscodeFile(name: string): boolean {
  return AUDIO_TRANSCODE_EXT.has(extOf(name));
}

/** True if `name`'s extension is a font the viewer can render. */
export function isFontFile(name: string): boolean {
  return FONT_EXT.has(extOf(name));
}

/** The kind of thumbnail Whale can produce for `name`, or null if none. */
export type ThumbKind =
  | 'image'
  | 'svg'
  | 'video'
  | 'pdf'
  | 'office'
  | 'ebook'
  | 'font';
export function thumbKindOf(name: string): ThumbKind | null {
  const ext = extOf(name);
  // SVG gets a dedicated kind — it's vector input that sharp's librsvg renders
  // via `encodeSvgThumb` (with density oversample + silent fallback on malformed
  // input), separate from the raster path. We check it BEFORE IMAGE_EXT so the
  // dedicated pipeline wins. `svg` stays in IMAGE_EXT so `isImageFile('x.svg')`
  // keeps returning true (image-viewer drag detection, image-viewer dispatch).
  if (ext === 'svg') return 'svg';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (EBOOK_EXT.has(ext)) return 'ebook';
  if (FONT_EXT.has(ext)) return 'font';
  // Note: .excalidraw and .drawio / .dio used to have a thumbnail renderer, but
  // the resulting previews were too faint at small sizes. They now render as
  // branded app icons via FileTypeIcon.
  return null;
}

/** True if Whale can generate a thumbnail for `name` (any supported kind). */
export function isThumbnailable(name: string): boolean {
  return thumbKindOf(name) !== null;
}

/**
 * Lowercase extensions that should be read as binary (base64) for extensions.
 *
 * Intentionally EXCLUDES text formats extensions consume as raw strings:
 *  - `drawio` / `dio` — mxfile is UTF-8 XML (H.17 bug #1: including these made
 *    the host push the file as base64, drawio-editor then handed the base64
 *    string straight to `bridge.loadXml`, drawio's `parseDiagramNode` choked
 *    on a string that didn't start with `<` → "Start tag expected, '<' not
 *    found" / "非绘图文件"). drawio files are read as text by the main-process
 *    thumbnail pipeline (`fs.readFile(srcPath, 'utf8')`) anyway, so the
 *    extension host doesn't need to be involved.
 *  - `excalidraw` / `md` / `html` / `txt` / `json` / `csv` / etc. — same
 *    reason: extensions handle these as raw UTF-8 strings.
 *
 * Regression guard: `whale-meta.test.ts` asserts `drawio` and `dio` are NOT
 * in this set. If you add a text-format extension, decide whether it consumes
 * raw strings (don't add here) or binary bytes (add here) before extending.
 */
export const BINARY_EXT = new Set([
  ...IMAGE_EXT,
  ...VIDEO_EXT,
  ...PDF_EXT,
  ...OFFICE_EXT,
  ...EBOOK_EXT,
  // ...DRAWIO_EXT,  // intentionally excluded — see block comment above
  ...ARCHIVE_EXT,
  ...CAD_EXT,
  ...HEIC_EXT,
  ...AUDIO_TRANSCODE_EXT,
  ...FONT_EXT,
  'mp3',
  'ogg',
  'opus',
  'wav',
  'flac',
  'aac',
  'm4a',
]);

/** Audio extensions Chromium's `<audio>` can play natively (mirrors the
 *  literal list inside `BINARY_EXT` below; extracted so callers can answer
 *  "is this an audio file?" without re-spelling the extension list).
 *  Transcode-only formats (APE/WMA/AIFF/...) live in `AUDIO_TRANSCODE_EXT`
 *  and require ffmpeg — see `isAudioTranscodeFile`. */
export const AUDIO_NATIVE_EXT = new Set([
  'mp3',
  'ogg',
  'opus',
  'wav',
  'flac',
  'aac',
  'm4a',
]);

/** True if `ext` (lowercase, no dot) is a binary format that extensions receive as base64. */
export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXT.has(ext.toLowerCase());
}

/** True if `name`'s extension is an audio file media-player can play
 *  (native or after ffmpeg transcode). Excludes video. */
export function isAudioFile(name: string): boolean {
  const ext = extOf(name);
  return AUDIO_NATIVE_EXT.has(ext) || AUDIO_TRANSCODE_EXT.has(ext);
}

/** True if `name` starts with a dot and should be treated as hidden. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

/** `wsd.json` schema version — bump if the on-disk shape changes. */
export const SIDECAR_VERSION = 1;

/** Tag delimiters for embedding tags in filenames: name[tag1 tag2].ext */
export const TAG_OPEN = '[';
export const TAG_CLOSE = ']';
export const TAG_SEPARATOR = ' ';

/** Storage backend for a location. More types (s3, webdav) added in Phase 5. */
export type LocationType = 'local';

/** Per-file metadata carried in the directory's `wsd.json` (keyed by basename).
 *
 * Note: there is intentionally no `lat` / `lng` field here. A file's location is
 * stored as a `geo:lat,lng` tag inside the `tags` array — single source of
 * truth, plays nicely with the tag library, file tray, and tag-based filters
 * without a parallel cache. Old sidecars (pre-2026-06-30) that still carry
 * `lat`/`lng` fields are migrated on read by `TagMetaContextProvider`.
 */
export interface SidecarMeta {
  tags?: string[];
  color?: string;
  description?: string;
  created?: string;
  modified?: string;
}

/**
 * Aggregated sidecar store (`.whale/wsd.json`): every tagged/described file in
 * the directory, keyed by basename, in one JSON file (instead of one file per
 * file). Files with no tags/color/description are absent (sparse), so a mostly-
 * untagged directory produces a tiny — or no — sidecar. See plan §6.6.
 */
export interface AggregatedSidecar {
  version: number;
  files: Record<string, SidecarMeta>;
}

/** File-area layout: a flat list (rows), a thumbnail grid (cards), a media gallery, a task board (Kanban + Matrix sub-switch), a calendar, a map, a directory visualization, a tag cloud, or a tag↔file knowledge graph. */
export type ViewMode =
  | 'list'
  | 'grid'
  | 'gallery'
  | 'task'
  | 'calendar'
  | 'mapique'
  | 'folderviz'
  | 'tagcloud'
  | 'mindmap' // legacy (H.19 rename — migrate to 'knowledge-graph' at read time)
  | 'knowledge-graph';

/**
 * One-time forward migration for renamed ViewMode literals. Anything written
 * to `.whale/wsm.json` under the old `'mindmap'` literal is translated to the
 * new `'knowledge-graph'` value on read so users on older Whale versions
 * don't see their saved perspective vanish after upgrading. Unknown values
 * (corruption, future modes we don't recognize yet) pass through as
 * `undefined` so the caller can fall back to the global default rather than
 * render against a phantom mode.
 *
 * H.29: `'kanban'` and `'matrix'` were absorbed into the `'task'` perspective
 * (which exposes them as a sub-switch). We accept the old literals so
 * previously-saved folders still open in their intended layout — kanban →
 * task, matrix → task — instead of silently falling back to the global
 * default.
 */
export function migrateViewMode(value: string | undefined | null): ViewMode | undefined {
  if (!value) return undefined;
  if (value === 'mindmap') return 'knowledge-graph';
  if (value === 'kanban' || value === 'matrix') return 'task';
  // Trust the value if it's a known current literal; otherwise drop it.
  const known: ReadonlySet<ViewMode> = new Set([
    'list', 'grid', 'gallery', 'task', 'calendar',
    'mapique', 'folderviz', 'tagcloud', 'knowledge-graph',
  ]);
  return known.has(value as ViewMode) ? (value as ViewMode) : undefined;
}

/** Per-folder metadata (`.whale/wsm.json`). */
export interface FolderMeta {
  tags?: string[];
  color?: string;
  description?: string;
  /** Preferred view for this folder; absent → fall back to the global default. */
  perspective?: ViewMode;
  /** Grid cell edge length in px (grid view only); absent → global default. */
  entrySize?: number;
}
