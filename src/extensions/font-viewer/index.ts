/**
 * font-viewer — Batch 1 (2026-07-02)
 *
 * Receives `.ttf/.otf/.woff/.woff2` bytes as base64 over `fileContent`,
 * loads them via the FontFace API, and renders 6 fixed + 1 user-defined
 * sample rows in the actual glyphs.
 *
 * Six Batch-1 optimizations (see docs/07-extensions.md §九):
 * 1. Tracking / leading sliders (letter-spacing, line-height)
 * 2. Custom input row (textarea, persists in localStorage)
 * 3. Variable-axis sliders (weight / width + Bold/Italic toggles)
 * 4. Metadata drawer (opentype name-table projection)
 * 5. Glyph grid (opentype cmap, grouped by Unicode block)
 * 6. Background-contrast toggle (Auto/Light/Dark)
 *
 * Persistence (localStorage, key prefix `font-viewer.`):
 * size / tracking / leading / weight / width / customText
 * Bold / italic / contrast / drawer state are NOT persisted (per-file
 * display choice).
 *
 * Zero main-process / IPC / protocol changes — bytes arrive as base64
 * just like the previous version. opentype.js is pure JS, no wasm,
 * doesn't relax the iframe CSP.
 */
import './viewer.css';
import type { Font as OpentypeFont } from 'opentype.js';
import type { HostMessage } from '../../shared/extension-types';

import {
 formatBytes,
 clampSize,
 clampTracking,
 clampLeading,
 clampWeight,
 clampWidth,
 SIZE_DEFAULT,
 TRACKING_DEFAULT,
 LEADING_DEFAULT,
 WEIGHT_DEFAULT,
 WIDTH_DEFAULT,
} from './font-stats';
import {
 parseFont,
 fontMetaFromFont,
 variableAxesFromFont,
 staticStylesFromFont,
 getCmapChars,
 groupCharsByBlock,
 capGlyphList,
 GLYPH_GRID_CAP,
} from './font-info';

// --- DOM refs -------------------------------------------------------------

// The fixed FontFace family used for all sample rows. We delete the previous
// face before adding a new one (in renderFont) so they never compete for
// the same family name.
const PREVIEW_FAMILY = 'WhaleFontPreview';

const familyNameEl = document.getElementById('family-name') as HTMLSpanElement;
const sizeSlider = document.getElementById('size') as HTMLInputElement;
const sizeValueEl = document.getElementById('size-value') as HTMLSpanElement;
const trackingSlider = document.getElementById('tracking') as HTMLInputElement;
const trackingValueEl = document.getElementById('tracking-value') as HTMLSpanElement;
const leadingSlider = document.getElementById('leading') as HTMLInputElement;
const leadingValueEl = document.getElementById('leading-value') as HTMLSpanElement;
const weightSlider = document.getElementById('weight') as HTMLInputElement;
const weightValueEl = document.getElementById('weight-value') as HTMLSpanElement;
const widthSlider = document.getElementById('width') as HTMLInputElement;
const widthValueEl = document.getElementById('width-value') as HTMLSpanElement;
const boldBtn = document.getElementById('bold-btn') as HTMLButtonElement;
const italicBtn = document.getElementById('italic-btn') as HTMLButtonElement;
const bgBtn = document.getElementById('bg-btn') as HTMLButtonElement;
const infoBtn = document.getElementById('info-btn') as HTMLButtonElement;
const glyphsBtn = document.getElementById('glyphs-btn') as HTMLButtonElement;

const sizeLbl = document.getElementById('size-lbl') as HTMLSpanElement;
const trackingLbl = document.getElementById('tracking-lbl') as HTMLSpanElement;
const leadingLbl = document.getElementById('leading-lbl') as HTMLSpanElement;
const weightLbl = document.getElementById('weight-lbl') as HTMLSpanElement;
const widthLbl = document.getElementById('width-lbl') as HTMLSpanElement;
const customLbl = document.getElementById('custom-lbl') as HTMLSpanElement;
const customInput = document.getElementById('custom-text') as HTMLInputElement;

