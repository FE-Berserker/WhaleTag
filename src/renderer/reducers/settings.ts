import type { AnyAction } from 'redux';
import type { SupportedLanguage } from '-/i18n';
import type { ViewMode } from '../../shared/whale-meta';
import type { TagShape } from '../../shared/tag-colors';
import {
  DEFAULT_KEYBINDINGS,
  sanitizeKeybindings,
  type KeyAction,
} from '../../shared/keybindings';

/**
 * H.23 P1-3 row-density preset (3 stops). Stored verbatim — the reducer
 * doesn't validate the literal; UI callers pick from this enum. New preset
 * additions must update the helper mapping in FileList (`rowHeightFromDensity`).
 */
export type ListRowDensity = 'compact' | 'normal' | 'comfortable';
import { REMOVE_LOCATION, type RemoveLocationAction } from '-/reducers/locations';
import { REMOVE_STAGE } from '-/reducers/workflow';
import { DEFAULT_PRESET_ID } from '-/theme/presets';

/**
 * Persisted UI theme choice. The first three are the classic appearance modes;
 * the additional values are curated full-theme presets that fix both the color
 * palette and the effective light/dark mode (so they render consistently rather
 * than following the OS).
 *
 * `'system'` follows the OS via `matchMedia('(prefers-color-scheme: dark)')`;
 * it is resolved to an effective `'light' | 'dark'` by the theme resolution hook
 * before reaching the theme factory (MUI's `palette.mode` only accepts those two
 * values).
 */
export type ThemeMode =
  | 'light'
  | 'dark'
  | 'system'
  | 'warm-paper'
  | 'midnight-plum'
  | 'frosted-mint'
  | 'deep-ocean'
  | 'dawn-blush'
  | 'forest-ink'
  | 'soft-amber'
  | 'high-contrast';

/** Map tile source for the Mapique perspective. */
export type MapProvider = 'gaode' | 'osm';

/** Fallback grid cell edge (px) used when neither a folder nor settings sets one. */
export const DEFAULT_ENTRY_SIZE = 160;

/**
 * Inclusive bounds for the global view-depth setting. The depth controls how
 * many directory levels `DirectoryContentContextProvider` recurses into when
 * collecting entries (1 = current dir only, 5 = up to 5 levels of
 * subdirectories). The shared slider in `FileToolbar` and any view-local
 * callers (none as of H.24) should clamp to this range.
 */
export const MIN_VIEW_DEPTH = 1;
export const MAX_VIEW_DEPTH = 5;
export const DEFAULT_VIEW_DEPTH = 1;

/** Clamp a candidate depth value into the [1, 5] range. */
export function clampViewDepth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_VIEW_DEPTH;
  return Math.max(MIN_VIEW_DEPTH, Math.min(MAX_VIEW_DEPTH, Math.trunc(n)));
}

/**
 * Normalizes a filesystem path for comparison/dedup: forward slashes, no
 * trailing slash, lowercased (Whale is Windows-primary, where paths are
 * case-insensitive). Used for the full-text path set.
 */
