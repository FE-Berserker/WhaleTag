import type { AnyAction } from 'redux';
import { DEFAULT_PRESET_ID } from '-/theme/presets';
import {
  DEFAULT_ENTRY_SIZE,
  type ThemeMode,
  type SupportedLanguage,
  type TagShape,
  type ListRowDensity,
} from './types';

/**
 * Appearance domain of the settings slice: theme / tag colors / language /
 * typography / list & tray presentation. Split out of the old god-slice
 * `settings.ts` (docs/01 §12) — fields, actions, migrations and reducer
 * cases are verbatim; only the module boundary is new.
 */
export interface AppearanceFields {
  themeMode: ThemeMode;
  /**
   * Active color preset id (see `PRESETS` in `theme/presets.ts`). Unknown ids
   * fall back to the default (`whale`) at render time via `getPreset`, so this
   * is stored verbatim with no validation in the reducer.
   */
  themePreset: string;
  /**
   * App-local tag -> hex color map. Not stored in `.whale/` — a portable
   * per-location tag-library file is a future improvement.
   */
  tagColors: Record<string, string>;
  /** UI language. */
  language: SupportedLanguage;
  /** Base UI font size in px (MUI typography.fontSize; default 14). */
  fontSize: number;
  /** Global silhouette for every tag chip (rounded / pill / square / tag). */
  tagShape: TagShape;
  /** Default grid cell edge (px) for folders without their own entrySize. */
  defaultEntrySize: number;
  /**
   * H.23 P1-3 list-row density preset. Three stops mapping to fixed row
   * heights (`compact` 32 / `normal` 56 / `comfortable` 72 px). `normal` is
   * the default and matches the pre-P1-3 row height documented in `docs/UI.md`
   * §2.1. Folders persist their own per-folder override elsewhere (H.24+);
   * this is the global fallback.
   */
  listRowDensity: ListRowDensity;
  /**
   * H.23 P1-5 — per-column width overrides (in px). Keys are column ids
   * (`name` / `size` / `modified`); values are the actual rendered widths.
   * The `tags` column is intentionally absent here — it's `flex: 1` filling
   * the remaining space. Persistence is via redux-persist; the keyboard /
   * mouse drag handle in `RowColumnLabels` writes here. Bounds per column
   * live in `LIST_COLUMN_BOUNDS` (P1-5 keeps them inline at the call site).
   */
  listColumnWidths: Record<string, number>;
  /**
   * H.23 P1-5 — column ids (e.g. `'name'`) that the user toggled off via
   * the right-click header menu. Empty array = all visible. Mirrors TS strict
   * mode — we use an array (not `Set`) to keep this serialize-friendly across
   * `redux-persist` JSON round-trips.
   */
  listHiddenColumns: string[];
  /**
   * H.23 P2-1 zebra striping for the list view. When `true`, even-indexed
   * rows (0, 2, 4, …) get a subtle `action.hover` background tint —
   * common for tabular UIs to aid horizontal scanning. Off by default
   * (matches the pre-P2-1 look; lighter on the eyes in low-light themes).
   */
  listZebra: boolean;
  /**
   * H.23 P2-3 date format preset for the list view's "modified" column.
   * `'absolute'` → `formatDate(iso)` renders a locale date string
   * (`Intl.DateTimeFormat`). `'relative'` → human-friendly "3 days ago"
   * (i18n through `nDaysAgo` / `nHoursAgo` / `nMinutesAgo` / `justNow`).
   * Defaults to `'absolute'` to match the pre-P2-3 look.
   */
  listDateFormat: 'absolute' | 'relative';
  /**
   * Show tag/rating overlay chips on Gallery tiles. Independent from the list
   * tag column; gallery users may want a clean thumbnail-only view.
   */
  galleryShowTags: boolean;
  /** Whether the right-side file properties tray is visible. */
  trayVisible: boolean;
  /** Width of the right-side file properties tray in pixels. */
  trayWidth: number;
}

export const appearanceInitial: AppearanceFields = {
  themeMode: 'light',
  themePreset: DEFAULT_PRESET_ID,
  tagColors: {},
  language: 'en',
  fontSize: 13,
  tagShape: 'rounded',
  defaultEntrySize: DEFAULT_ENTRY_SIZE,
  listRowDensity: 'normal',
  listColumnWidths: { name: 240, size: 64, modified: 96 },
  listHiddenColumns: [],
  listZebra: false,
  listDateFormat: 'absolute',
  galleryShowTags: true,
  trayVisible: true,
  trayWidth: 300,
};