const samplePangram = document.getElementById('s-pangram') as HTMLParagraphElement;
const sampleZh = document.getElementById('s-zh') as HTMLParagraphElement;
const sampleUpper = document.getElementById('s-upper') as HTMLParagraphElement;
const sampleLower = document.getElementById('s-lower') as HTMLParagraphElement;
const sampleDigits = document.getElementById('s-digits') as HTMLParagraphElement;
const sampleParagraph = document.getElementById('s-paragraph') as HTMLParagraphElement;
const sampleEls: HTMLElement[] = [
 samplePangram,
 sampleZh,
 sampleUpper,
 sampleLower,
 sampleDigits,
 sampleParagraph,
];

const statusSizeLbl = document.getElementById('status-size-lbl') as HTMLSpanElement;
const statusSizeEl = document.getElementById('status-size') as HTMLSpanElement;
const statusGlyphsLbl = document.getElementById('status-glyphs-lbl') as HTMLSpanElement;
const statusGlyphsEl = document.getElementById('status-glyphs') as HTMLSpanElement;
const statusFamilyLbl = document.getElementById('status-family-lbl') as HTMLSpanElement;
const statusFamilyEl = document.getElementById('status-family') as HTMLSpanElement;

const drawerEl = document.getElementById('drawer') as HTMLElement;
const tabMetaBtn = document.getElementById('tab-meta') as HTMLButtonElement;
const tabGlyphsBtn = document.getElementById('tab-glyphs') as HTMLButtonElement;
const drawerCloseBtn = document.getElementById('drawer-close') as HTMLButtonElement;
const panelMeta = document.getElementById('panel-meta') as HTMLElement;
const panelGlyphs = document.getElementById('panel-glyphs') as HTMLElement;
const glyphGridEl = document.getElementById('glyph-grid') as HTMLElement;
const glyphTruncatedEl = document.getElementById('glyph-truncated') as HTMLElement;

const metaFamilyEl = document.getElementById('meta-family') as HTMLElement;
const metaSubfamilyEl = document.getElementById('meta-subfamily') as HTMLElement;
const metaFullnameEl = document.getElementById('meta-fullname') as HTMLElement;
const metaVersionEl = document.getElementById('meta-version') as HTMLElement;
const metaCopyrightEl = document.getElementById('meta-copyright') as HTMLElement;
const metaDesignerEl = document.getElementById('meta-designer') as HTMLElement;
const metaManufacturerEl = document.getElementById('meta-manufacturer') as HTMLElement;
const metaLicenseEl = document.getElementById('meta-license') as HTMLElement;
const metaUnitsEl = document.getElementById('meta-units') as HTMLElement;
const metaNumEl = document.getElementById('meta-num') as HTMLElement;
const metaPsEl = document.getElementById('meta-ps') as HTMLElement;

const metaLFamily = document.getElementById('meta-l-family') as HTMLElement;
const metaLSubfamily = document.getElementById('meta-l-subfamily') as HTMLElement;
const metaLFullname = document.getElementById('meta-l-fullname') as HTMLElement;
const metaLVersion = document.getElementById('meta-l-version') as HTMLElement;
const metaLCopyright = document.getElementById('meta-l-copyright') as HTMLElement;
const metaLDesigner = document.getElementById('meta-l-designer') as HTMLElement;
const metaLManufacturer = document.getElementById('meta-l-manufacturer') as HTMLElement;
const metaLLicense = document.getElementById('meta-l-license') as HTMLElement;
const metaLUnits = document.getElementById('meta-l-units') as HTMLElement;
const metaLNum = document.getElementById('meta-l-num') as HTMLElement;
const metaLPs = document.getElementById('meta-l-ps') as HTMLElement;

const NO_VALUE = '—';

// --- i18n -----------------------------------------------------------------
// Mirrors html-viewer pattern: small catalog,
// resolved by host locale, re-applied via `onLocale`.
interface Strings {
 // Status bar labels
 sizeLabel: string;
 familyLabel: string;
 glyphsLabel: string;
 // Toolbar labels
 sizeLbl: string;
 trackingLbl: string;
 leadingLbl: string;
 weightLbl: string;
 widthLbl: string;
 boldLabel: string;
 italicLabel: string;
 // Background
 bgAuto: string;
 bgLight: string;
 bgDark: string;
 // Drawer
 infoTitle: string;
 glyphsTitle: string;
 tabMeta: string;
 tabGlyphs: string;
 closeAria: string;
 // Metadata labels
 mFamily: string;
 mSubfamily: string;
 mFullname: string;
 mVersion: string;
 mCopyright: string;
 mDesigner: string;
 mManufacturer: string;
 mLicense: string;
 mUnits: string;
 mNum: string;
 mPs: string;
 // Custom input
 customLbl: string;
 customPlaceholder: string;
 // Glyph grid
 glyphTruncated: string;
 // Misc
 noValue: string;
}