export function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Persisted UI/user preferences. */
export interface SettingsState {
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
  /**
   * Location to auto-open on startup. `null` = no default (restore whatever
   * was last active). Cleared automatically when the location is removed.
   */
  defaultLocationId: string | null;
  /**
   * Directories with full-text search enabled. Each is an independent index
   * root (may be a location root or any subdirectory). Stored verbatim;
   * compared/deduped via normalizeFsPath.
   */
  fulltextPaths: string[];
  /**
   * Send deletes through the system trash (recoverable) instead of permanent
   * removal. Default true — never destroy data unrecoverably without opt-in.
   */
  deleteToTrash: boolean;
  /**
   * Default file-area view for folders that don't override it in their
   * `.whale/wsm.json`. A folder's own perspective takes precedence.
   */
  defaultViewMode: ViewMode;
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
  /**
   * Show files and folders whose names begin with a dot (e.g. `.whale`).
   * Hidden by default to keep the browser uncluttered.
   */
  showHiddenFiles: boolean;
  /**
   * Show Chinese-lunar day labels in the Calendar perspective (zh locale only).
   * Off by default — opt-in, since it's culturally specific and the labels add
   * density to day cells. See `shared/lunar.ts`.
   */
  showLunar: boolean;
  /**
   * Generate thumbnails for Office documents (doc/xls/ppt/...) by converting
   * them with LibreOffice. Disabled by default because it requires an external
   * binary; when disabled (or LibreOffice is missing) Office files show a
   * type icon instead.
   */
  officeThumbnailEnabled: boolean;
  /**
   * Optional explicit path to the LibreOffice `soffice` binary. `null` means
   * "auto-detect" (PATH + common install locations).
   */
  sofficePath: string | null;
  /**
   * Optional explicit path to the LibreDWG `dwg2dxf` binary used to preview
   * `.dwg` files. `null` means "auto-detect" on PATH.
   */
  dwg2dxfPath: string | null;
  /**
   * Optional explicit path to the ODA File Converter executable used to preview
   * `.dwg` files when LibreDWG is not available. `null` means auto-detect in
   * standard install locations.
   */
  odaPath: string | null;
  /**
   * Optional explicit path to Calibre's `ebook-convert` binary, used to convert
   * MOBI/AZW/AZW3 (and any other Calibre-supported input format registered
   * with the ebook viewer) into EPUB before rendering. `null` means
   * auto-detect on PATH and the standard install locations.
   */
  calibrePath: string | null;
  /**
   * Task reminder: on startup, check the monitored location for files tagged
   * with a pending workflow status (not-started / in-progress) and list them.
   * Off by default.
   */
  taskReminderEnabled: boolean;
  /** Location id whose pending tasks are checked on startup; null = none chosen. */
  taskReminderLocationId: string | null;
  /**
   * Workflow stage IDs that count as "pending" for the startup task reminder.
   * `null` means the user has not configured it yet and the defaults should be
   * derived from the current workflow stages. Empty array = explicitly none.
   */
  taskReminderStageIds: string[] | null;
  /**
   * Custom map tile URL for the Mapique perspective. Empty string uses the
   * default tiles for the selected {@link mapProvider}; a local/enterprise tile
   * server can be set here to override.
   */
  mapTileUrl: string;
  /**
   * Map source for the Mapique perspective. `gaode` (AutoNavi, reachable in
   * mainland China, GCJ-02 datum) or `osm` (OpenStreetMap via Leaflet, WGS-84
   * datum). Determines default tiles and whether GCJ-02 coordinate transform
   * is applied to WGS-84 coordinates.
   */
  mapProvider: MapProvider;
  /** Whether the right-side file properties tray is visible. */
  trayVisible: boolean;
  /** Width of the right-side file properties tray in pixels. */
  trayWidth: number;
  /**
   * Global recursion depth for entry collection. `1` = current directory only
   * (today's default, zero behavior change for existing users); `2-5` includes
   * subdirectories up to that many levels deep. Drives the unified slider in
   * `FileToolbar` and (after the H.24 data-layer work) is consumed by
   * `DirectoryContentContextProvider`. Per-folder overrides are not yet
   * supported — see plan §H.24 "已知取舍".
   */
  viewDepth: number;
  /**
   * Customizable key→action bindings for the file list (Settings ▸ Keyboard).
   * Keys are normalized `KeyboardEvent.key` tokens (see `shared/keybindings`);
   * values are `KeyAction`. A missing key (or one sanitized away) means "no
   * action" — the browser default for that key is preserved, which is what
   * lets Tab fall back to focus traversal when the user sets it to 'none'.
   * Defaults live in `DEFAULT_KEYBINDINGS`; persisted values are sanitized on
   * load via `sanitizeKeybindings`.
   */
  keybindings: Record<string, KeyAction>;
  /**
   * Phase 5 — AI assistant. All AI settings here are NON-SECRET (persisted via
   * redux-persist/localStorage). Secrets (`ANTHROPIC_API_KEY`, OpenAI key) live
   * encrypted in the main process via Electron `safeStorage`
   * (see `src/main/ai/security/`).
   */
  aiProvider: 'claude-cli' | 'ollama' | 'openai';
  /** Ollama base URL (provider='ollama'). */
  aiOllamaUrl: string;
  /** OpenAI-compatible base URL (provider='openai'). */
  aiOpenaiUrl: string;
  /** Anthropic base URL for the Claude Code CLI (env ANTHROPIC_BASE_URL).
   *  Empty = official api.anthropic.com; set this for relay/proxy providers. */
  aiAnthropicBaseUrl: string;
  /** Which env var the stored API key is written to. 'authToken'
   *  (ANTHROPIC_AUTH_TOKEN, Bearer) is what most relay/proxy providers expect
   *  (cc-switch defaults to it); 'apiKey' (ANTHROPIC_API_KEY, x-api-key) is the
   *  official Anthropic auth. */
  aiAnthropicAuthMode: 'apiKey' | 'authToken';
  aiEnabled: boolean;
  aiPanelOpen: boolean;
  aiPanelWidth: number;
  aiModel: string;
  aiPermissionMode: 'yolo' | 'plan' | 'normal';
  aiEffort: 'low' | 'medium' | 'high';
  aiSafeMode: 'auto' | 'acceptEdits';
  aiCustomSystemPrompt: string;
  /** Multiline `KEY=value` block (non-secret env overrides for the CLI). */
  aiEnvVarOverrides: string;
  /** Explicit Claude Code CLI path override; null = auto-discover. */
  aiCliPath: string | null;
  /** Whether to load the user's `~/.claude/settings.json` into the CLI. */
  aiLoadUserSettings: boolean;
  /** Configured MCP servers (Claude CLI provider). See `shared/ai-types`. */
  aiMcpServers: import('../../shared/ai-types').ManagedMcpServer[];
  /** Advertise Whale-defined tools to HTTP providers (read/list/write). */
  aiHttpTools: boolean;
}

