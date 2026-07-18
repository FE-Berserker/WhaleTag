import './viewer.css';
import { loadCbz, type CbzPage } from './cbz';
import { loadFb2, type Fb2Book } from './fb2';
import { loadEpub, type EpubBook, type EpubChapter } from './epub';
import { chapterPlainText, previewText } from './plain-text';
import { SearchIndex, type SearchHit } from './search-index';
import {
  installAnnotationsClient,
  readAnnotations,
  writeAnnotations,
} from './annotations-client';
import {
  defaultEbookAnnotations,
  EBOOK_ANNOTATIONS_VERSION,
  type EbookAnnotations,
  type EbookBookmark,
  type EbookHighlight,
  type EbookHighlightColor,
  type EbookPrefs,
} from '../../shared/ebook-annotations';

interface Strings {
  loading: string;
  noChapters: string;
  converting: string;
  converted: string;
  convertFailed: string;
  openSystemApp: string;
  prev: string;
  next: string;
  larger: string;
  smaller: string;
  pageNOfM: string;
  chapterNOfM: string;
  toc: string;
  bookmarks: string;
  highlights: string;
  bookmarkAdded: string;
  noBookmarks: string;
  noHighlights: string;
  searchPlaceholder: string;
  searchMatches: string;
  searchNone: string;
  fontFamily: string;
  theme: string;
  scrollMode: string;
  spreadMode: string;
  lineHeight: string;
  margin: string;
  metaTitle: string;
  metaTitleLabel: string;
  metaAuthor: string;
  metaPublisher: string;
  metaLanguage: string;
  metaDate: string;
  metaDescription: string;
  metaFormat: string;
  metaChapter: string;
  metaNotAvailable: string;
  highlightDeleted: string;
}

const I18N: Record<string, Strings> = {
  en: {
    loading: 'Loading…',
    noChapters: 'No readable chapters.',
    converting: 'Converting to EPUB…',
    converted: 'Converted to EPUB.',
    convertFailed: 'Could not convert ebook: {msg}',
    openSystemApp: 'Open with system app',
    prev: 'Previous',
    next: 'Next',
    larger: 'Larger',
    smaller: 'Smaller',
    pageNOfM: 'Page {n} / {m}',
    chapterNOfM: 'Chapter {n} / {m}',
    toc: 'Contents',
    bookmarks: 'Bookmarks',
    highlights: 'Highlights',
    bookmarkAdded: 'Bookmark added',
    noBookmarks: 'No bookmarks yet. Press ★ to add one.',
    noHighlights: 'No highlights yet. Select text and press ✎.',
    searchPlaceholder: 'Search in book…',
    searchMatches: '{n} of {m}',
    searchNone: 'No matches',
    fontFamily: 'Font',
    theme: 'Theme',
    scrollMode: 'Mode',
    spreadMode: 'Spread',
    lineHeight: 'Line height',
    margin: 'Margin',
    metaTitle: 'Book info',
    metaTitleLabel: 'Title',
    metaAuthor: 'Author',
    metaPublisher: 'Publisher',
    metaLanguage: 'Language',
    metaDate: 'Date',
    metaDescription: 'Description',
    metaFormat: 'Format',
    metaChapter: 'Chapter',
    metaNotAvailable: '—',
    highlightDeleted: 'Highlight deleted',
  },
  zh: {
    loading: '加载中…',
    noChapters: '没有可阅读的章节。',
    converting: '正在转换为 EPUB…',
    converted: '已转换为 EPUB。',
    convertFailed: '无法转换电子书:{msg}',
    openSystemApp: '用系统应用打开',
    prev: '上一页',
    next: '下一页',
    larger: '放大',
    smaller: '缩小',
    pageNOfM: '第 {n} / {m} 页',
    chapterNOfM: '第 {n} / {m} 章',
    toc: '目录',
    bookmarks: '书签',
    highlights: '高亮',
    bookmarkAdded: '已添加书签',
    noBookmarks: '暂无书签。按 ★ 添加。',
    noHighlights: '暂无高亮。选中文本后按 ✎。',
    searchPlaceholder: '在书中搜索…',
    searchMatches: '{n} / {m}',
    searchNone: '无匹配',
    fontFamily: '字体',
    theme: '主题',
    scrollMode: '模式',
    spreadMode: '翻页',
    lineHeight: '行距',
    margin: '页边距',
    metaTitle: '书籍信息',
    metaTitleLabel: '标题',
    metaAuthor: '作者',
    metaPublisher: '出版社',
    metaLanguage: '语言',
    metaDate: '日期',
    metaDescription: '简介',
    metaFormat: '格式',
    metaChapter: '章节',
    metaNotAvailable: '—',
    highlightDeleted: '已删除高亮',
  },
};

let T = I18N.en;

// --- DOM refs ---
const toolbar = {
  prev: getEl('btn-prev', HTMLButtonElement),
  next: getEl('btn-next', HTMLButtonElement),
  toc: getEl('btn-toc', HTMLButtonElement),
  bookmark: getEl('btn-bookmark', HTMLButtonElement),
  highlight: getEl('btn-highlight', HTMLButtonElement),
  search: getEl('btn-search', HTMLButtonElement),
  meta: getEl('btn-meta', HTMLButtonElement),
  smaller: getEl('btn-smaller', HTMLButtonElement),
  larger: getEl('btn-larger', HTMLButtonElement),
  fontSize: getEl('inp-font-size', HTMLInputElement),
  fontFamily: getEl('sel-font-family', HTMLSelectElement),
  theme: getEl('sel-theme', HTMLSelectElement),
  scrollMode: getEl('sel-scroll', HTMLSelectElement),
  spreadMode: getEl('sel-spread', HTMLSelectElement),
  lineHeight: getEl('rng-line-height', HTMLInputElement),
  margin: getEl('rng-margin', HTMLInputElement),
  title: getEl('title', HTMLSpanElement),
  status: getEl('status', HTMLSpanElement),
};
const searchBar = {
  root: getEl('search-bar', HTMLDivElement),
  input: getEl('search-input', HTMLInputElement),
  count: getEl('search-count', HTMLSpanElement),
  prev: getEl('btn-search-prev', HTMLButtonElement),
  next: getEl('btn-search-next', HTMLButtonElement),
  close: getEl('btn-search-close', HTMLButtonElement),
};
const drawer = {
  root: getEl('drawer', HTMLDivElement),
  close: getEl('btn-close-drawer', HTMLButtonElement),
  toc: getEl('toc', HTMLDivElement),
  bookmarks: getEl('bookmarks-list', HTMLDivElement),
  highlights: getEl('highlights-list', HTMLDivElement),
  tabs: Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn')),
};
const metaPanel = {
  root: getEl('meta-panel', HTMLElement),
  title: getEl('meta-title-text', HTMLSpanElement),
  body: getEl('meta-body', HTMLDivElement),
  close: getEl('btn-meta-close', HTMLButtonElement),
};
const contentEl = getEl('content', HTMLDivElement);
const errorEl = getEl('error', HTMLDivElement);
const errorMessageEl = getEl('error-message', HTMLParagraphElement);
const openNativeBtn = getEl('btn-open-native', HTMLButtonElement);
const highlightPopover = {
  root: getEl('highlight-popover', HTMLDivElement),
  text: getEl('highlight-text', HTMLDivElement),
  delete: getEl('btn-hl-delete', HTMLButtonElement),
  color: getEl('btn-hl-color', HTMLButtonElement),
};