const I18N: Record<string, Strings> = {
 en: {
 sizeLabel: 'Size',
 familyLabel: 'Family',
 glyphsLabel: 'Glyphs',
 sizeLbl: 'Size',
 trackingLbl: 'Tracking',
 leadingLbl: 'Leading',
 weightLbl: 'Weight',
 widthLbl: 'Width',
 boldLabel: 'Bold',
 italicLabel: 'Italic',
 bgAuto: 'Auto',
 bgLight: 'Light',
 bgDark: 'Dark',
 infoTitle: 'Show metadata',
 glyphsTitle: 'Show glyph grid',
 tabMeta: 'Metadata',
 tabGlyphs: 'Glyphs',
 closeAria: 'Close drawer',
 mFamily: 'Family',
 mSubfamily: 'Style',
 mFullname: 'Full name',
 mVersion: 'Version',
 mCopyright: 'Copyright',
 mDesigner: 'Designer',
 mManufacturer: 'Manufacturer',
 mLicense: 'License',
 mUnits: 'Units per em',
 mNum: 'Glyph count',
 mPs: 'PostScript name',
 customLbl: 'Your text',
 customPlaceholder: 'Type to preview…',
 glyphTruncated: 'Showing the first {n} glyphs of {total}.',
 noValue: '—',
 },
 zh: {
 sizeLabel: '大小',
 familyLabel: '字体',
 glyphsLabel: '字形',
 sizeLbl: '字号',
 trackingLbl: '字距',
 leadingLbl: '行距',
 weightLbl: '字重',
 widthLbl: '字宽',
 boldLabel: '粗体',
 italicLabel: '斜体',
 bgAuto: '自动',
 bgLight: '浅底',
 bgDark: '深底',
 infoTitle: '显示元信息',
 glyphsTitle: '显示字形表',
 tabMeta: '元信息',
 tabGlyphs: '字形',
 closeAria: '关闭面板',
 mFamily: '字体族',
 mSubfamily: '字形',
 mFullname: '完整名称',
 mVersion: '版本',
 mCopyright: '版权',
 mDesigner: '设计师',
 mManufacturer: '厂商',
 mLicense: '许可证',
 mUnits: 'Units per em',
 mNum: '字形数',
 mPs: 'PostScript 名',
 customLbl: '自定义文本',
 customPlaceholder: '输入要预览的文字…',
 glyphTruncated: '仅显示前 {n} 个字形（共 {total}）。',
 noValue: '—',
 },
};

let T: Strings = I18N.en;