export const initialState: SettingsState = {
  themeMode: 'light',
  themePreset: DEFAULT_PRESET_ID,
  tagColors: {},
  language: 'en',
  fontSize: 13,
  defaultLocationId: null,
  fulltextPaths: [],
  deleteToTrash: true,
  defaultViewMode: 'list',
  tagShape: 'rounded',
  defaultEntrySize: DEFAULT_ENTRY_SIZE,
  listRowDensity: 'normal',
  listColumnWidths: { name: 240, size: 64, modified: 96 },
  listHiddenColumns: [],
  listZebra: false,
  listDateFormat: 'absolute',
  galleryShowTags: true,
  showHiddenFiles: false,
  showLunar: false,
  officeThumbnailEnabled: false,
  sofficePath: null,
  dwg2dxfPath: null,
  odaPath: null,
  calibrePath: null,
  taskReminderEnabled: false,
  taskReminderLocationId: null,
  taskReminderStageIds: null,
  mapTileUrl: '',
  mapProvider: 'gaode',
  trayVisible: true,
  trayWidth: 300,
  viewDepth: DEFAULT_VIEW_DEPTH,
  // Fresh copy so accidental mutation of initialState never bleeds into the
  // shared DEFAULT_KEYBINDINGS reference (the reducer always treats state as
  // immutable, but defense-in-depth is cheap here).
  keybindings: { ...DEFAULT_KEYBINDINGS },
  aiProvider: 'claude-cli',
  aiOllamaUrl: 'http://localhost:11434',
  aiOpenaiUrl: 'https://api.openai.com/v1',
  aiAnthropicBaseUrl: '',
  aiAnthropicAuthMode: 'apiKey',
  aiEnabled: false,
  aiPanelOpen: false,
  aiPanelWidth: 420,
  aiModel: 'sonnet',
  aiPermissionMode: 'normal',
  aiEffort: 'high',
  aiSafeMode: 'acceptEdits',
  aiCustomSystemPrompt: '',
  aiEnvVarOverrides: '',
  aiCliPath: null,
  aiLoadUserSettings: false,
  aiMcpServers: [],
  aiHttpTools: true,
};

export const SET_THEME_MODE = 'settings/SET_THEME_MODE';
export const SET_THEME_PRESET = 'settings/SET_THEME_PRESET';
export const SET_TAG_COLOR = 'settings/SET_TAG_COLOR';
export const SET_LANGUAGE = 'settings/SET_LANGUAGE';
export const SET_FONT_SIZE = 'settings/SET_FONT_SIZE';
export const SET_DEFAULT_LOCATION = 'settings/SET_DEFAULT_LOCATION';
export const ADD_FULLTEXT_PATH = 'settings/ADD_FULLTEXT_PATH';
export const REMOVE_FULLTEXT_PATH = 'settings/REMOVE_FULLTEXT_PATH';
export const SET_DELETE_TO_TRASH = 'settings/SET_DELETE_TO_TRASH';
export const SET_DEFAULT_VIEW_MODE = 'settings/SET_DEFAULT_VIEW_MODE';
export const SET_TAG_SHAPE = 'settings/SET_TAG_SHAPE';
export const SET_LIST_COLUMN_WIDTHS = 'settings/SET_LIST_COLUMN_WIDTHS';
export const SET_LIST_HIDDEN_COLUMNS = 'settings/SET_LIST_HIDDEN_COLUMNS';
export const SET_LIST_ZEBRA = 'settings/SET_LIST_ZEBRA';
export const SET_LIST_DATE_FORMAT = 'settings/SET_LIST_DATE_FORMAT';
export const SET_LIST_ROW_DENSITY = 'settings/SET_LIST_ROW_DENSITY';
export const SET_DEFAULT_ENTRY_SIZE = 'settings/SET_DEFAULT_ENTRY_SIZE';
export const SET_GALLERY_SHOW_TAGS = 'settings/SET_GALLERY_SHOW_TAGS';
export const SET_SHOW_HIDDEN_FILES = 'settings/SET_SHOW_HIDDEN_FILES';
export const SET_SHOW_LUNAR = 'settings/SET_SHOW_LUNAR';
export const SET_OFFICE_THUMBNAIL_ENABLED =
  'settings/SET_OFFICE_THUMBNAIL_ENABLED';
export const SET_SOFFICE_PATH = 'settings/SET_SOFFICE_PATH';
export const SET_DWG_2DXF_PATH = 'settings/SET_DWG_2DXF_PATH';
export const SET_ODA_PATH = 'settings/SET_ODA_PATH';
export const SET_CALIBRE_PATH = 'settings/SET_CALIBRE_PATH';
export const SET_TASK_REMINDER_ENABLED = 'settings/SET_TASK_REMINDER_ENABLED';
export const SET_TASK_REMINDER_LOCATION_ID =
  'settings/SET_TASK_REMINDER_LOCATION_ID';
export const SET_TASK_REMINDER_STAGE_IDS =
  'settings/SET_TASK_REMINDER_STAGE_IDS';