function getEl<T extends HTMLElement>(id: string, _cls: new () => T): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

// --- State ---
// Formats handled natively in the renderer (parsers bundled with the extension):
//   epub, fb2, cbz.
// Everything else goes through Calibre's `ebook-convert` to EPUB. Listed here
// are the most common Calibre-supported input formats — extend the array as
// more are requested. Match `manifest.json#fileTypes` so the host offers the
// viewer as the default handler.
type EbookFormat =
  | 'epub'
  | 'fb2'
  | 'cbz'
  | 'mobi'
  | 'azw'
  | 'azw3'
  | 'lit'
  | 'pdb'
  | 'rb'
  | 'snb'
  | 'tcr'
  | 'htmlz';
type DrawerTab = 'toc' | 'bookmarks' | 'highlights';

interface BookMeta {
  format: EbookFormat;
  title: string | null;
  creator: string | null;
  publisher: string | null;
  language: string | null;
  date: string | null;
  description: string | null;
  genre: string | null;
  sequence: string | null;
}

let currentPath: string | null = null;
let currentFormat: EbookFormat | null = null;
let currentBook: EpubBook | null = null;
let currentCbz: CbzPage[] | null = null;
let currentFb2: Fb2Book | null = null;
let currentIndex = 0;
let pendingConvertPath: string | null = null;
let pendingConvertRequestId: string | null = null;
let nativePath: string | null = null;

// Annotation state
let annotations: EbookAnnotations = defaultEbookAnnotations();
let activeDrawerTab: DrawerTab = 'toc';
let metaPanelOpen = false;
let searchOpen = false;
let searchHits: SearchHit[] = [];
let searchHitIndex = 0;
let searchIndex: SearchIndex | null = null;

// Sepia override state — once the user picks sepia, the host's `setTheme`
// messages are ignored until they explicitly pick light or dark.
let hostTheme: 'light' | 'dark' = 'light';
let themeLockedToUser = false; // true once user explicitly picks non-sepia

// Scroll progress throttling
let scrollSaveTimer: number | null = null;
let lastSavedScrollRatio = -1;

// FONT bounds mirror those used by the original A−/A+ controls.
const FONT_MIN = 10;
const FONT_MAX = 32;
const PROGRESS_DEBOUNCE_MS = 800;
const SCROLL_SAVE_DEBOUNCE_MS = 1000;