function applyLocale() {
 T = window.whaleExt.t(I18N);
 document.documentElement.lang = window.whaleExt.locale;
 // Status bar
 statusSizeLbl.textContent = T.sizeLabel;
 statusFamilyLbl.textContent = T.familyLabel;
 statusGlyphsLbl.textContent = T.glyphsLabel;
 // Toolbar labels
 sizeLbl.textContent = T.sizeLbl;
 trackingLbl.textContent = T.trackingLbl;
 leadingLbl.textContent = T.leadingLbl;
 weightLbl.textContent = T.weightLbl;
 widthLbl.textContent = T.widthLbl;
 boldBtn.setAttribute('aria-label', T.boldLabel);
 boldBtn.setAttribute('title', T.boldLabel);
 italicBtn.setAttribute('aria-label', T.italicLabel);
 italicBtn.setAttribute('title', T.italicLabel);
 bgBtn.setAttribute('title', T.bgAuto);
 infoBtn.setAttribute('title', T.infoTitle);
 glyphsBtn.setAttribute('title', T.glyphsTitle);
 // Drawer
 tabMetaBtn.textContent = T.tabMeta;
 tabGlyphsBtn.textContent = T.tabGlyphs;
 drawerCloseBtn.setAttribute('aria-label', T.closeAria);
 // Metadata labels
 metaLFamily.textContent = T.mFamily;
 metaLSubfamily.textContent = T.mSubfamily;
 metaLFullname.textContent = T.mFullname;
 metaLVersion.textContent = T.mVersion;
 metaLCopyright.textContent = T.mCopyright;
 metaLDesigner.textContent = T.mDesigner;
 metaLManufacturer.textContent = T.mManufacturer;
 metaLLicense.textContent = T.mLicense;
 metaLUnits.textContent = T.mUnits;
 metaLNum.textContent = T.mNum;
 metaLPs.textContent = T.mPs;
 // Custom input
 customLbl.textContent = T.customLbl;
 customInput.setAttribute('placeholder', T.customPlaceholder);
 // Refresh derived UI strings
 updateBgButtonLabel();
 // If the truncated-banner is visible, re-render with new locale.
 if (!glyphTruncatedEl.hidden) {
 const original = getCmapChars(state.font!).length;
 glyphTruncatedEl.textContent = T.glyphTruncated
 .replace('{n}', String(GLYPH_GRID_CAP))
 .replace('{total}', numberFormatter.format(original));
 }
}

// --- Theme ---------------------------------------------------------------

function detectInitialTheme(): 'light' | 'dark' {
 try {
 if (
 typeof window !== 'undefined' &&
 typeof window.matchMedia === 'function' &&
 window.matchMedia('(prefers-color-scheme: dark)').matches
 ) {
 return 'dark';
 }
 } catch {
 /* fallthrough */
 }
 return 'light';
}

function applyTheme(theme: 'light' | 'dark') {
 document.body.setAttribute('data-theme', theme);
}

// --- State ---------------------------------------------------------------

type ContrastMode = 'auto' | 'light' | 'dark';
type DrawerTab = 'meta' | 'glyphs';

interface State {
 /** True once a font has been successfully loaded. */
 loaded: boolean;
 /** Parsed font (opentype.js); cached on successful parse. */
 font: OpentypeFont | null;
 /** File bytes metadata from `FileContentMessage.size`. */
 fileSize: number | undefined;
 /** Sample-text knobs (slider values). */
 sizeValue: number;
 tracking: number;
 leading: number;
 /** Variable-axis knobs (used when font declares the axis). */
 weight: number;
 width: number;
 /** Static-fallback toggles (used when font is not variable). */
 bold: boolean;
 italic: boolean;
 /** Per-file display choice; not persisted. */
 contrast: ContrastMode;
 /** User-typed custom text (persisted). */
 customText: string;
 /** Drawer state (not persisted; reset on each fileContent). */
 drawerOpen: boolean;
 drawerTab: DrawerTab;
}

const state: State = {
 loaded: false,
 font: null,
 fileSize: undefined,
 // Sliders
 sizeValue: SIZE_DEFAULT,
 tracking: TRACKING_DEFAULT,
 leading: LEADING_DEFAULT,
 weight: WEIGHT_DEFAULT,
 width: WIDTH_DEFAULT,
 // Toggles
 bold: false,
 italic: false,
 contrast: 'auto',
 customText: '',
 drawerOpen: false,
 drawerTab: 'meta',
};

// --- Persistence ---------------------------------------------------------

const STORAGE_PREFIX = 'font-viewer.';

function lsGet(key: string): string | null {
 try {
 return window.localStorage.getItem(STORAGE_PREFIX + key);
 } catch {
 return null;
 }
}
function lsSet(key: string, value: string): void {
 try {
 window.localStorage.setItem(STORAGE_PREFIX + key, value);
 } catch {
 /* sandbox may disable localStorage; silently degrade. */
 }
}