// --- Action types ------------------------------------------------------------
export const SET_THEME_MODE = 'settings/SET_THEME_MODE';
export const SET_THEME_PRESET = 'settings/SET_THEME_PRESET';
export const SET_TAG_COLOR = 'settings/SET_TAG_COLOR';
export const SET_TAG_COLORS = 'settings/SET_TAG_COLORS';
export const SET_LANGUAGE = 'settings/SET_LANGUAGE';
export const SET_FONT_SIZE = 'settings/SET_FONT_SIZE';
export const SET_TAG_SHAPE = 'settings/SET_TAG_SHAPE';
export const SET_LIST_COLUMN_WIDTHS = 'settings/SET_LIST_COLUMN_WIDTHS';
export const SET_LIST_HIDDEN_COLUMNS = 'settings/SET_LIST_HIDDEN_COLUMNS';
export const SET_LIST_ZEBRA = 'settings/SET_LIST_ZEBRA';
export const SET_LIST_DATE_FORMAT = 'settings/SET_LIST_DATE_FORMAT';
export const SET_LIST_ROW_DENSITY = 'settings/SET_LIST_ROW_DENSITY';
export const SET_DEFAULT_ENTRY_SIZE = 'settings/SET_DEFAULT_ENTRY_SIZE';
export const SET_GALLERY_SHOW_TAGS = 'settings/SET_GALLERY_SHOW_TAGS';
export const SET_TRAY_VISIBLE = 'settings/SET_TRAY_VISIBLE';
export const SET_TRAY_WIDTH = 'settings/SET_TRAY_WIDTH';

export interface SetThemeModeAction extends AnyAction {
  type: typeof SET_THEME_MODE;
  payload: ThemeMode;
}
export interface SetThemePresetAction extends AnyAction {
  type: typeof SET_THEME_PRESET;
  payload: string;
}
export interface SetTagColorAction extends AnyAction {
  type: typeof SET_TAG_COLOR;
  payload: { tag: string; color: string | null }; // null = clear
}
export interface SetTagColorsAction extends AnyAction {
  type: typeof SET_TAG_COLORS;
  payload: Record<string, string>; // tag → color, merged in (batch)
}
export interface SetLanguageAction extends AnyAction {
  type: typeof SET_LANGUAGE;
  payload: SupportedLanguage;
}
export interface SetFontSizeAction extends AnyAction {
  type: typeof SET_FONT_SIZE;
  payload: number;
}
export interface SetTagShapeAction extends AnyAction {
  type: typeof SET_TAG_SHAPE;
  payload: TagShape;
}
export interface SetListColumnWidthsAction extends AnyAction {
  type: typeof SET_LIST_COLUMN_WIDTHS;
  /** `{ columnId: pxWidth }` — partial update, merged over existing widths.
   *  Caller clamps to per-column `[min, max]` from the helper in settings. */
  payload: Record<string, number>;
}
export interface SetListHiddenColumnsAction extends AnyAction {
  type: typeof SET_LIST_HIDDEN_COLUMNS;
  /** Column ids (e.g. `'name'`, `'tags'`, `'size'`, `'modified'`) that
   *  should be hidden. Empty array = all visible. */
  payload: string[];
}
export interface SetListZebraAction extends AnyAction {
  type: typeof SET_LIST_ZEBRA;
  payload: boolean;
}
export interface SetListDateFormatAction extends AnyAction {
  type: typeof SET_LIST_DATE_FORMAT;
  payload: 'absolute' | 'relative';
}
export interface SetGalleryShowTagsAction extends AnyAction {
  type: typeof SET_GALLERY_SHOW_TAGS;
  payload: boolean;
}
export interface SetListRowDensityAction extends AnyAction {
  type: typeof SET_LIST_ROW_DENSITY;
  payload: ListRowDensity;
}
export interface SetDefaultEntrySizeAction extends AnyAction {
  type: typeof SET_DEFAULT_ENTRY_SIZE;
  payload: number;
}
export interface SetTrayVisibleAction extends AnyAction {
  type: typeof SET_TRAY_VISIBLE;
  payload: boolean;
}
export interface SetTrayWidthAction extends AnyAction {
  type: typeof SET_TRAY_WIDTH;
  payload: number;
}

// --- Action creators ---------------------------------------------------------
export function setThemeMode(mode: ThemeMode): SetThemeModeAction {
  return { type: SET_THEME_MODE, payload: mode };
}

export function setThemePreset(presetId: string): SetThemePresetAction {
  return { type: SET_THEME_PRESET, payload: presetId };
}

export function setTagColor(
  tag: string,
  color: string | null
): SetTagColorAction {
  return { type: SET_TAG_COLOR, payload: { tag, color } };
}
/** Batch-assign colors to many tags in one action (one persist write, not N).
 *  Used by TagMetaContext when a freshly-opened directory surfaces many
 *  uncolored tags at once. */
export function setTagColors(
  colors: Record<string, string>
): SetTagColorsAction {
  return { type: SET_TAG_COLORS, payload: colors };
}

export function setLanguage(language: SupportedLanguage): SetLanguageAction {
  return { type: SET_LANGUAGE, payload: language };
}

export function setFontSize(px: number): SetFontSizeAction {
  return { type: SET_FONT_SIZE, payload: px };
}