export const SET_MAP_TILE_URL = 'settings/SET_MAP_TILE_URL';
export const SET_MAP_PROVIDER = 'settings/SET_MAP_PROVIDER';
export const SET_TRAY_VISIBLE = 'settings/SET_TRAY_VISIBLE';
export const SET_TRAY_WIDTH = 'settings/SET_TRAY_WIDTH';
export const SET_VIEW_DEPTH = 'settings/SET_VIEW_DEPTH';
export const SET_KEYBINDING = 'settings/SET_KEYBINDING';
export const RESET_KEYBINDINGS = 'settings/RESET_KEYBINDINGS';
/**
 * Partial update for the AI settings block. One action covers all `ai*` fields
 * (panel state + provider/runtime config) — they're never updated in ways that
 * need distinct reducer logic, so a single shallow-merge action keeps the file
 * from ballooning. The `ANTHROPIC_API_KEY` is intentionally absent (it lives
 * encrypted in the main process, not in redux).
 */
export const SET_AI_SETTINGS = 'settings/SET_AI_SETTINGS';

/** The subset of {@link SettingsState} that the AI action may update. */
export type AiSettingsPatch = Pick<
  SettingsState,
  | 'aiEnabled'
  | 'aiPanelOpen'
  | 'aiPanelWidth'
  | 'aiModel'
  | 'aiPermissionMode'
  | 'aiEffort'
  | 'aiSafeMode'
  | 'aiCustomSystemPrompt'
  | 'aiEnvVarOverrides'
  | 'aiCliPath'
  | 'aiLoadUserSettings'
  | 'aiProvider'
  | 'aiOllamaUrl'
  | 'aiOpenaiUrl'
  | 'aiAnthropicBaseUrl'
  | 'aiAnthropicAuthMode'
  | 'aiMcpServers'
  | 'aiHttpTools'
>;