// --- Helpers ---
function base64ToBytes(b64: string): Uint8Array {
  const binary = window.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

/** Formats that the viewer knows how to handle. Mirrors `EbookFormat` so
 *  `formatOf()` can both validate and narrow. */
const KNOWN_FORMATS: readonly EbookFormat[] = [
  'epub',
  'fb2',
  'cbz',
  'mobi',
  'azw',
  'azw3',
  'lit',
  'pdb',
  'rb',
  'snb',
  'tcr',
  'htmlz',
];

/** Formats that the renderer can parse natively (no Calibre round-trip). */
const NATIVE_FORMATS: ReadonlySet<EbookFormat> = new Set([
  'epub',
  'fb2',
  'cbz',
]);

function formatOf(ext: string): EbookFormat | null {
  return (KNOWN_FORMATS as readonly string[]).includes(ext)
    ? (ext as EbookFormat)
    : null;
}

function setStatus(text: string) {
  toolbar.status.textContent = text;
}

function showError(message: string, path: string | null) {
  nativePath = path;
  errorMessageEl.textContent = message;
  errorEl.classList.remove('hidden');
  contentEl.innerHTML = '';
  drawer.root.classList.remove('open');
}

function clearError() {
  errorEl.classList.add('hidden');
  nativePath = null;
}

function tpl(str: string, vars: Record<string, string | number>): string {
  return str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** Returns the persisted bookmark for the current chapter, or null. */
function currentBookmark(): EbookBookmark | null {
  if (!currentPath) return null;
  const chapterId = currentChapterId();
  if (!chapterId) return null;
  return (
    annotations.bookmarks.find(
      (b) => b.chapterId === chapterId
    ) ?? null
  );
}

function currentChapterId(): string | null {
  if (currentBook) {
    return currentBook.chapters[currentIndex]?.id ?? null;
  }
  if (currentFb2) {
    return 'fb2';
  }
  return null;
}

function currentMeta(): BookMeta | null {
  if (!currentFormat) return null;
  if (currentBook) {
    const m = currentBook.metadata;
    return {
      format: 'epub',
      title: m.title,
      creator: m.creator,
      publisher: m.publisher,
      language: m.language,
      date: m.date,
      description: m.description,
      genre: null,
      sequence: null,
    };
  }
  if (currentFb2) {
    const m = currentFb2.metadata;
    return {
      format: 'fb2',
      title: m.title,
      creator: m.author,
      publisher: null,
      language: m.language,
      date: m.date,
      description: null,
      genre: m.genre,
      sequence: m.sequence,
    };
  }
  if (currentCbz) {
    return {
      format: 'cbz',
      title: null,
      creator: null,
      publisher: null,
      language: null,
      date: null,
      description: null,
      genre: null,
      sequence: null,
    };
  }
  return null;
}

// --- Theme ---
function detectInitialTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(theme: 'light' | 'dark' | 'sepia') {
  document.body.setAttribute('data-theme', theme);
}

function effectiveTheme(): 'light' | 'dark' | 'sepia' {
  // Sepia is a local override; the host's MUI theme can stay on the user's
  // choice while the reader uses sepia. Only the user can take us out of
  // sepia (by picking light or dark), after which we follow the host again.
  return annotations.prefs.theme;
}

function onHostSetTheme(theme: 'light' | 'dark') {
  hostTheme = theme;
  applyTheme(effectiveTheme());
}

// --- Annotation persistence ---
function scheduleSaveAnnotations() {
  // Debounce all writes — slider drags and scroll events fire many times per
  // second; we only need to capture the final state per gesture.
  const w = window as unknown as { __saveTimer?: number | null };
  if (w.__saveTimer) window.clearTimeout(w.__saveTimer);
  w.__saveTimer = window.setTimeout(() => {
    saveAnnotationsNow().catch((e) => {
      console.error('[ebook-viewer] save failed:', e);
    });
  }, PROGRESS_DEBOUNCE_MS);
}

async function saveAnnotationsNow(): Promise<void> {
  if (!currentPath) return;
  try {
    await writeAnnotations(currentPath, annotations);
  } catch (e) {
    console.error('[ebook-viewer] writeAnnotations failed:', e);
  }
}

function migrateLocalStorageProgress(path: string): EbookBookmark | null {
  try {
    const raw = localStorage.getItem(`ebook-progress-${path}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      chapterIndex?: number;
      scrollRatio?: number;
      timestamp?: string;
    };
    // FB2 and CBZ don't have chapterIndex; only migrate if it parses cleanly.
    if (typeof parsed.chapterIndex !== 'number') return null;
    return {
      id: `migrated-${Date.now()}`,
      chapterId: '',
      scrollRatio: parsed.scrollRatio ?? 0,
      createdAt: parsed.timestamp ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function loadAnnotations(path: string): Promise<void> {
  annotations = defaultEbookAnnotations();
  try {
    const loaded = await readAnnotations(path);
    if (loaded) {
      annotations = {
        ...defaultEbookAnnotations(),
        ...loaded,
        version: EBOOK_ANNOTATIONS_VERSION,
      };
    } else {
      // Fresh book — try to migrate the old localStorage progress into a
      // single in-memory bookmark. Do not write back to localStorage.
      const migrated = migrateLocalStorageProgress(path);
      if (migrated) {
        // chapterId is empty until we resolve the actual chapter; the
        // navigation logic falls back to chapterIndex on first open.
        annotations.bookmarks = [migrated];
      }
    }
  } catch (e) {
    console.error('[ebook-viewer] readAnnotations failed:', e);
  }
  syncPrefsToUi();
}

function syncPrefsToUi() {
  toolbar.fontSize.value = String(annotations.prefs.fontSize);
  toolbar.fontFamily.value = annotations.prefs.fontFamily;
  toolbar.theme.value = annotations.prefs.theme;
  toolbar.scrollMode.value = annotations.prefs.scrollMode;
  toolbar.spreadMode.value = annotations.prefs.cbzSpreadMode;
  toolbar.lineHeight.value = String(annotations.prefs.lineHeight);
  toolbar.margin.value = String(annotations.prefs.marginPx);
}

function updatePrefs(patch: Partial<EbookPrefs>) {
  annotations.prefs = { ...annotations.prefs, ...patch };
  if (patch.theme) {
    themeLockedToUser = patch.theme !== 'sepia';
    applyTheme(effectiveTheme());
  }
  scheduleSaveAnnotations();
}

// --- Pref → UI rendering glue ---
function applyPrefsToReader() {
  // Host-page CSS vars (read by .reader-page rules in viewer.css).
  const root = document.documentElement;
  root.style.setProperty('--whale-font-size', `${annotations.prefs.fontSize}px`);
  root.style.setProperty('--whale-line-height', String(annotations.prefs.lineHeight));
  root.style.setProperty('--whale-margin', `${annotations.prefs.marginPx}px`);
  root.style.setProperty('--whale-font-family', annotations.prefs.fontFamily);
  // Refresh visible toolbar/status bits that depend on font size.
  setStatus(currentStatusText());
}

/** Updates the <style id="whale-prefs"> block inside every chapter iframe
 *  so the live reader matches the prefs. Falls back to a no-op if the
 *  iframe's contentDocument isn't reachable (it should always be, given
 *  allow-same-origin, but guards against hostile content). */
function updateChapterIframesPrefs() {
  const iframes = contentEl.querySelectorAll<HTMLIFrameElement>('iframe');
  for (const iframe of iframes) {
    try {
      const doc = iframe.contentDocument;
      if (!doc) continue;
      const styleEl = doc.getElementById('whale-prefs');
      if (styleEl) {
        styleEl.textContent = buildPrefsCss();
      }
    } catch {
      // Ignore — sandbox may block access in pathological cases.
    }
  }
}

function buildPrefsCss(): string {
  return `:root{` +
    `--whale-font-size:${annotations.prefs.fontSize}px;` +
    `--whale-line-height:${annotations.prefs.lineHeight};` +
    `--whale-margin:${annotations.prefs.marginPx}px;` +
    `--whale-font-family:${annotations.prefs.fontFamily};` +
    `}` +
    `body{font-size:var(--whale-font-size);` +
    `line-height:var(--whale-line-height);` +
    `padding:var(--whale-margin);` +
    `font-family:var(--whale-font-family);}` +
    `img{max-width:100%;height:auto;display:block;}`;
}

// --- Chapter iframe construction ---
/**
 * Wraps chapter HTML in a self-contained document. Injects a
 * `<style id="whale-prefs">` block so subsequent prefs updates only need
 * to update its `textContent` (no re-render).
 */
function wrapChapterHtml(html: string): string {
  const prefsStyle = `<style id="whale-prefs">${buildPrefsCss()}</style>`;
  if (html.toLowerCase().includes('</head>')) {
    return html.replace(/<\/head>/i, `${prefsStyle}</head>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${prefsStyle}</head><body>${html}</body></html>`;
}

function renderChapterIframe(chapter: EpubChapter): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-same-origin';
  iframe.srcdoc = wrapChapterHtml(chapter.html);
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.display = 'block';
  return iframe;
}

// --- Highlight rendering ---
function colorClass(c: EbookHighlightColor): string {
  return `hl-${c}`;
}

function nextColor(c: EbookHighlightColor): EbookHighlightColor {
  const cycle: EbookHighlightColor[] = ['yellow', 'green', 'pink', 'blue'];
  const idx = cycle.indexOf(c);
  return cycle[(idx + 1) % cycle.length];
}

/**
 * Wraps the [start, end] range in a chapter's plain text as a
 * `<mark class="whale-highlight" data-highlight-id="...">` tag in the
 * sanitized HTML. Uses TreeWalker so it survives HTML tag boundaries.
 *
 * Caller is responsible for re-rendering the chapter with the returned HTML.
 */
function applyHighlightsToHtml(html: string, highlights: EbookHighlight[]): string {
  if (highlights.length === 0) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body ?? doc.documentElement;
  if (!body) return html;

  for (const h of highlights) {
    if (h.start < 0 || h.end <= h.start) continue;
    let cursor = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    let cur: Node | null = walker.nextNode();
    while (cur) {
      const node = cur as Text;
      const len = node.nodeValue?.length ?? 0;
      const next = cursor + len;
      if (!startNode && h.start >= cursor && h.start <= next) {
        startNode = node;
        startOffset = h.start - cursor;
      }
      if (h.end >= cursor && h.end <= next) {
        endNode = node;
        endOffset = h.end - cursor;
        break;
      }
      cursor = next;
      cur = walker.nextNode();
    }
    if (!startNode || !endNode) continue;

    try {
      const range = doc.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const mark = doc.createElement('mark');
      mark.className = `whale-highlight ${colorClass(h.color)}`;
      mark.dataset.highlightId = h.id;
      // surroundContents throws on partial element containment; fall back to
      // extract+append in that case (rare for plain-text-aligned offsets).
      try {
        range.surroundContents(mark);
      } catch {
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      }
    } catch {
      // Skip a single broken highlight rather than failing the whole render.
    }
  }

  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

function applySearchHitsToHtml(html: string, hits: SearchHit[]): string {
  if (hits.length === 0) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body ?? doc.documentElement;
  if (!body) return html;

  // Build plainText once to align offsets to text nodes.
  const flat = chapterPlainText(html);
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    let cursor = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    let cur: Node | null = walker.nextNode();
    while (cur) {
      const node = cur as Text;
      const len = node.nodeValue?.length ?? 0;
      const next = cursor + len;
      if (!startNode && hit.start >= cursor && hit.start <= next) {
        startNode = node;
        startOffset = hit.start - cursor;
      }
      if (hit.start + hit.length >= cursor && hit.start + hit.length <= next) {
        endNode = node;
        endOffset = hit.start + hit.length - cursor;
        break;
      }
      cursor = next;
      cur = walker.nextNode();
    }
    if (!startNode || !endNode) continue;
    try {
      const range = doc.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const mark = doc.createElement('mark');
      mark.className = 'whale-search-hit';
      if (i === searchHitIndex) mark.classList.add('active');
      mark.dataset.searchHitIndex = String(i);
      range.surroundContents(mark);
    } catch {
      // Skip
    }
  }
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

function chapterWithHighlightsAndHits(
  chapter: EpubChapter,
  chapterId: string
): EpubChapter {
  const hs = annotations.highlights.filter((h) => h.chapterId === chapterId);
  let html = chapter.html;
  if (hs.length > 0) html = applyHighlightsToHtml(html, hs);
  if (searchOpen && searchHits.length > 0) {
    const hs2 = searchHits.filter((h) => h.chapterId === chapterId);
    if (hs2.length > 0) html = applySearchHitsToHtml(html, hs2);
  }
  return { ...chapter, html };
}

// --- Page render ---
function currentStatusText(): string {
  if (currentBook) {
    return tpl(T.chapterNOfM, {
      n: currentIndex + 1,
      m: currentBook.chapters.length,
    });
  }
  if (currentCbz) {
    return tpl(T.pageNOfM, { n: currentIndex + 1, m: currentCbz.length });
  }
  return '';
}

function updateToolbar() {
  const hasPrev = currentIndex > 0;
  const hasNext =
    (currentBook && currentIndex < currentBook.chapters.length - 1) ||
    (currentCbz && currentIndex < currentCbz.length - 1);
  toolbar.prev.disabled = !hasPrev;
  toolbar.next.disabled = !hasNext;
  toolbar.toc.disabled = !currentBook;

  // Format-aware control visibility
  const isCbz = !!currentCbz;
  const isFbandEpub = !!currentBook || !!currentFb2;
  toolbar.spreadMode.style.display = isCbz ? '' : 'none';
  toolbar.scrollMode.style.display = isFbandEpub ? '' : 'none';

  if (currentBook) {
    toolbar.title.textContent = currentBook.title ?? '';
  } else if (currentCbz) {
    toolbar.title.textContent = '';
  } else if (currentFb2) {
    toolbar.title.textContent = currentFb2.title ?? '';
  }
  setStatus(currentStatusText());
}

function updateToc() {
  drawer.toc.innerHTML = '';
  if (!currentBook) return;
  currentBook.chapters.forEach((ch, idx) => {
    const item = document.createElement('div');
    item.className = `toc-item level-1${idx === currentIndex ? ' active' : ''}`;
    item.textContent =
      ch.title ||
      tpl(T.chapterNOfM, { n: idx + 1, m: currentBook!.chapters.length });
    item.addEventListener('click', () => {
      goTo(idx);
      drawer.root.classList.remove('open');
    });
    drawer.toc.appendChild(item);
  });
}

function updateBookmarksList() {
  drawer.bookmarks.innerHTML = '';
  if (annotations.bookmarks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = T.noBookmarks;
    drawer.bookmarks.appendChild(empty);
    return;
  }
  for (const b of annotations.bookmarks) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const ratioPct = Math.round(b.scrollRatio * 100);
    item.innerHTML =
      `<div>${escapeHtml(b.chapterId)}</div>` +
      `<div class="item-meta">${ratioPct}%</div>`;
    item.addEventListener('click', () => jumpToBookmark(b.id));
    drawer.bookmarks.appendChild(item);
  }
}

function updateHighlightsList() {
  drawer.highlights.innerHTML = '';
  if (annotations.highlights.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = T.noHighlights;
    drawer.highlights.appendChild(empty);
    return;
  }
  for (const h of annotations.highlights) {
    const item = document.createElement('div');
    item.className = `list-item ${colorClass(h.color)}`;
    item.innerHTML =
      `<div class="item-text">${escapeHtml(h.text)}</div>` +
      `<div class="item-meta">${escapeHtml(h.chapterId)}</div>`;
    item.addEventListener('click', () => jumpToHighlight(h.id));
    drawer.highlights.appendChild(item);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEpubPage() {
  if (!currentBook) return;
  const chapter = currentBook.chapters[currentIndex];
  if (!chapter) return;

  contentEl.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'reader-page';
  const decorated = chapterWithHighlightsAndHits(chapter, chapter.id);
  page.appendChild(renderChapterIframe(decorated));
  contentEl.appendChild(page);

  // Restore scroll ratio after iframe loads.
  const iframe = page.querySelector('iframe');
  if (iframe) {
    iframe.addEventListener(
      'load',
      () => {
        const bm = currentBookmark();
        if (bm && bm.scrollRatio > 0) {
          const max = contentEl.scrollHeight - contentEl.clientHeight;
          contentEl.scrollTop = Math.round(bm.scrollRatio * max);
        }
      },
      { once: true }
    );
  }

  installScrollListener('page');
  updateToolbar();
  updateToc();
  updateBookmarksList();
  updateHighlightsList();
}

function renderEpubContinuous() {
  if (!currentBook) return;
  contentEl.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'reader-page continuous';
  currentBook.chapters.forEach((chapter) => {
    const divider = document.createElement('div');
    divider.className = 'chapter-divider';
    divider.textContent = chapter.title || '';
    wrapper.appendChild(divider);
    const page = document.createElement('div');
    page.className = 'reader-page';
    const decorated = chapterWithHighlightsAndHits(chapter, chapter.id);
    const iframe = renderChapterIframe(decorated);
    iframe.setAttribute('loading', 'lazy');
    page.appendChild(iframe);
    wrapper.appendChild(page);
  });
  contentEl.appendChild(wrapper);

  // Restore scroll to the bookmark's chapter + ratio.
  const bm = currentBookmark();
  if (bm) {
    requestAnimationFrame(() => {
      const target = contentEl.querySelector<HTMLElement>(
        `[data-chapter-id="${CSS.escape(bm.chapterId)}"]`
      );
      if (target) {
        const top = target.offsetTop + bm.scrollRatio * target.offsetHeight;
        contentEl.scrollTop = Math.max(0, top);
      }
    });
  }

  installScrollListener('continuous');
  updateToolbar();
  updateBookmarksList();
  updateHighlightsList();
}

function renderFb2Page() {
  if (!currentFb2) return;
  contentEl.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'reader-page';
  page.dataset.chapterId = 'fb2';
  const html = chapterWithHighlightsAndHits(
    { id: 'fb2', title: currentFb2.title ?? '', html: currentFb2.html },
    'fb2'
  );
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-same-origin';
  iframe.srcdoc = wrapChapterHtml(html.html);
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  page.appendChild(iframe);
  contentEl.appendChild(page);

  const bm = currentBookmark();
  if (bm && bm.scrollRatio > 0) {
    iframe.addEventListener(
      'load',
      () => {
        const max = contentEl.scrollHeight - contentEl.clientHeight;
        contentEl.scrollTop = Math.round(bm.scrollRatio * max);
      },
      { once: true }
    );
  }

  installScrollListener('page');
  updateToolbar();
  updateBookmarksList();
  updateHighlightsList();
}

function renderCbzPage() {
  if (!currentCbz) return;
  const page = currentCbz[currentIndex];
  if (!page) return;

  contentEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'cbz-page';
  const img = document.createElement('img');
  img.src = page.blobUrl;
  img.alt = page.name;
  wrap.appendChild(img);
  contentEl.appendChild(wrap);
  installScrollListener('page');
  updateToolbar();
}

function renderCbzSpread() {
  if (!currentCbz) return;
  const left = currentCbz[currentIndex];
  const right = currentCbz[currentIndex + 1];
  if (!left) return;

  contentEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'cbz-page spread';
  if (annotations.prefs.cbzSpreadMode === 'double-rtl') {
    wrap.classList.add('right-to-left');
  }
  const leftImg = document.createElement('img');
  leftImg.src = left.blobUrl;
  leftImg.alt = left.name;
  wrap.appendChild(leftImg);
  if (right) {
    const rightImg = document.createElement('img');
    rightImg.src = right.blobUrl;
    rightImg.alt = right.name;
    wrap.appendChild(rightImg);
  }
  contentEl.appendChild(wrap);
  installScrollListener('page');
  // Status text — page counter advances by 1 or 2 depending on spread mode.
  const advance = right ? 2 : 1;
  setStatus(tpl(T.pageNOfM, {
    n: currentIndex + 1,
    m: currentCbz.length,
  }) + ` (×${advance})`);
}

function goTo(index: number) {
  if (currentBook) {
    if (index < 0 || index >= currentBook.chapters.length) return;
    currentIndex = index;
    if (annotations.prefs.scrollMode === 'continuous') renderEpubContinuous();
    else renderEpubPage();
  } else if (currentCbz) {
    if (index < 0 || index >= currentCbz.length) return;
    currentIndex = index;
    if (annotations.prefs.cbzSpreadMode !== 'single') renderCbzSpread();
    else renderCbzPage();
  }
}

function next() {
  const advance = currentCbz && annotations.prefs.cbzSpreadMode !== 'single' ? 2 : 1;
  goTo(currentIndex + advance);
}

function prev() {
  const advance = currentCbz && annotations.prefs.cbzSpreadMode !== 'single' ? 2 : 1;
  goTo(currentIndex - advance);
}

// --- Scroll progress ---
function installScrollListener(_mode: 'page' | 'continuous') {
  // Replace any prior listener by attaching a new one — we don't strictly
  // need to remove because the new one wins for the active contentEl.
  // Throttle to 1 Hz via rAF.
  let lastTs = 0;
  contentEl.addEventListener('scroll', () => {
    const now = performance.now();
    if (now - lastTs < 200) return;
    lastTs = now;
    persistScrollRatio();
  });
}

function persistScrollRatio() {
  if (!currentPath) return;
  const max = contentEl.scrollHeight - contentEl.clientHeight;
  if (max <= 0) return;
  const ratio = Math.max(0, Math.min(1, contentEl.scrollTop / max));
  if (Math.abs(ratio - lastSavedScrollRatio) < 0.005) return;
  lastSavedScrollRatio = ratio;
  const chapterId = currentChapterId();
  if (!chapterId) return;
  const idx = annotations.bookmarks.findIndex(
    (b) => b.chapterId === chapterId
  );
  if (idx >= 0) {
    annotations.bookmarks[idx] = {
      ...annotations.bookmarks[idx],
      scrollRatio: ratio,
    };
  } else {
    annotations.bookmarks.push({
      id: `pos-${Date.now()}`,
      chapterId,
      scrollRatio: ratio,
      createdAt: new Date().toISOString(),
    });
  }
  if (scrollSaveTimer) window.clearTimeout(scrollSaveTimer);
  scrollSaveTimer = window.setTimeout(() => {
    saveAnnotationsNow().catch(() => undefined);
  }, SCROLL_SAVE_DEBOUNCE_MS);
}

function cleanup() {
  currentBook?.destroy();
  if (currentCbz) {
    currentCbz.forEach((p) => URL.revokeObjectURL(p.blobUrl));
  }
  currentBook = null;
  currentCbz = null;
  currentFb2 = null;
  currentIndex = 0;
  contentEl.innerHTML = '';
  drawer.root.classList.remove('open');
  drawer.toc.innerHTML = '';
  drawer.bookmarks.innerHTML = '';
  drawer.highlights.innerHTML = '';
  metaPanel.root.classList.remove('open');
  metaPanel.body.innerHTML = '';
  searchBar.root.classList.add('hidden');
  searchOpen = false;
  searchHits = [];
  searchIndex = null;
  hideHighlightPopover();
}

// --- Format dispatch ---
async function openEbook(path: string, content: string) {
  cleanup();
  clearError();
  currentPath = path;
  currentFormat = formatOf(extOf(path));
  setStatus(T.loading);

  if (!currentFormat) {
    showError(`Unsupported ebook format: ${extOf(path)}`, path);
    return;
  }

  // Load annotations first so renderers can apply prefs / restore bookmarks.
  await loadAnnotations(path);
  applyTheme(effectiveTheme());
  applyPrefsToReader();

  if (!NATIVE_FORMATS.has(currentFormat)) {
    // Anything not parsed natively (MOBI / AZW / AZW3 / LIT / PDB / RB / SNB /
    // TCR / HTMLZ) is routed to Calibre's `ebook-convert` and rendered as EPUB.
    requestEbookConversion(path);
    return;
  }

  try {
    const bytes = base64ToBytes(content);
    if (currentFormat === 'cbz') {
      currentCbz = loadCbz(bytes);
      const bm = currentBookmark();
      if (bm) {
        currentIndex = Math.max(
          0,
          Math.min(Math.floor(bm.scrollRatio * (currentCbz.length - 1)), currentCbz.length - 1)
        );
      }
      if (annotations.prefs.cbzSpreadMode !== 'single') renderCbzSpread();
      else renderCbzPage();
    } else if (currentFormat === 'fb2') {
      currentFb2 = loadFb2(bytes);
      if (annotations.prefs.scrollMode === 'continuous') renderFb2Page();
      else renderFb2Page();
      // FB2 is single doc; continuous vs page looks the same here for v1.
    } else {
      currentBook = loadEpub(bytes);
      const bm = currentBookmark();
      if (bm) {
        const idx = currentBook.chapters.findIndex((c) => c.id === bm.chapterId);
        if (idx >= 0) currentIndex = idx;
      } else {
        // Fall back to migrated legacy chapterIndex.
        const migrated = annotations.bookmarks[0];
        if (migrated && !migrated.chapterId && typeof (migrated as unknown as { chapterIndex?: number }).chapterIndex === 'number') {
          currentIndex = Math.max(
            0,
            Math.min(
              (migrated as unknown as { chapterIndex: number }).chapterIndex,
              currentBook.chapters.length - 1
            )
          );
        }
      }
      if (annotations.prefs.scrollMode === 'continuous') renderEpubContinuous();
      else renderEpubPage();
    }
    // Build search index lazily — only when the user opens the search bar
    // (CBZ has nothing to search, so skip).
    if (currentBook || currentFb2) {
      searchIndex = new SearchIndex(
        currentBook
          ? currentBook.chapters.map((c) => ({ id: c.id, title: c.title, html: c.html }))
          : [{ id: 'fb2', title: currentFb2?.title ?? '', html: currentFb2!.html }]
      );
    }
    // Auto-popup meta panel on first open.
    maybeAutoShowMeta();

    // Auto-open TOC drawer for EPUB/FB2 (CBZ has no chapters).
    if (currentBook || currentFb2) {
      setActiveDrawerTab('toc');
      drawer.root.classList.add('open');
    }
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e), path);
  }
}

function requestEbookConversion(path: string) {
  pendingConvertPath = path;
  pendingConvertRequestId = `e${Date.now()}`;
  setStatus(T.converting);
  window.whaleExt.postMessage({
    type: 'requestEbookConvert',
    requestId: pendingConvertRequestId,
    path,
  });
}

function handleConvertedEpub(data: Uint8Array | null, error?: string) {
  const path = pendingConvertPath;
  pendingConvertPath = null;
  pendingConvertRequestId = null;

  if (!path) return;
  if (!data) {
    showError(
      T.convertFailed.replace('{msg}', error || 'unknown error'),
      path
    );
    return;
  }

  try {
    cleanup();
    currentPath = path;
    currentFormat = 'epub';
    // `data` arrives as a Uint8Array (main returns Buffer; Electron IPC
    // serializes it) — pass straight to loadEpub, wrapping with
    // `new Uint8Array(...)` would copy. See docs/15 P1-4.
    currentBook = loadEpub(data);
    if (annotations.prefs.scrollMode === 'continuous') renderEpubContinuous();
    else renderEpubPage();
    searchIndex = new SearchIndex(
      currentBook.chapters.map((c) => ({ id: c.id, title: c.title, html: c.html }))
    );
    setStatus(T.converted);
    maybeAutoShowMeta();

    // Auto-open TOC drawer for converted EPUB.
    setActiveDrawerTab('toc');
    drawer.root.classList.add('open');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e), path);
  }
}

// --- Search ---
function openSearch() {
  if (!searchIndex) return;
  searchOpen = true;
  searchBar.root.classList.remove('hidden');
  searchBar.input.focus();
  searchBar.input.select();
}

function closeSearch() {
  searchOpen = false;
  searchBar.root.classList.add('hidden');
  searchBar.input.value = '';
  searchHits = [];
  searchHitIndex = 0;
  searchBar.count.textContent = '';
  rerenderVisibleChapters();
}

function runSearch() {
  if (!searchIndex) return;
  const q = searchBar.input.value.trim();
  if (!q) {
    searchHits = [];
    searchHitIndex = 0;
    searchBar.count.textContent = '';
    rerenderVisibleChapters();
    return;
  }
  searchHits = searchIndex.search(q);
  searchHitIndex = searchHits.length > 0 ? 0 : -1;
  searchBar.count.textContent =
    searchHits.length === 0
      ? T.searchNone
      : tpl(T.searchMatches, {
          n: searchHitIndex + 1,
          m: searchHits.length,
        });
  rerenderVisibleChapters();
  scrollToCurrentHit();
}

function nextSearchHit() {
  if (searchHits.length === 0) return;
  searchHitIndex = (searchHitIndex + 1) % searchHits.length;
  searchBar.count.textContent = tpl(T.searchMatches, {
    n: searchHitIndex + 1,
    m: searchHits.length,
  });
  rerenderVisibleChapters();
  scrollToCurrentHit();
}

function prevSearchHit() {
  if (searchHits.length === 0) return;
  searchHitIndex =
    (searchHitIndex - 1 + searchHits.length) % searchHits.length;
  searchBar.count.textContent = tpl(T.searchMatches, {
    n: searchHitIndex + 1,
    m: searchHits.length,
  });
  rerenderVisibleChapters();
  scrollToCurrentHit();
}

function scrollToCurrentHit() {
  if (searchHitIndex < 0) return;
  const hit = searchHits[searchHitIndex];
  if (!hit) return;
  // If the hit is in a different chapter, navigate.
  const inThisChapter =
    (currentBook && currentIndex === hit.chapterIndex) ||
    (currentFb2 && hit.chapterId === 'fb2');
  if (!inThisChapter) {
    goTo(hit.chapterIndex);
    // After re-render, the mark is in the DOM; scroll to it.
    requestAnimationFrame(() => {
      const mark = contentEl.querySelector<HTMLElement>(
        `mark.whale-search-hit.active`
      );
      if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return;
  }
  const mark = contentEl.querySelector<HTMLElement>(
    `mark.whale-search-hit[data-search-hit-index="${searchHitIndex}"].active`
  );
  if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function rerenderVisibleChapters() {
  // Easiest path: re-render the current view. Continuous mode keeps scroll.
  if (currentBook) {
    if (annotations.prefs.scrollMode === 'continuous') renderEpubContinuous();
    else renderEpubPage();
  } else if (currentFb2) {
    renderFb2Page();
  }
}

// --- Highlights ---
function addHighlightFromSelection(): boolean {
  if (!currentBook && !currentFb2) return false;
  const iframe = contentEl.querySelector('iframe');
  if (!iframe) return false;
  const win = iframe.contentWindow;
  const sel = win?.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const text = sel.toString().trim();
  if (!text) return false;

  const chapterId = currentChapterId();
  if (!chapterId) return false;

  // Compute plainText offsets of the selection. We rebuild the plain text
  // from the iframe's body and locate the selected text by string match.
  const body = iframe.contentDocument?.body;
  if (!body) return false;
  const html = new XMLSerializer().serializeToString(body);
  const plain = chapterPlainText(html);
  const selectedText = sel.toString();
  // Find first occurrence in plain text that lines up with the range.
  const start = plain.indexOf(selectedText);
  if (start < 0) return false;
  const highlight: EbookHighlight = {
    id: crypto.randomUUID(),
    chapterId,
    start,
    end: start + selectedText.length,
    text: previewText(selectedText, 80),
    color: 'yellow',
    createdAt: new Date().toISOString(),
  };
  annotations.highlights.push(highlight);
  scheduleSaveAnnotations();
  hideHighlightPopover();
  sel.removeAllRanges();
  rerenderVisibleChapters();
  updateHighlightsList();
  return true;
}

function deleteHighlightById(id: string) {
  annotations.highlights = annotations.highlights.filter((h) => h.id !== id);
  scheduleSaveAnnotations();
  hideHighlightPopover();
  rerenderVisibleChapters();
  updateHighlightsList();
}

function cycleHighlightColor(id: string) {
  const h = annotations.highlights.find((x) => x.id === id);
  if (!h) return;
  h.color = nextColor(h.color);
  scheduleSaveAnnotations();
  rerenderVisibleChapters();
  updateHighlightsList();
}

function showHighlightPopover(id: string, x: number, y: number) {
  const h = annotations.highlights.find((x) => x.id === id);
  if (!h) return;
  highlightPopover.text.textContent = h.text;
  highlightPopover.root.classList.remove('hidden');
  // Clamp to viewport.
  const w = highlightPopover.root.offsetWidth || 280;
  const maxX = window.innerWidth - w - 12;
  highlightPopover.root.style.left = `${Math.min(x, maxX)}px`;
  highlightPopover.root.style.top = `${y + 8}px`;
  highlightPopover.delete.onclick = () => deleteHighlightById(id);
  highlightPopover.color.onclick = () => cycleHighlightColor(id);
}

function hideHighlightPopover() {
  highlightPopover.root.classList.add('hidden');
}

function jumpToHighlight(id: string) {
  const h = annotations.highlights.find((x) => x.id === id);
  if (!h) return;
  if (currentBook) {
    const idx = currentBook.chapters.findIndex((c) => c.id === h.chapterId);
    if (idx >= 0) {
      goTo(idx);
      requestAnimationFrame(() => {
        const mark = contentEl.querySelector<HTMLElement>(
          `mark.whale-highlight[data-highlight-id="${id}"]`
        );
        if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  } else if (currentFb2 && h.chapterId === 'fb2') {
    renderFb2Page();
    requestAnimationFrame(() => {
      const mark = contentEl.querySelector<HTMLElement>(
        `mark.whale-highlight[data-highlight-id="${id}"]`
      );
      if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
  drawer.root.classList.remove('open');
}

function jumpToBookmark(id: string) {
  const b = annotations.bookmarks.find((x) => x.id === id);
  if (!b) return;
  if (currentBook) {
    const idx = currentBook.chapters.findIndex((c) => c.id === b.chapterId);
    if (idx >= 0) {
      goTo(idx);
      requestAnimationFrame(() => {
        const max = contentEl.scrollHeight - contentEl.clientHeight;
        contentEl.scrollTop = Math.round(b.scrollRatio * max);
      });
    }
  } else if (currentCbz) {
    const idx = Math.floor(b.scrollRatio * (currentCbz.length - 1));
    goTo(Math.max(0, Math.min(idx, currentCbz.length - 1)));
  }
  drawer.root.classList.remove('open');
}

function addBookmarkHere() {
  const chapterId = currentChapterId();
  if (!chapterId) return;
  const max = contentEl.scrollHeight - contentEl.clientHeight;
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, contentEl.scrollTop / max));
  const bm: EbookBookmark = {
    id: crypto.randomUUID(),
    chapterId,
    scrollRatio: ratio,
    createdAt: new Date().toISOString(),
  };
  annotations.bookmarks.push(bm);
  scheduleSaveAnnotations();
  setStatus(T.bookmarkAdded);
  updateBookmarksList();
}

// --- Meta panel ---
function maybeAutoShowMeta() {
  if (annotations.bookmarks.length === 0 && annotations.highlights.length === 0) {
    // Fresh book — show meta panel once.
    showMeta();
  }
}

function showMeta() {
  const meta = currentMeta();
  if (!meta) return;
  metaPanel.title.textContent = T.metaTitle;
  metaPanel.body.innerHTML = '';
  const rows: Array<[string, string | null]> = [
    [T.metaFormat, meta.format.toUpperCase()],
    [T.metaTitleLabel, meta.title],
    [T.metaAuthor, meta.creator],
    [T.metaPublisher, meta.publisher],
    [T.metaLanguage, meta.language],
    [T.metaDate, meta.date],
    [T.metaDescription, meta.description],
  ];
  if (meta.genre) rows.push(['Genre', meta.genre]);
  if (meta.sequence) rows.push(['Series', meta.sequence]);
  if (currentBook) {
    rows.push([
      T.metaChapter,
      tpl(T.chapterNOfM, {
        n: currentIndex + 1,
        m: currentBook.chapters.length,
      }),
    ]);
  } else if (currentCbz) {
    rows.push([
      T.pageNOfM,
      tpl(T.pageNOfM, { n: currentIndex + 1, m: currentCbz.length }),
    ]);
  }

  const dl = document.createElement('dl');
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (value && value.trim().length > 0) {
      dd.textContent = value;
    } else {
      dd.classList.add('empty');
      dd.textContent = T.metaNotAvailable;
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  metaPanel.body.appendChild(dl);
  metaPanel.root.classList.add('open');
  metaPanelOpen = true;
}

function hideMeta() {
  metaPanel.root.classList.remove('open');
  metaPanelOpen = false;
}

// --- Locale ---
function applyLocale() {
  T = window.whaleExt.t(I18N);
  document.documentElement.lang = window.whaleExt.locale;
  toolbar.prev.title = T.prev;
  toolbar.next.title = T.next;
  toolbar.smaller.title = T.smaller;
  toolbar.larger.title = T.larger;
  toolbar.theme.title = T.theme;
  toolbar.scrollMode.title = T.scrollMode;
  toolbar.spreadMode.title = T.spreadMode;
  toolbar.fontFamily.title = T.fontFamily;
  toolbar.lineHeight.title = T.lineHeight;
  toolbar.margin.title = T.margin;
  toolbar.meta.title = T.metaTitle;
  openNativeBtn.textContent = T.openSystemApp;
  searchBar.input.placeholder = T.searchPlaceholder;
  // Update drawer tab labels
  drawer.tabs.forEach((btn) => {
    const tab = btn.dataset.tab as DrawerTab;
    btn.textContent =
      tab === 'toc' ? T.toc : tab === 'bookmarks' ? T.bookmarks : T.highlights;
  });
  // Re-render dependent lists.
  updateBookmarksList();
  updateHighlightsList();
  setStatus(currentStatusText());
}

// --- Tab switching in drawer ---
function setActiveDrawerTab(tab: DrawerTab) {
  activeDrawerTab = tab;
  drawer.tabs.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  drawer.toc.classList.toggle('active', tab === 'toc');
  drawer.bookmarks.classList.toggle('active', tab === 'bookmarks');
  drawer.highlights.classList.toggle('active', tab === 'highlights');
}

// --- Toolbar wiring ---
toolbar.prev.addEventListener('click', prev);
toolbar.next.addEventListener('click', next);
toolbar.toc.addEventListener('click', () => {
  setActiveDrawerTab('toc');
  drawer.root.classList.toggle('open');
});
drawer.close.addEventListener('click', () => drawer.root.classList.remove('open'));
drawer.tabs.forEach((btn) => {
  btn.addEventListener('click', () => setActiveDrawerTab(btn.dataset.tab as DrawerTab));
});
metaPanel.close.addEventListener('click', hideMeta);
toolbar.meta.addEventListener('click', () => {
  if (metaPanelOpen) hideMeta();
  else showMeta();
});

toolbar.smaller.addEventListener('click', () => {
  const next = Math.max(FONT_MIN, annotations.prefs.fontSize - 2);
  updatePrefs({ fontSize: next });
  toolbar.fontSize.value = String(next);
  applyPrefsToReader();
  rerenderVisibleChapters();
});
toolbar.larger.addEventListener('click', () => {
  const next = Math.min(FONT_MAX, annotations.prefs.fontSize + 2);
  updatePrefs({ fontSize: next });
  toolbar.fontSize.value = String(next);
  applyPrefsToReader();
  rerenderVisibleChapters();
});
toolbar.fontSize.addEventListener('change', () => {
  const raw = parseInt(toolbar.fontSize.value, 10);
  if (Number.isFinite(raw)) {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, raw));
    toolbar.fontSize.value = String(next);
    updatePrefs({ fontSize: next });
    applyPrefsToReader();
    rerenderVisibleChapters();
  }
});
toolbar.fontFamily.addEventListener('change', () => {
  updatePrefs({ fontFamily: toolbar.fontFamily.value });
  applyPrefsToReader();
  rerenderVisibleChapters();
});
toolbar.theme.addEventListener('change', () => {
  const v = toolbar.theme.value as EbookPrefs['theme'];
  updatePrefs({ theme: v });
});
toolbar.scrollMode.addEventListener('change', () => {
  const v = toolbar.scrollMode.value as EbookPrefs['scrollMode'];
  updatePrefs({ scrollMode: v });
  rerenderVisibleChapters();
});
toolbar.spreadMode.addEventListener('change', () => {
  const v = toolbar.spreadMode.value as EbookPrefs['cbzSpreadMode'];
  updatePrefs({ cbzSpreadMode: v });
  rerenderVisibleChapters();
});
toolbar.lineHeight.addEventListener('input', () => {
  updatePrefs({ lineHeight: parseFloat(toolbar.lineHeight.value) });
  applyPrefsToReader();
  updateChapterIframesPrefs();
});
toolbar.margin.addEventListener('input', () => {
  updatePrefs({ marginPx: parseInt(toolbar.margin.value, 10) });
  applyPrefsToReader();
  updateChapterIframesPrefs();
});

toolbar.bookmark.addEventListener('click', addBookmarkHere);
toolbar.highlight.addEventListener('click', () => {
  addHighlightFromSelection();
});
toolbar.search.addEventListener('click', () => {
  if (searchOpen) closeSearch();
  else openSearch();
});

searchBar.close.addEventListener('click', closeSearch);
searchBar.input.addEventListener('input', () => {
  // Debounce-less; runs on every keystroke but each call is fast.
  runSearch();
});
searchBar.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) prevSearchHit();
    else nextSearchHit();
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});
searchBar.next.addEventListener('click', nextSearchHit);
searchBar.prev.addEventListener('click', prevSearchHit);

openNativeBtn.addEventListener('click', () => {
  if (nativePath) {
    window.whaleExt.postMessage({
      type: 'openLinkExternally',
      url: nativePath,
    });
  }
});

// Highlight click → popover (event delegation on contentEl).
contentEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const mark = target.closest<HTMLElement>('mark.whale-highlight');
  if (mark && mark.dataset.highlightId) {
    showHighlightPopover(mark.dataset.highlightId, e.clientX, e.clientY);
    return;
  }
  hideHighlightPopover();
});

document.addEventListener('click', (e) => {
  if (!highlightPopover.root.contains(e.target as Node)) hideHighlightPopover();
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  ) {
    return;
  }
  // Ctrl/Cmd+F → open search; ESC → close.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    prev();
  } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    next();
  } else if (e.key === 'Escape') {
    if (searchOpen) closeSearch();
    else drawer.root.classList.remove('open');
  }
});

// --- Host message handling ---
window.whaleExt.onMessage((msg) => {
  switch (msg.type) {
    case 'fileContent':
      if (msg.encoding === 'base64') {
        openEbook(msg.path, msg.content);
      }
      break;
    case 'ebookConvertedContent': {
      if (msg.requestId === pendingConvertRequestId) {
        handleConvertedEpub(msg.data, msg.error);
      }
      break;
    }
    case 'setTheme':
      onHostSetTheme(msg.theme);
      break;
    default:
      break;
  }
});

// --- Bootstrap ---
installAnnotationsClient(window.whaleExt.onMessage);
window.whaleExt.onLocale(() => applyLocale());
window.whaleExt.postMessage({ type: 'ready' });
applyTheme(detectInitialTheme());
applyLocale();
syncPrefsToUi();