function loadPersistedState() {
 const size = lsGet('size');
 if (size !== null) {
 const n = parseFloat(size);
 if (Number.isFinite(n)) state.sizeValue = clampSize(n);
 }
 const tr = lsGet('tracking');
 if (tr !== null) {
 const n = parseFloat(tr);
 if (Number.isFinite(n)) state.tracking = clampTracking(n);
 }
 const ld = lsGet('leading');
 if (ld !== null) {
 const n = parseFloat(ld);
 if (Number.isFinite(n)) state.leading = clampLeading(n);
 }
 const w = lsGet('weight');
 if (w !== null) {
 const n = parseFloat(w);
 if (Number.isFinite(n)) state.weight = clampWeight(n);
 }
 const wd = lsGet('width');
 if (wd !== null) {
 const n = parseFloat(wd);
 if (Number.isFinite(n)) state.width = clampWidth(n);
 }
 const custom = lsGet('customText');
 if (custom !== null) state.customText = custom;
}

function persistSize() {
 lsSet('size', String(state.sizeValue));
}
function persistTracking() {
 lsSet('tracking', String(state.tracking));
}
function persistLeading() {
 lsSet('leading', String(state.leading));
}
function persistWeight() {
 lsSet('weight', String(state.weight));
}
function persistWidth() {
 lsSet('width', String(state.width));
}
function persistCustom() {
 lsSet('customText', state.customText);
}

// --- DOM sync from state -------------------------------------------------

function applySliderToDom() {
 sizeSlider.value = String(state.sizeValue);
 trackingSlider.value = String(state.tracking);
 leadingSlider.value = String(state.leading);
 weightSlider.value = String(state.weight);
 widthSlider.value = String(state.width);
 sizeValueEl.textContent = `${state.sizeValue}px`;
 trackingValueEl.textContent = `${state.tracking}px`;
 leadingValueEl.textContent = state.leading.toFixed(2);
 weightValueEl.textContent = String(state.weight);
 widthValueEl.textContent = `${state.width}%`;
 customInput.value = state.customText;
}

function updateBgButtonLabel() {
 bgBtn.textContent =
 state.contrast === 'auto'
 ? T.bgAuto
 : state.contrast === 'light'
 ? T.bgLight
 : T.bgDark;
 bgBtn.classList.toggle('active', state.contrast !== 'auto');
 bgBtn.setAttribute('title', T.bgAuto);
}

function applyContrast() {
 document.body.setAttribute('data-contrast', state.contrast);
}

// --- Preview rendering --------------------------------------------------

function applyPreview() {
 // Push current knob values to every sample row. font-family is fixed;
 // font-feature-settings / font-variation-settings drive the variable axes.
 for (const el of sampleEls) {
 el.style.fontSize = `${state.sizeValue}px`;
 // Negative tracking reads more naturally without a unit; CSS accepts that.
 el.style.letterSpacing = `${state.tracking}px`;
 el.style.lineHeight = String(state.leading);
 // Variable axes:
 const fvar = state.font?.tables.fvar?.axes ? true : false;
 if (fvar) {
 el.style.fontVariationSettings =
 `'wght' ${state.weight}, 'wdth' ${state.width}`;
 // Static font + user toggles fallback:
 el.style.fontWeight = String(state.weight);
 el.style.fontStyle = state.italic ? 'italic' : 'normal';
 el.style.fontStretch = `${state.width}%`;
 } else {
 el.style.fontVariationSettings = 'normal';
 el.style.fontWeight = state.bold ? 'bold' : 'normal';
 el.style.fontStyle = state.italic ? 'italic' : 'normal';
 el.style.fontStretch = 'normal';
 }
 }

 // Custom input row: clone font settings onto a top-of-page line so
 // the user sees their text immediately as they type.
 if (state.customText) {
 // Ensure custom text is rendered in the first sample area if no slot
 // exists; we use the first fixed sample for the custom preview when
 // set, otherwise normal samples are visible.
 samplePangram.textContent = state.customText;
 } else {
 samplePangram.textContent = SAMPLES['s-pangram'];
 }
}

const SAMPLES: Record<string, string> = {
 's-pangram':
 'The quick brown fox jumps over the lazy dog.',
 's-zh':
 '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。（千字文）',
 's-upper':
 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z',
 's-lower':
 'a b c d e f g h i j k l m n o p q r s t u v w x y z',
 's-digits':
 '0 1 2 3 4 5 6 7 8 9 . , ; : ! ? @ # $ % & ( ) [ ]',
 's-paragraph':
 'Typography is the art and technique of arranging type to make written language legible, readable, and appealing. 1234567890 — The five boxing wizards jump quickly.',
};