export interface SetAiSettingsAction extends AnyAction {
  type: typeof SET_AI_SETTINGS;
  payload: Partial<AiSettingsPatch>;
}

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
export interface SetLanguageAction extends AnyAction {
  type: typeof SET_LANGUAGE;
  payload: SupportedLanguage;
}
export interface SetFontSizeAction extends AnyAction {
  type: typeof SET_FONT_SIZE;
  payload: number;
}
export interface SetDefaultLocationAction extends AnyAction {
  type: typeof SET_DEFAULT_LOCATION;
  payload: string | null; // null = clear default
}
export interface AddFulltextPathAction extends AnyAction {
  type: typeof ADD_FULLTEXT_PATH;
  payload: string;
}
export interface RemoveFulltextPathAction extends AnyAction {
  type: typeof REMOVE_FULLTEXT_PATH;
  payload: string;
}
export interface SetDeleteToTrashAction extends AnyAction {
  type: typeof SET_DELETE_TO_TRASH;
  payload: boolean;
}
export interface SetDefaultViewModeAction extends AnyAction {
  type: typeof SET_DEFAULT_VIEW_MODE;
  payload: ViewMode;
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
export interface SetShowHiddenFilesAction extends AnyAction {
  type: typeof SET_SHOW_HIDDEN_FILES;
  payload: boolean;
}
export interface SetShowLunarAction extends AnyAction {
  type: typeof SET_SHOW_LUNAR;
  payload: boolean;
}
export interface SetOfficeThumbnailEnabledAction extends AnyAction {
  type: typeof SET_OFFICE_THUMBNAIL_ENABLED;
  payload: boolean;
}
export interface SetSofficePathAction extends AnyAction {
  type: typeof SET_SOFFICE_PATH;
  payload: string | null;
}
export interface SetDwg2dxfPathAction extends AnyAction {
  type: typeof SET_DWG_2DXF_PATH;
  payload: string | null;
}
export interface SetOdaPathAction extends AnyAction {
  type: typeof SET_ODA_PATH;
  payload: string | null;
}
export interface SetCalibrePathAction extends AnyAction {
  type: typeof SET_CALIBRE_PATH;
  payload: string | null;
}
export interface SetTaskReminderEnabledAction extends AnyAction {
  type: typeof SET_TASK_REMINDER_ENABLED;
  payload: boolean;
}
export interface SetTaskReminderLocationIdAction extends AnyAction {
  type: typeof SET_TASK_REMINDER_LOCATION_ID;
  payload: string | null;
}
export interface SetTaskReminderStageIdsAction extends AnyAction {
  type: typeof SET_TASK_REMINDER_STAGE_IDS;
  payload: string[] | null;
}
export interface SetMapTileUrlAction extends AnyAction {
  type: typeof SET_MAP_TILE_URL;
  payload: string;
}
export interface SetMapProviderAction extends AnyAction {
  type: typeof SET_MAP_PROVIDER;
  payload: MapProvider;
}
export interface SetTrayVisibleAction extends AnyAction {
  type: typeof SET_TRAY_VISIBLE;
  payload: boolean;
}
export interface SetTrayWidthAction extends AnyAction {
  type: typeof SET_TRAY_WIDTH;
  payload: number;
}
export interface SetViewDepthAction extends AnyAction {
  type: typeof SET_VIEW_DEPTH;
  /** Clamped to [MIN_VIEW_DEPTH, MAX_VIEW_DEPTH] by `clampViewDepth` in the creator. */
  payload: number;
}
export interface SetKeybindingAction extends AnyAction {
  type: typeof SET_KEYBINDING;
  /** `token` = normalized key (see `shared/keybindings`); `action === 'none'`
   *  removes the binding so the browser default for that key is restored
   *  (e.g. Tab → focus traversal). */
  payload: { token: string; action: KeyAction };
}
export interface ResetKeybindingsAction extends AnyAction {
  type: typeof RESET_KEYBINDINGS;
}

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

export function setLanguage(language: SupportedLanguage): SetLanguageAction {
  return { type: SET_LANGUAGE, payload: language };
}

export function setFontSize(px: number): SetFontSizeAction {
  return { type: SET_FONT_SIZE, payload: px };
}

export function setDefaultLocation(
  id: string | null
): SetDefaultLocationAction {
  return { type: SET_DEFAULT_LOCATION, payload: id };
}

export function addFulltextPath(p: string): AddFulltextPathAction {
  return { type: ADD_FULLTEXT_PATH, payload: p.trim() };
}

export function removeFulltextPath(p: string): RemoveFulltextPathAction {
  return { type: REMOVE_FULLTEXT_PATH, payload: p };
}

export function setDeleteToTrash(enabled: boolean): SetDeleteToTrashAction {
  return { type: SET_DELETE_TO_TRASH, payload: enabled };
}

export function setDefaultViewMode(mode: ViewMode): SetDefaultViewModeAction {
  return { type: SET_DEFAULT_VIEW_MODE, payload: mode };
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

export function setShowHiddenFiles(enabled: boolean): SetShowHiddenFilesAction {
  return { type: SET_SHOW_HIDDEN_FILES, payload: enabled };
}

export function setShowLunar(enabled: boolean): SetShowLunarAction {
  return { type: SET_SHOW_LUNAR, payload: enabled };
}

export function setOfficeThumbnailEnabled(
  enabled: boolean
): SetOfficeThumbnailEnabledAction {
  return { type: SET_OFFICE_THUMBNAIL_ENABLED, payload: enabled };
}

export function setSofficePath(path: string | null): SetSofficePathAction {
  return { type: SET_SOFFICE_PATH, payload: path };
}

export function setDwg2dxfPath(path: string | null): SetDwg2dxfPathAction {
  return { type: SET_DWG_2DXF_PATH, payload: path };
}

export function setOdaPath(path: string | null): SetOdaPathAction {
  return { type: SET_ODA_PATH, payload: path };
}

export function setCalibrePath(path: string | null): SetCalibrePathAction {
  return { type: SET_CALIBRE_PATH, payload: path };
}

export function setTaskReminderEnabled(
  enabled: boolean
): SetTaskReminderEnabledAction {
  return { type: SET_TASK_REMINDER_ENABLED, payload: enabled };
}

export function setTaskReminderLocationId(
  id: string | null
): SetTaskReminderLocationIdAction {
  return { type: SET_TASK_REMINDER_LOCATION_ID, payload: id };
}

export function setTaskReminderStageIds(
  ids: string[] | null
): SetTaskReminderStageIdsAction {
  return { type: SET_TASK_REMINDER_STAGE_IDS, payload: ids };
}

export function setMapTileUrl(url: string): SetMapTileUrlAction {
  return { type: SET_MAP_TILE_URL, payload: url.trim() };
}

export function setMapProvider(provider: MapProvider): SetMapProviderAction {
  return { type: SET_MAP_PROVIDER, payload: provider };
}

export function setTrayVisible(visible: boolean): SetTrayVisibleAction {
  return { type: SET_TRAY_VISIBLE, payload: visible };
}

export function setTrayWidth(px: number): SetTrayWidthAction {
  return { type: SET_TRAY_WIDTH, payload: Math.max(200, Math.min(600, px)) };
}

export function setViewDepth(depth: number): SetViewDepthAction {
  return { type: SET_VIEW_DEPTH, payload: clampViewDepth(depth) };
}

export function setKeybinding(
  token: string,
  action: KeyAction
): SetKeybindingAction {
  return { type: SET_KEYBINDING, payload: { token, action } };
}

export function resetKeybindings(): ResetKeybindingsAction {
  return { type: RESET_KEYBINDINGS };
}

/** Update one or more AI settings fields (shallow merge over the ai* block). */
export function setAiSettings(patch: Partial<AiSettingsPatch>): SetAiSettingsAction {
  return { type: SET_AI_SETTINGS, payload: patch };
}

export default function settingsReducer(
  state = initialState,
  action:
    | SetThemeModeAction
    | SetThemePresetAction
    | SetTagColorAction
    | SetLanguageAction
    | SetFontSizeAction
    | SetDefaultLocationAction
    | AddFulltextPathAction
    | RemoveFulltextPathAction
    | SetDeleteToTrashAction
    | SetDefaultViewModeAction
    | SetTagShapeAction
    | SetListRowDensityAction
    | SetListColumnWidthsAction
    | SetListHiddenColumnsAction
    | SetListZebraAction
    | SetListDateFormatAction
    | SetGalleryShowTagsAction
    | SetDefaultEntrySizeAction
    | SetShowHiddenFilesAction
    | SetShowLunarAction
    | SetOfficeThumbnailEnabledAction
    | SetSofficePathAction
    | SetDwg2dxfPathAction
    | SetOdaPathAction
    | SetCalibrePathAction
    | SetTaskReminderEnabledAction
    | SetTaskReminderLocationIdAction
    | SetTaskReminderStageIdsAction
    | SetMapTileUrlAction
    | SetMapProviderAction
    | SetTrayVisibleAction
    | SetTrayWidthAction
    | SetViewDepthAction
    | SetKeybindingAction
    | ResetKeybindingsAction
    | SetAiSettingsAction
    | AnyAction
): SettingsState {
  // Migrate persisted state from before tagColors/language/default/fulltext existed.
  let base: SettingsState = state;
  // Theme presets: old persisted state has no themePreset field; default to
  // 'whale' so existing users see no visual change. (themeMode widening to add
  // 'system' needs no migration — old 'light'/'dark' values satisfy the union.)
  if (base.themePreset === undefined)
    base = { ...base, themePreset: DEFAULT_PRESET_ID };
  if (base.tagColors === undefined) base = { ...base, tagColors: {} };
  if (base.language === undefined) base = { ...base, language: 'en' };
  if (base.fontSize === undefined) base = { ...base, fontSize: 13 };
  if (base.defaultLocationId === undefined)
    base = { ...base, defaultLocationId: null };
  if (base.fulltextPaths === undefined) base = { ...base, fulltextPaths: [] };
  if (base.deleteToTrash === undefined) base = { ...base, deleteToTrash: true };
  if (base.defaultViewMode === undefined)
    base = { ...base, defaultViewMode: 'list' };
  if (base.listRowDensity === undefined)
    base = { ...base, listRowDensity: 'normal' };
  if (base.tagShape === undefined) base = { ...base, tagShape: 'rounded' };
  // 'pill' was removed (indistinguishable from 'rounded'); coerce legacy value.
  if ((base.tagShape as string) === 'pill')
    base = { ...base, tagShape: 'rounded' };
  if (base.defaultEntrySize === undefined)
    base = { ...base, defaultEntrySize: DEFAULT_ENTRY_SIZE };
  if (base.showHiddenFiles === undefined)
    base = { ...base, showHiddenFiles: false };
  if (base.galleryShowTags === undefined)
    base = { ...base, galleryShowTags: true };
  if (base.showLunar === undefined) base = { ...base, showLunar: false };
  if (base.officeThumbnailEnabled === undefined)
    base = { ...base, officeThumbnailEnabled: false };
  if (base.sofficePath === undefined) base = { ...base, sofficePath: null };
  if (base.dwg2dxfPath === undefined) base = { ...base, dwg2dxfPath: null };
  if (base.odaPath === undefined) base = { ...base, odaPath: null };
  if (base.calibrePath === undefined) base = { ...base, calibrePath: null };
  if (base.taskReminderEnabled === undefined)
    base = { ...base, taskReminderEnabled: false };
  if (base.taskReminderLocationId === undefined)
    base = { ...base, taskReminderLocationId: null };
  if (base.taskReminderStageIds === undefined)
    base = { ...base, taskReminderStageIds: null };
  if (base.mapTileUrl === undefined) base = { ...base, mapTileUrl: '' };
  if (base.mapProvider === undefined) base = { ...base, mapProvider: 'gaode' };
  if (base.trayVisible === undefined) base = { ...base, trayVisible: true };
  if (base.trayWidth === undefined) base = { ...base, trayWidth: 300 };
  // H.24: viewDepth lands in the same release as the data-layer change; the
  // default of 1 keeps existing users on the "current directory only" path so
  // the migration is invisible.
  if (base.viewDepth === undefined) base = { ...base, viewDepth: DEFAULT_VIEW_DEPTH };
  // Defensive: if a stale persisted value slipped out of bounds, normalize it
  // (e.g. NaN from a corrupt write, or a future schema that lowered MAX).
  if (
    !Number.isFinite(base.viewDepth) ||
    base.viewDepth < MIN_VIEW_DEPTH ||
    base.viewDepth > MAX_VIEW_DEPTH
  ) {
    base = { ...base, viewDepth: DEFAULT_VIEW_DEPTH };
  }
  // Keybindings: backfill defaults for pre-keybindings persisted state, and
  // sanitize otherwise (drop unknown tokens / actions and 'none' entries so a
  // corrupt or hand-edited store can't crash handleKeyDown or shadow a real
  // key). Defaults are spread so the reducer never shares mutable state with
  // the `DEFAULT_KEYBINDINGS` export.
  //
  // CRITICAL: only allocate a new `base` object when sanitization actually
  // drops or changes something. `sanitizeKeybindings` always returns a fresh
  // object (by design — it must not alias the input), so naively wrapping it
  // in `base = { ...base, keybindings: sanitized }` would make every persisted
  // settings look "modified" to redux-persist's `autoMergeLevel1`
  // reconciler. That reconciler skips rehydration whenever
  // `originalState[key] !== reducedState[key]`, so an identity-different
  // keybindings object would silently drop the entire rehydrated settings
  // slice (themeMode, language, viewDepth, etc. all revert to defaults on
  // every restart) — which is the original H.25 bug. Comparing against the
  // previous keybindings keeps rehydration alive while still cleaning up
  // hand-edited blobs that need it.
  if (base.keybindings === undefined) {
    base = { ...base, keybindings: { ...DEFAULT_KEYBINDINGS } };
  } else {
    const sanitized = sanitizeKeybindings(base.keybindings);
    const prev = base.keybindings;
    let bindingsChanged = Object.keys(sanitized).length !== Object.keys(prev).length;
    if (!bindingsChanged) {
      for (const token of Object.keys(sanitized)) {
        if (sanitized[token] !== prev[token]) {
          bindingsChanged = true;
          break;
        }
      }
    }
    if (bindingsChanged) {
      base = { ...base, keybindings: sanitized };
    }
  }
  // Phase 5 AI defaults — old persisted state predates the AI feature.
  if (base.aiProvider === undefined) base = { ...base, aiProvider: 'claude-cli' };
  if (base.aiOllamaUrl === undefined)
    base = { ...base, aiOllamaUrl: 'http://localhost:11434' };
  if (base.aiOpenaiUrl === undefined)
    base = { ...base, aiOpenaiUrl: 'https://api.openai.com/v1' };
  if (base.aiAnthropicBaseUrl === undefined)
    base = { ...base, aiAnthropicBaseUrl: '' };
  if (base.aiAnthropicAuthMode === undefined)
    base = { ...base, aiAnthropicAuthMode: 'apiKey' };
  if (base.aiEnabled === undefined) base = { ...base, aiEnabled: false };
  if (base.aiPanelOpen === undefined) base = { ...base, aiPanelOpen: false };
  if (base.aiPanelWidth === undefined) base = { ...base, aiPanelWidth: 420 };
  if (base.aiModel === undefined) base = { ...base, aiModel: 'sonnet' };
  if (base.aiPermissionMode === undefined)
    base = { ...base, aiPermissionMode: 'normal' };
  if (base.aiEffort === undefined) base = { ...base, aiEffort: 'high' };
  if (base.aiSafeMode === undefined) base = { ...base, aiSafeMode: 'acceptEdits' };
  if (base.aiCustomSystemPrompt === undefined)
    base = { ...base, aiCustomSystemPrompt: '' };
  if (base.aiEnvVarOverrides === undefined)
    base = { ...base, aiEnvVarOverrides: '' };
  if (base.aiCliPath === undefined) base = { ...base, aiCliPath: null };
  if (base.aiLoadUserSettings === undefined)
    base = { ...base, aiLoadUserSettings: false };
  if (base.aiMcpServers === undefined) base = { ...base, aiMcpServers: [] };
  if (base.aiHttpTools === undefined) base = { ...base, aiHttpTools: true };

  switch (action.type) {
    case SET_THEME_MODE:
      return { ...base, themeMode: (action as SetThemeModeAction).payload };
    case SET_THEME_PRESET:
      return { ...base, themePreset: (action as SetThemePresetAction).payload };
    case SET_TAG_COLOR: {
      const { tag, color } = (action as SetTagColorAction).payload;
      const tagColors = { ...base.tagColors };
      if (color) tagColors[tag] = color;
      else delete tagColors[tag];
      return { ...base, tagColors };
    }
    case SET_LANGUAGE:
      return { ...base, language: (action as SetLanguageAction).payload };
    case SET_FONT_SIZE:
      return { ...base, fontSize: (action as SetFontSizeAction).payload };
    case SET_DEFAULT_LOCATION:
      return {
        ...base,
        defaultLocationId: (action as SetDefaultLocationAction).payload,
      };
    case ADD_FULLTEXT_PATH: {
      const p = (action as AddFulltextPathAction).payload;
      if (!p) return base;
      const norm = normalizeFsPath(p);
      if (base.fulltextPaths.some((x) => normalizeFsPath(x) === norm))
        return base; // already present
      return { ...base, fulltextPaths: [...base.fulltextPaths, p] };
    }
    case REMOVE_FULLTEXT_PATH: {
      const norm = normalizeFsPath((action as RemoveFulltextPathAction).payload);
      return {
        ...base,
        fulltextPaths: base.fulltextPaths.filter(
          (x) => normalizeFsPath(x) !== norm
        ),
      };
    }
    case SET_DELETE_TO_TRASH:
      return {
        ...base,
        deleteToTrash: (action as SetDeleteToTrashAction).payload,
      };
    case SET_DEFAULT_VIEW_MODE:
      return {
        ...base,
        defaultViewMode: (action as SetDefaultViewModeAction).payload,
      };
    case SET_TAG_SHAPE:
      return { ...base, tagShape: (action as SetTagShapeAction).payload };
    case SET_LIST_COLUMN_WIDTHS:
      return {
        ...base,
        listColumnWidths: {
          // Merge over the previous widths so callers can update one column
          // at a time without losing the others.
          ...base.listColumnWidths,
          ...(action as SetListColumnWidthsAction).payload,
        },
      };
    case SET_LIST_HIDDEN_COLUMNS:
      return {
        ...base,
        listHiddenColumns: (action as SetListHiddenColumnsAction).payload,
      };
    case SET_LIST_ZEBRA:
      return {
        ...base,
        listZebra: (action as SetListZebraAction).payload,
      };
    case SET_LIST_DATE_FORMAT:
      return {
        ...base,
        listDateFormat: (action as SetListDateFormatAction).payload,
      };
    case SET_GALLERY_SHOW_TAGS:
      return {
        ...base,
        galleryShowTags: (action as SetGalleryShowTagsAction).payload,
      };
    case SET_LIST_ROW_DENSITY:
      return {
        ...base,
        listRowDensity: (action as SetListRowDensityAction).payload,
      };
    case SET_DEFAULT_ENTRY_SIZE:
      return {
        ...base,
        defaultEntrySize: (action as SetDefaultEntrySizeAction).payload,
      };
    case SET_SHOW_HIDDEN_FILES:
      return {
        ...base,
        showHiddenFiles: (action as SetShowHiddenFilesAction).payload,
      };
    case SET_SHOW_LUNAR:
      return {
        ...base,
        showLunar: (action as SetShowLunarAction).payload,
      };
    case SET_OFFICE_THUMBNAIL_ENABLED:
      return {
        ...base,
        officeThumbnailEnabled: (action as SetOfficeThumbnailEnabledAction)
          .payload,
      };
    case SET_SOFFICE_PATH:
      return {
        ...base,
        sofficePath: (action as SetSofficePathAction).payload,
      };
    case SET_DWG_2DXF_PATH:
      return {
        ...base,
        dwg2dxfPath: (action as SetDwg2dxfPathAction).payload || null,
      };
    case SET_ODA_PATH:
      return {
        ...base,
        odaPath: (action as SetOdaPathAction).payload || null,
      };
    case SET_CALIBRE_PATH:
      return {
        ...base,
        calibrePath: (action as SetCalibrePathAction).payload || null,
      };
    case SET_TASK_REMINDER_ENABLED:
      return {
        ...base,
        taskReminderEnabled: (action as SetTaskReminderEnabledAction).payload,
      };
    case SET_TASK_REMINDER_LOCATION_ID:
      return {
        ...base,
        taskReminderLocationId: (action as SetTaskReminderLocationIdAction)
          .payload,
      };
    case SET_TASK_REMINDER_STAGE_IDS:
      return {
        ...base,
        taskReminderStageIds: (action as SetTaskReminderStageIdsAction).payload,
      };
    case SET_MAP_TILE_URL:
      return {
        ...base,
        mapTileUrl: (action as SetMapTileUrlAction).payload,
      };
    case SET_MAP_PROVIDER:
      return {
        ...base,
        mapProvider: (action as SetMapProviderAction).payload,
      };
    case SET_TRAY_VISIBLE:
      return {
        ...base,
        trayVisible: (action as SetTrayVisibleAction).payload,
      };
    case SET_TRAY_WIDTH:
      return {
        ...base,
        trayWidth: (action as SetTrayWidthAction).payload,
      };
    case SET_VIEW_DEPTH:
      return {
        ...base,
        viewDepth: clampViewDepth((action as SetViewDepthAction).payload),
      };
    case SET_KEYBINDING: {
      // Rename the payload's `action` field to avoid shadowing the reducer's
      // `action` param. Setting a key to 'none' removes it entirely so the
      // browser default (e.g. Tab focus traversal) is restored for that key.
      const { token, action: keyAction } = (action as SetKeybindingAction)
        .payload;
      const keybindings = { ...base.keybindings };
      if (keyAction === 'none') delete keybindings[token];
      else keybindings[token] = keyAction;
      return { ...base, keybindings };
    }
    case RESET_KEYBINDINGS:
      return { ...base, keybindings: { ...DEFAULT_KEYBINDINGS } };
    case SET_AI_SETTINGS:
      return {
        ...base,
        ...(action as SetAiSettingsAction).payload,
      };
    case REMOVE_STAGE: {
      // A deleted workflow stage should no longer count as pending.
      const removedId = (action as AnyAction).payload as string;
      const ids = base.taskReminderStageIds;
      if (!ids || !ids.includes(removedId)) return base;
      return {
        ...base,
        taskReminderStageIds: ids.filter((id) => id !== removedId),
      };
    }
    case REMOVE_LOCATION: {
      // Drop the default and the reminder target if the removed location was it.
      const removed = (action as RemoveLocationAction).payload;
      let next = base;
      if (next.defaultLocationId === removed)
        next = { ...next, defaultLocationId: null };
      if (next.taskReminderLocationId === removed)
        next = { ...next, taskReminderLocationId: null };
      return next;
    }
    default:
      return base;
  }
}
