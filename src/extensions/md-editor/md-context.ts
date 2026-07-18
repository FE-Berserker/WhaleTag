/**
 * md-editor — shared mutable state + cached DOM refs, extracted so the
 * per-feature modules (md-fold / md-scroll / md-toc / md-statusbar /
 * md-theme / md-preview) can read/write the same editor state without
 * each importing all of index.ts.
 *
 * `ctx` holds the mutable editor state (view, current path, dirty flag,
 * schedulers, CodeMirror compartments, scroll/TOC/timer bits, font/wrap/
 * theme prefs). `dom` holds the cached DOM element refs (one
 * getElementById per element at module load). Both are singletons — md-editor
 * has one iframe per open file. Object properties are mutable, so any module
 * can do `ctx.view = ...` / `ctx.isDirty = true` and the others see it
 * (no live-binding-only-read pitfalls like with `export let`).
 *
 * Font/wrap/theme localStorage helpers + preset data live here too — they're
 * pure and used to seed `ctx`.
 */
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import {
  createPreviewScheduler,
  createRafScheduler,
  detectInitialTheme,
} from './md-render';

// --- localStorage keys + limits (font / wrap / theme) --------------------
export const MD_FONT_SIZE_KEY = 'md-editor-font-size';
export const MD_WRAP_KEY = 'md-editor-wrap-mode';
export const MD_THEME_KEY = 'md-editor-theme';
export const MD_DEFAULT_FONT_SIZE = 14;
export const MD_MIN_FONT_SIZE = 10;
export const MD_MAX_FONT_SIZE = 32;
export const MD_FONT_SIZE_STEP = 1;

export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return MD_DEFAULT_FONT_SIZE;
  return Math.max(MD_MIN_FONT_SIZE, Math.min(MD_MAX_FONT_SIZE, Math.round(px)));
}

export function loadMdFontSize(): number {
  try {
    const raw = window.localStorage.getItem(MD_FONT_SIZE_KEY);
    if (!raw) return MD_DEFAULT_FONT_SIZE;
    return clampFontSize(Number(raw));
  } catch {
    return MD_DEFAULT_FONT_SIZE;
  }
}

export function persistMdFontSize(px: number): void {
  try {
    window.localStorage.setItem(MD_FONT_SIZE_KEY, String(clampFontSize(px)));
  } catch {
    /* privacy mode — ignore */
  }
}

export function loadMdWrapMode(): 'wrap' | 'nowrap' {
  try {
    return window.localStorage.getItem(MD_WRAP_KEY) === 'wrap' ? 'wrap' : 'nowrap';
  } catch {
    return 'nowrap';
  }
}

export function persistMdWrapMode(mode: 'wrap' | 'nowrap'): void {
  try {
    window.localStorage.setItem(MD_WRAP_KEY, mode);
  } catch {
    /* privacy mode — ignore */
  }
}

// --- Render-theme presets ------------------------------------------------
export const MD_PRESETS = [
  'github-light',
  'github-dark',
  'solarized-light',
  'solarized-dark',
  'dracula',
  'nord',
  'gruvbox',
  'one-dark',
] as const;
export type MdRenderPreset = (typeof MD_PRESETS)[number];
export type MdThemePref = 'auto' | MdRenderPreset;

export function isRenderPreset(v: string | null): v is MdRenderPreset {
  return v !== null && (MD_PRESETS as readonly string[]).includes(v);
}

export function loadMdThemePref(): MdThemePref {
  try {
    const raw = window.localStorage.getItem(MD_THEME_KEY);
    if (raw === 'auto') return 'auto';
    if (isRenderPreset(raw)) return raw;
    return 'auto';
  } catch {
    return 'auto';
  }
}

export function persistMdThemePref(pref: MdThemePref): void {
  try {
    // 'auto' = follow the host → drop the override key entirely (rather than
    // store 'auto') so a stale pinned value can't survive a future preset
    // list change.
    if (pref === 'auto') window.localStorage.removeItem(MD_THEME_KEY);
    else window.localStorage.setItem(MD_THEME_KEY, pref);
  } catch {
    /* privacy mode — ignore */
  }
}

// --- Shared mutable state ------------------------------------------------
export const ctx = {
  view: null as EditorView | null,
  currentPath: null as string | null,
  currentDir: null as string | null,
  isDirty: false,
  lastRenderedContent: null as string | null,
  scheduler: createPreviewScheduler(300),
  rafScheduler: createRafScheduler(),
  themeCompartment: new Compartment(),
  readOnlyCompartment: new Compartment(),
  fontSizeCompartment: new Compartment(),
  wrapCompartment: new Compartment(),
  highlightCompartment: new Compartment(),
  previewLineMap: new Map<number, HTMLElement>(),
  scrollSyncRaf: 0,
  wordCountTimer: null as ReturnType<typeof setTimeout> | null,
  undoFlashTimer: null as ReturnType<typeof setTimeout> | null,
  redoFlashTimer: null as ReturnType<typeof setTimeout> | null,
  activeTocLine: null as number | null,
  mdFontSize: loadMdFontSize(),
  mdWrapMode: loadMdWrapMode() as 'wrap' | 'nowrap',
  mdThemePref: loadMdThemePref(),
  hostMode: detectInitialTheme() as 'light' | 'dark',
};

// --- Cached DOM element refs (one getElementById each, at module load) ---
export const dom = {
  editorPane: document.getElementById('editor-pane') as HTMLDivElement,
  previewPane: document.getElementById('preview-pane') as HTMLDivElement,
  splitterEl: document.getElementById('splitter') as HTMLDivElement,
  mainRowEl: document.getElementById('main-row') as HTMLDivElement,
  statusLnEl: document.getElementById('status-ln') as HTMLSpanElement,
  statusColEl: document.getElementById('status-col') as HTMLSpanElement,
  statusLengthEl: document.getElementById('status-length') as HTMLSpanElement,
  statusSelEl: document.getElementById('status-sel') as HTMLSpanElement,
  statusWordsEl: document.getElementById('status-words') as HTMLSpanElement,
  statusReadonlyEl: document.getElementById('status-readonly') as HTMLSpanElement,
  statusDirtyEl: document.getElementById('status-dirty') as HTMLSpanElement,
  statusUndoEl: document.getElementById('status-undo') as HTMLSpanElement,
  statusRedoEl: document.getElementById('status-redo') as HTMLSpanElement,
  findBtn: document.getElementById('btn-find') as HTMLButtonElement,
  toggleWrapBtn: document.getElementById('btn-toggle-wrap') as HTMLButtonElement,
  zoomOutBtn: document.getElementById('btn-zoom-out') as HTMLButtonElement,
  zoomResetBtn: document.getElementById('btn-zoom-reset') as HTMLButtonElement,
  zoomInBtn: document.getElementById('btn-zoom-in') as HTMLButtonElement,
  wrapStateEl: document.getElementById('wrap-state') as HTMLSpanElement,
  toggleTocBtn: document.getElementById('btn-toggle-toc') as HTMLButtonElement,
  gotoLineBtn: document.getElementById('btn-goto-line') as HTMLButtonElement,
  exportHtmlBtn: document.getElementById('btn-export-html') as HTMLButtonElement,
  themeSelectEl: document.getElementById('select-theme') as HTMLSelectElement,
  tocSidebarEl: document.getElementById('toc-sidebar') as HTMLElement,
  tocListEl: document.getElementById('toc-list') as HTMLElement,
};