// --- Status bar ----------------------------------------------------------

const numberFormatter = new Intl.NumberFormat();

function updateStatusBar() {
 try {
 if (typeof state.fileSize === 'number' && state.fileSize >= 0) {
 statusSizeEl.textContent = formatBytes(state.fileSize);
 } else {
 statusSizeEl.textContent = T.noValue;
 }
 const num = state.font?.numGlyphs;
 statusGlyphsEl.textContent = numberFormatter.format(num ?? 0);
 const fam = state.font?.tables.name?.preferredFamily ?? state.font?.tables.name?.fontFamily;
 statusFamilyEl.textContent = fam || T.noValue;
 } catch (err) {
 // Never let a status-bar failure block content rendering.
 statusSizeEl.textContent = NO_VALUE;
 statusGlyphsEl.textContent = NO_VALUE;
 statusFamilyEl.textContent = NO_VALUE;
 }
}

// --- Metadata + glyph grid -----------------------------------------------

function renderMetadata() {
 if (!state.font) return;
 const meta = fontMetaFromFont(state.font);
 metaFamilyEl.textContent = meta.family || T.noValue;
 metaSubfamilyEl.textContent = meta.subfamily || T.noValue;
 metaFullnameEl.textContent = meta.fullName || T.noValue;
 metaVersionEl.textContent = meta.version || T.noValue;
 metaCopyrightEl.textContent = meta.copyright || T.noValue;
 metaDesignerEl.textContent = meta.designer || T.noValue;
 metaManufacturerEl.textContent = meta.manufacturer || T.noValue;
 metaLicenseEl.textContent = meta.license || T.noValue;
 metaUnitsEl.textContent = numberFormatter.format(state.font.unitsPerEm);
 metaNumEl.textContent = numberFormatter.format(state.font.numGlyphs);
 metaPsEl.textContent = meta.psName || T.noValue;
}

let glyphGridRendered = false;
function renderGlyphGrid() {
 if (!state.font) return;
 if (glyphGridRendered) return;
 glyphGridRendered = true;
 const chars = getCmapChars(state.font);
 const total = chars.length;
 const limited = capGlyphList(chars);
 const groups = groupCharsByBlock(limited);
 const frag = document.createDocumentFragment();
 for (const group of groups) {
 const header = document.createElement('div');
 header.className = 'glyph-block';
 header.textContent = `${group.name} · ${numberFormatter.format(group.codepoints.length)}`;
 frag.appendChild(header);
 for (const cp of group.codepoints) {
 const cell = document.createElement('div');
 cell.className = 'glyph-cell';
 cell.title = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
 const ch = document.createElement('span');
 ch.className = 'glyph-char';
 ch.textContent = String.fromCodePoint(cp);
 const code = document.createElement('span');
 code.className = 'glyph-codepoint';
 code.textContent = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
 cell.appendChild(ch);
 cell.appendChild(code);
 frag.appendChild(cell);
 }
 }
 glyphGridEl.replaceChildren(frag);
 if (total > GLYPH_GRID_CAP) {
 glyphTruncatedEl.hidden = false;
 glyphTruncatedEl.textContent = T.glyphTruncated
 .replace('{n}', String(GLYPH_GRID_CAP))
 .replace('{total}', numberFormatter.format(total));
 } else {
 glyphTruncatedEl.hidden = true;
 }
}

function setDrawerOpen(open: boolean) {
 state.drawerOpen = open;
 drawerEl.classList.toggle('open', open);
 drawerEl.setAttribute('aria-hidden', String(!open));
}

function setDrawerTab(tab: DrawerTab) {
 state.drawerTab = tab;
 tabMetaBtn.classList.toggle('active', tab === 'meta');
 tabGlyphsBtn.classList.toggle('active', tab === 'glyphs');
 panelMeta.classList.toggle('active', tab === 'meta');
 panelGlyphs.classList.toggle('active', tab === 'glyphs');
 if (tab === 'glyphs' && state.font) {
 renderGlyphGrid();
 }
}

// --- Variable axes gating -----------------------------------------------

