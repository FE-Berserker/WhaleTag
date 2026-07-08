/**
 * Pure, process-agnostic mapping from a file name to a coarse "icon category".
 *
 * When a file has no thumbnail (either it is not a thumbnailable format, or the
 * thumbnail failed to generate / has no embedded cover), the UI falls back to a
 * per-category glyph + color instead of the same generic file icon for every
 * file. This module owns only the extension → category decision; the actual
 * glyph + color live in the renderer (`FileTypeIcon.tsx`), so this file stays
 * dependency-free and unit-testable.
 *
 * Categories are deliberately coarse ("by domain", not per-extension): a few
 * hundred extensions are not worth enumerating precisely, so the long tail
 * falls back to `'generic'`. See docs/06-thumbnails.md § "File-type icons".
 */
import {
  IMAGE_EXT,
  VIDEO_EXT,
  PDF_EXT,
  EBOOK_EXT,
  DRAWIO_EXT,
  HEIC_EXT,
} from './whale-meta';

export type FileIconCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'word'
  | 'excel'
  | 'ppt'
  | 'archive'
  | 'javascript'
  | 'typescript'
  | 'html'
  | 'css'
  | 'python'
  | 'java'
  | 'cpp'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'shell'
  | 'database'
  | 'matlab'
  | 'json'
  | 'notebook'
  | 'design'
  | 'email'
  | 'link'
  | 'diskimage'
  | 'code'
  | 'markdown'
  | 'text'
  | 'data'
  | 'ebook'
  | 'caj'
  | 'drawio'
  | 'excalidraw'
  | 'font'
  | 'model3d'
  | 'executable'
  | 'generic';

// Office is split by document kind (whale-meta's OFFICE_EXT lumps them together
// because they share the same thumbnail backend, but the fallback icons differ).
const WORD_EXT = new Set(['doc', 'docx', 'odt', 'rtf']);
const EXCEL_EXT = new Set(['xls', 'xlsx', 'ods', 'csv', 'tsv']);
const PPT_EXT = new Set(['ppt', 'pptx', 'odp']);

const AUDIO_EXT = new Set([
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'ogg',
  'opus',
  'wma',
  'mid',
  'midi',
  'aiff',
  'alac',
  'ape',
  'amr',
  'ac3',
  'dts',
  'mpc',
  'wv',
  'dsf',
]);

const CODE_EXT = new Set([
  'php',
  'rb',
  'swift',
  'kt',
  'kts',
  'scala',
  'dart',
  'lua',
  'r',
  'pl',
  'vue',
  'svelte',
]);

const JAVASCRIPT_EXT = new Set(['js', 'jsx', 'mjs', 'cjs']);
const TYPESCRIPT_EXT = new Set(['ts', 'tsx']);
const HTML_EXT = new Set(['html', 'htm']);
const CSS_EXT = new Set(['css', 'scss', 'sass', 'less']);
const PYTHON_EXT = new Set(['py']);
const JAVA_EXT = new Set(['java']);
const CPP_EXT = new Set(['c', 'cpp', 'cc', 'h', 'hpp']);
const CSHARP_EXT = new Set(['cs']);
const GO_EXT = new Set(['go']);
const RUST_EXT = new Set(['rs']);
const SHELL_EXT = new Set(['sh', 'bash', 'zsh', 'ps1', 'bat']);
const DATABASE_EXT = new Set(['sql']);
const MATLAB_EXT = new Set(['m', 'mat']);
const JSON_EXT = new Set(['json', 'jsonc']);
const NOTEBOOK_EXT = new Set(['ipynb']);
const DESIGN_EXT = new Set(['psd', 'ai', 'xd', 'fig', 'sketch']);
const EMAIL_EXT = new Set(['eml', 'msg']);
const LINK_EXT = new Set(['url', 'webloc', 'lnk']);
const DISKIMAGE_EXT = new Set(['iso', 'img', 'vmdk', 'vhd', 'dmg']);

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx', 'rst']);

const TEXT_EXT = new Set(['txt', 'log', 'tex', 'nfo']);