export function setTagShape(shape: TagShape): SetTagShapeAction {
  return { type: SET_TAG_SHAPE, payload: shape };
}
export function setListColumnWidths(
  widths: Record<string, number>
): SetListColumnWidthsAction {
  return { type: SET_LIST_COLUMN_WIDTHS, payload: widths };
}
export function setListHiddenColumns(
  hidden: string[]
): SetListHiddenColumnsAction {
  return { type: SET_LIST_HIDDEN_COLUMNS, payload: hidden };
}
export function setListZebra(zebra: boolean): SetListZebraAction {
  return { type: SET_LIST_ZEBRA, payload: zebra };
}
export function setListDateFormat(
  mode: 'absolute' | 'relative'
): SetListDateFormatAction {
  return { type: SET_LIST_DATE_FORMAT, payload: mode };
}
export function setGalleryShowTags(
  enabled: boolean
): SetGalleryShowTagsAction {
  return { type: SET_GALLERY_SHOW_TAGS, payload: enabled };
}
export function setListRowDensity(d: ListRowDensity): SetListRowDensityAction {
  return { type: SET_LIST_ROW_DENSITY, payload: d };
}

export function setDefaultEntrySize(px: number): SetDefaultEntrySizeAction {
  return { type: SET_DEFAULT_ENTRY_SIZE, payload: px };
}

export function setTrayVisible(visible: boolean): SetTrayVisibleAction {
  return { type: SET_TRAY_VISIBLE, payload: visible };
}

export function setTrayWidth(px: number): SetTrayWidthAction {
  return { type: SET_TRAY_WIDTH, payload: Math.max(200, Math.min(600, px)) };
}

// --- Migration (redux-persist backfill) --------------------------------------
export function migrateAppearance<T extends AppearanceFields>(base: T): T {
  let next = base;
  // Theme presets: old persisted state has no themePreset field; default to
  // 'whale' so existing users see no visual change. (themeMode widening to add
  // 'system' needs no migration — old 'light'/'dark' values satisfy the union.)
  if (next.themePreset === undefined)
    next = { ...next, themePreset: DEFAULT_PRESET_ID };
  if (next.tagColors === undefined) next = { ...next, tagColors: {} };
  if (next.language === undefined) next = { ...next, language: 'en' };
  if (next.fontSize === undefined) next = { ...next, fontSize: 13 };
  if (next.listRowDensity === undefined)
    next = { ...next, listRowDensity: 'normal' };
  if (next.tagShape === undefined) next = { ...next, tagShape: 'rounded' };
  // 'pill' was removed (indistinguishable from 'rounded'); coerce legacy value.
  if ((next.tagShape as string) === 'pill')
    next = { ...next, tagShape: 'rounded' };
  if (next.defaultEntrySize === undefined)
    next = { ...next, defaultEntrySize: DEFAULT_ENTRY_SIZE };
  if (next.galleryShowTags === undefined)
    next = { ...next, galleryShowTags: true };
  if (next.trayVisible === undefined) next = { ...next, trayVisible: true };
  if (next.trayWidth === undefined) next = { ...next, trayWidth: 300 };
  return next;
}

// --- Reducer (this domain's cases only) --------------------------------------
export function reduceAppearance<T extends AppearanceFields>(
  state: T,
  action: AnyAction
): T {
  switch (action.type) {
    case SET_THEME_MODE:
      return { ...state, themeMode: action.payload };
    case SET_THEME_PRESET:
      return { ...state, themePreset: action.payload };
    case SET_TAG_COLOR: {
      const { tag, color } = action.payload;
      const tagColors = { ...state.tagColors };
      if (color) tagColors[tag] = color;
      else delete tagColors[tag];
      return { ...state, tagColors };
    }
    case SET_TAG_COLORS:
      // Merge a batch of tag → color assignments in a single state update.
      return {
        ...state,
        tagColors: { ...state.tagColors, ...action.payload },
      };
    case SET_LANGUAGE:
      return { ...state, language: action.payload };
    case SET_FONT_SIZE:
      return { ...state, fontSize: action.payload };
    case SET_TAG_SHAPE:
      return { ...state, tagShape: action.payload };
    case SET_LIST_COLUMN_WIDTHS:
      return {
        ...state,
        listColumnWidths: {
          // Merge over the previous widths so callers can update one column
          // at a time without losing the others.
          ...state.listColumnWidths,
          ...action.payload,
        },
      };
    case SET_LIST_HIDDEN_COLUMNS:
      return { ...state, listHiddenColumns: action.payload };
    case SET_LIST_ZEBRA:
      return { ...state, listZebra: action.payload };
    case SET_LIST_DATE_FORMAT:
      return { ...state, listDateFormat: action.payload };
    case SET_GALLERY_SHOW_TAGS:
      return { ...state, galleryShowTags: action.payload };
    case SET_LIST_ROW_DENSITY:
      return { ...state, listRowDensity: action.payload };
    case SET_DEFAULT_ENTRY_SIZE:
      return { ...state, defaultEntrySize: action.payload };
    case SET_TRAY_VISIBLE:
      return { ...state, trayVisible: action.payload };
    case SET_TRAY_WIDTH:
      return { ...state, trayWidth: action.payload };
    default:
      return state;
  }
}