function setupVariableAxes() {
 if (!state.font) return;
 const axes = variableAxesFromFont(state.font);
 const styles = staticStylesFromFont(state.font);
 const isVariable = !!(axes.wght || axes.wdth || axes.slnt);
 // Sliders always enabled — fall back to default range if axis missing.
 weightSlider.disabled = !axes.wght && !styles.bold && !styles.italic;
 widthSlider.disabled = !axes.wdth;
 // The bold/italic toggles are useful for any font (CSS only), so keep
 // them enabled. The user can simulate weight even on static fonts.
 if (isVariable && axes.wght) {
 weightSlider.min = String(axes.wght.min);
 weightSlider.max = String(axes.wght.max);
 weightSlider.value = String(clampWeight(axes.wght.def));
 }
 if (isVariable && axes.wdth) {
 widthSlider.min = String(axes.wdth.min);
 widthSlider.max = String(axes.wdth.max);
 widthSlider.value = String(clampWidth(axes.wdth.def));
 }
}

// --- File load pipeline --------------------------------------------------

let currentFace: FontFace | null = null;
let loadToken = 0;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
 const binary = window.atob(base64);
 const len = binary.length;
 const ab = new ArrayBuffer(len);
 const view = new Uint8Array(ab);
 for (let i = 0; i < len; i += 1) view[i] = binary.charCodeAt(i);
 return ab;
}

async function renderFont(content: string, sizeHint: number | undefined) {
 const token = (loadToken += 1);
 familyNameEl.textContent = '';
 // Drop any previously-registered face so two fonts never compete for the family.
 if (currentFace) {
 document.fonts.delete(currentFace);
 currentFace = null;
 }

 const buffer = base64ToArrayBuffer(content);
 state.fileSize = sizeHint;

 // Parse with opentype.js first. If it fails (broken / non-standard file)
 // we surface a generic error instead of pretending everything is fine.
 let parsed: OpentypeFont | null = null;
 try {
 parsed = parseFont(buffer);
 } catch (err) {
 if (token !== loadToken) return;
 showLoadError(err);
 return;
 }
 if (token !== loadToken) return;
 state.font = parsed;

 // Register via FontFace so the actual glyph rasterization goes through
 // the CSS font subsystem (lets font-feature-settings / variable axes work).
 const face = new FontFace(PREVIEW_FAMILY, buffer);
 try {
 await face.load();
 } catch (err) {
 if (token !== loadToken) return;
 showLoadError(err);
 return;
 }
 if (token !== loadToken) {
 document.fonts.delete(face);
 return;
 }
 document.fonts.add(face);
 currentFace = face;

 const fam = parsed.tables.name?.preferredFamily ?? parsed.tables.name?.fontFamily;
 familyNameEl.textContent = fam || '(unnamed font)';
 state.loaded = true;

 // Render samples + 6 static-text rows.
 sampleZh.textContent = SAMPLES['s-zh'];
 sampleUpper.textContent = SAMPLES['s-upper'];
 sampleLower.textContent = SAMPLES['s-lower'];
 sampleDigits.textContent = SAMPLES['s-digits'];
 sampleParagraph.textContent = SAMPLES['s-paragraph'];
 if (!state.customText) {
 samplePangram.textContent = SAMPLES['s-pangram'];
 }

 // Configure variable axes + UI gating.
 setupVariableAxes();

 applyPreview();
 updateStatusBar();
 // If the drawer was open during the previous file (e.g. switch fonts while
 // it's expanded), re-render its content so the new metadata/glyphs appear.
 if (state.drawerOpen) {
 if (state.drawerTab === 'meta') renderMetadata();
 else renderGlyphGrid();
 }
 // Drawing a new font invalidates the (cached) glyph grid; force a rebuild
 // next time the user opens the Glyphs tab.
 glyphGridRendered = false;
}

function showLoadError(err: unknown) {
 const msg = err instanceof Error ? err.message : String(err);
 // Tear down any half-loaded samples so the screen doesn't lie.
 for (const el of sampleEls) el.textContent = '';
 familyNameEl.textContent = T.noValue;
 statusFamilyEl.textContent = T.noValue;
 // Drop the surface into the first sample row so the error is visible.
 samplePangram.textContent = `Failed to load font: ${msg}`;
}

// --- Toolbar wiring -----------------------------------------------------