const DATA_EXT = new Set([
  'json',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'xml',
  'properties',
]);

// Icon-only: broader than whale-meta's ARCHIVE_EXT (which lists only the
// formats the archive-viewer can actually open). These extensions get an
// archive glyph regardless of whether Whale can open them.
const ARCHIVE_ICON_EXT = new Set([
  'zip',
  'tar',
  'gz',
  'tgz',
  '7z',
  'rar',
  'bz2',
  'tbz2',
  'xz',
  'txz',
  'zst',
  'lz',
  'lzma',
  'cab',
]);

const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot']);

// CAJ / CNKI / CAJViewer document formats. Whale does not open them, but they
// deserve a recognizable icon in the file list instead of the generic glyph.
const CAJ_EXT = new Set(['caj', 'kdh', 'nh', 'caa', 'teb']);

const MODEL3D_EXT = new Set([
  'stl',
  'obj',
  'glb',
  'gltf',
  'ply',
  'dxf',
  'dwg',
  'step',
  'stp',
  'iges',
  'igs',
  'brep',
  'fbx',
  '3ds',
  'blend',
  'dae',
  '3mf',
]);

const EXECUTABLE_EXT = new Set([
  'exe',
  'msi',
  'app',
  'deb',
  'rpm',
  'apk',
  'appimage',
  'bin',
  'com',
]);

/** Returns the lowercase extension of `name` (no dot); '' if none. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot (dotfile like `.gitignore`) or no dot at all => no extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Maps a file name to its icon category. Case-insensitive; files with no
 * recognized extension (including dotfiles and extension-less names) fall back
 * to `'generic'`.
 */
export function fileIconCategory(name: string): FileIconCategory {
  const ext = extOf(name);
  if (ext === '') return 'generic';

  if (IMAGE_EXT.has(ext) || HEIC_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (WORD_EXT.has(ext)) return 'word';
  if (EXCEL_EXT.has(ext)) return 'excel';
  if (PPT_EXT.has(ext)) return 'ppt';
  if (EBOOK_EXT.has(ext)) return 'ebook';
  if (CAJ_EXT.has(ext)) return 'caj';
  if (ext === 'excalidraw') return 'excalidraw';
  if (DRAWIO_EXT.has(ext)) return 'drawio';
  if (ARCHIVE_ICON_EXT.has(ext)) return 'archive';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (JAVASCRIPT_EXT.has(ext)) return 'javascript';
  if (TYPESCRIPT_EXT.has(ext)) return 'typescript';
  if (HTML_EXT.has(ext)) return 'html';
  if (CSS_EXT.has(ext)) return 'css';
  if (PYTHON_EXT.has(ext)) return 'python';
  if (JAVA_EXT.has(ext)) return 'java';
  if (CPP_EXT.has(ext)) return 'cpp';
  if (CSHARP_EXT.has(ext)) return 'csharp';
  if (GO_EXT.has(ext)) return 'go';
  if (RUST_EXT.has(ext)) return 'rust';
  if (SHELL_EXT.has(ext)) return 'shell';
  if (DATABASE_EXT.has(ext)) return 'database';
  if (MATLAB_EXT.has(ext)) return 'matlab';
  if (JSON_EXT.has(ext)) return 'json';
  if (NOTEBOOK_EXT.has(ext)) return 'notebook';
  if (DESIGN_EXT.has(ext)) return 'design';
  if (EMAIL_EXT.has(ext)) return 'email';
  if (LINK_EXT.has(ext)) return 'link';
  if (DISKIMAGE_EXT.has(ext)) return 'diskimage';
  if (CODE_EXT.has(ext)) return 'code';
  if (DATA_EXT.has(ext)) return 'data';
  if (TEXT_EXT.has(ext)) return 'text';
  if (FONT_EXT.has(ext)) return 'font';
  if (MODEL3D_EXT.has(ext)) return 'model3d';
  if (EXECUTABLE_EXT.has(ext)) return 'executable';

  return 'generic';
}