function bindToolbar() {
 sizeSlider.addEventListener('input', () => {
 state.sizeValue = clampSize(parseFloat(sizeSlider.value));
 sizeValueEl.textContent = `${state.sizeValue}px`;
 persistSize();
 applyPreview();
 });
 trackingSlider.addEventListener('input', () => {
 state.tracking = clampTracking(parseFloat(trackingSlider.value));
 trackingValueEl.textContent = `${state.tracking}px`;
 persistTracking();
 applyPreview();
 });
 leadingSlider.addEventListener('input', () => {
 state.leading = clampLeading(parseFloat(leadingSlider.value));
 leadingValueEl.textContent = state.leading.toFixed(2);
 persistLeading();
 applyPreview();
 });
 weightSlider.addEventListener('input', () => {
 state.weight = clampWeight(parseFloat(weightSlider.value));
 weightValueEl.textContent = String(state.weight);
 persistWeight();
 applyPreview();
 });
 widthSlider.addEventListener('input', () => {
 state.width = clampWidth(parseFloat(widthSlider.value));
 widthValueEl.textContent = `${state.width}%`;
 persistWidth();
 applyPreview();
 });
 boldBtn.addEventListener('click', () => {
 state.bold = !state.bold;
 boldBtn.setAttribute('aria-pressed', String(state.bold));
 boldBtn.classList.toggle('active', state.bold);
 applyPreview();
 });
 italicBtn.addEventListener('click', () => {
 state.italic = !state.italic;
 italicBtn.setAttribute('aria-pressed', String(state.italic));
 italicBtn.classList.toggle('active', state.italic);
 applyPreview();
 });
 bgBtn.addEventListener('click', () => {
 state.contrast =
 state.contrast === 'auto' ? 'light' : state.contrast === 'light' ? 'dark' : 'auto';
 updateBgButtonLabel();
 applyContrast();
 });
 // Custom input → live preview. Persisted on `input`, not `change`.
 customInput.addEventListener('input', () => {
 state.customText = customInput.value;
 persistCustom();
 applyPreview();
 });
 // Drawer buttons: Info opens Metadata tab, Glyphs opens Glyphs tab. Both
 // toggle (clicking the same tab twice closes the drawer).
 infoBtn.addEventListener('click', () => {
 if (state.drawerOpen && state.drawerTab === 'meta') {
 setDrawerOpen(false);
 } else {
 setDrawerTab('meta');
 renderMetadata();
 setDrawerOpen(true);
 }
 });
 glyphsBtn.addEventListener('click', () => {
 if (state.drawerOpen && state.drawerTab === 'glyphs') {
 setDrawerOpen(false);
 } else {
 setDrawerTab('glyphs');
 setDrawerOpen(true);
 }
 });
 drawerCloseBtn.addEventListener('click', () => setDrawerOpen(false));
 tabMetaBtn.addEventListener('click', () => {
 setDrawerTab('meta');
 renderMetadata();
 setDrawerOpen(true);
 });
 tabGlyphsBtn.addEventListener('click', () => {
 setDrawerTab('glyphs');
 setDrawerOpen(true);
 });
}

// --- Keyboard shortcuts --------------------------------------------------

window.addEventListener('keydown', (e) => {
 if (e.key === 'Escape' && state.drawerOpen) {
 setDrawerOpen(false);
 }
});

// --- Host message bridge -----------------------------------------------

window.whaleExt.onMessage((msg: HostMessage) => {
 switch (msg.type) {
 case 'fileContent': {
 const m = msg as Extract<HostMessage, { type: 'fileContent' }>;
 if (m.encoding === 'base64') {
 void renderFont(m.content, m.size);
 }
 break;
 }
 case 'setTheme':
 applyTheme(msg.theme);
 break;
 default:
 break;
 }
});

window.whaleExt.onLocale(() => applyLocale());

// --- Initial paint ------------------------------------------------------

applyTheme(detectInitialTheme());
loadPersistedState();
applyLocale();
applySliderToDom();
updateBgButtonLabel();
applyContrast();
bindToolbar();
updateStatusBar();
window.whaleExt.postMessage({ type: 'ready' });

// The fixed FontFace family used for all sample rows. We delete the previous
// face before adding a new one (in renderFont) so they never compete for
// the same family name.
// (declared at top of file)

