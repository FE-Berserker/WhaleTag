/**
 * md-editor 快捷键自定义模型(Settings ▸ md-editor 快捷键)。
 *
 * 与文件列表的 `domain/keybindings.ts`(key→action、Select 下拉、不处理修饰键)
 * 完全独立——md-editor 的 binding 是 CodeMirror 格式(`Mod-s` / `Mod-Shift-z` /
 * `Mod-b` …,`Mod` = Mac Cmd / Win Linux Ctrl),带修饰键,所以这里用
 * **action→combo** 的 `Record<MdKeyAction, string>`(一对一,避免两个 action
 * 抢同一个 combo——CodeMirror 会静默让最后注册的胜出,对用户是迷惑)。
 *
 * `normalizeCombo` 把一个 KeyboardEvent 翻译成 CodeMirror combo 字符串(供
 * KeyCaptureInput 用);`sanitizeMdKeybindings` 在 redux-persist rehydrate 时
 * 清洗;`formatCombo` 把 combo 渲染成人类可读(`Ctrl+Shift+S` / `⌘+Shift+S`)。
 */

/** md-editor 里用户可重绑定的动作(与 md-keymaps.ts 的 buildEditorKeymaps 一一对应)。 */
export type MdKeyAction =
  | 'save'
  | 'find'
  | 'gotoLine'
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'link'
  | 'callout'
  | 'table'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'headingIncrease'
  | 'headingDecrease'
  | 'replace';

/** 默认 binding(action → CodeMirror combo)。redo 用 Mod-Shift-z(Ctrl-Y 也绑在
 *  buildEditorKeymaps 里,但这里只暴露用户可调的主 redo 键)。 */
export const DEFAULT_MD_KEYBINDINGS: Record<MdKeyAction, string> = {
  save: 'Mod-s',
  find: 'Mod-f',
  gotoLine: 'Mod-g',
  undo: 'Mod-z',
  redo: 'Mod-Shift-z',
  bold: 'Mod-b',
  italic: 'Mod-i',
  link: 'Mod-k',
  callout: 'Mod-q',
  table: 'Mod-t',
  zoomIn: 'Mod-Shift-=',
  zoomOut: 'Mod-Shift--',
  zoomReset: 'Mod-Shift-0',
  heading1: 'Mod-1',
  heading2: 'Mod-2',
  heading3: 'Mod-3',
  heading4: 'Mod-4',
  heading5: 'Mod-5',
  heading6: 'Mod-6',
  headingIncrease: 'Mod-=',
  headingDecrease: 'Mod--',
  replace: 'Mod-h',
};

/** Settings 面板每行的元数据(action + i18n label key),展示顺序。 */
export const MD_KEY_ACTIONS: readonly { action: MdKeyAction; labelKey: string }[] = [
  { action: 'save', labelKey: 'mdActionSave' },
  { action: 'find', labelKey: 'mdActionFind' },
  { action: 'gotoLine', labelKey: 'mdActionGotoLine' },
  { action: 'bold', labelKey: 'mdActionBold' },
  { action: 'italic', labelKey: 'mdActionItalic' },
  { action: 'link', labelKey: 'mdActionLink' },
  { action: 'callout', labelKey: 'mdActionCallout' },
  { action: 'table', labelKey: 'mdActionTable' },
  { action: 'undo', labelKey: 'mdActionUndo' },
  { action: 'redo', labelKey: 'mdActionRedo' },
  { action: 'zoomIn', labelKey: 'mdActionZoomIn' },
  { action: 'zoomOut', labelKey: 'mdActionZoomOut' },
  { action: 'zoomReset', labelKey: 'mdActionZoomReset' },
  { action: 'heading1', labelKey: 'mdActionHeading1' },
  { action: 'heading2', labelKey: 'mdActionHeading2' },
  { action: 'heading3', labelKey: 'mdActionHeading3' },
  { action: 'heading4', labelKey: 'mdActionHeading4' },
  { action: 'heading5', labelKey: 'mdActionHeading5' },
  { action: 'heading6', labelKey: 'mdActionHeading6' },
  { action: 'headingIncrease', labelKey: 'mdActionHeadingIncrease' },
  { action: 'headingDecrease', labelKey: 'mdActionHeadingDecrease' },
  { action: 'replace', labelKey: 'mdActionReplace' },
];

const VALID_ACTIONS: ReadonlySet<MdKeyAction> = new Set(
  MD_KEY_ACTIONS.map((a) => a.action)
);

/** combo 有效格式:`Mod-[Shift-]<key>`(`Mod-` 开头,后跟 ≥1 段)。`''` = 无绑定。 */
export function isValidCombo(combo: string): boolean {
  if (combo === '') return true;
  return /^Mod(-\S)+$/.test(combo);
}

/**
 * 把一个 KeyboardEvent 翻译成 CodeMirror combo 字符串,供 KeyCaptureInput 用。
 * 返回值:
 *  - combo 字符串(`Mod-s` / `Mod-Shift-s` …):有效绑定,提交。
 *  - `''`:Escape —— 用户清除该 action 的绑定。
 *  - `null`:忽略(纯 modifier 按下、或没按 Mod)—— KeyCaptureInput 继续等。
 *
 * md-editor 所有 binding 都要求 Mod(Ctrl/Cmd):一个裸键会和编辑器打字 / 浏览器
 * 默认行为冲突,所以这里拒绝无 Mod 的组合,而不是让它进表。
 */
export function normalizeCombo(e: KeyboardEvent): string | null {
  if (e.key === 'Escape') return '';
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
    return null; // pure modifier — wait for the main key
  }
  if (!e.ctrlKey && !e.metaKey) return null; // md-editor bindings require Mod
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const parts = ['Mod'];
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('-');
}

/** combo → 人类可读:`Mod-Shift-s` → `Ctrl+Shift+s`(Win/Linux)或 `⌘+Shift+s`(Mac)。
 *  `Mod--`(key 是减号)→ `Ctrl+-`。空 combo → 占位符。 */
export function formatCombo(combo: string, isMac: boolean): string {
  if (combo === '') return '';
  let s = combo.replace(/^Mod-/, isMac ? '⌘+' : 'Ctrl+');
  s = s.replace(/Shift-/g, 'Shift+');
  // Any remaining '-' is the key segment separator (or the literal '-' key).
  s = s.replace(/-/g, '+');
  return s;
}

/**
 * Coerce a persisted value into a clean bindings map: drop combos that aren't
 * valid CodeMirror format, backfill missing actions from defaults. Mirrors the
 * file-list `sanitizeKeybindings` philosophy so a corrupt / hand-edited
 * persisted value never crashes the editor.
 *
 * Returns a fresh object only when something actually changed — the integrations
 * reducer relies on this to avoid the redux-persist `autoMergeLevel1` trap (see
 * `reducers/settings/system.ts` L164-194 comment): if sanitize always allocated
 * a new object, the reconciler would deem the whole settings slice dirty and
 * drop rehydrated fields (themeMode / language / …).
 */
export function sanitizeMdKeybindings(
  raw: unknown
): Record<MdKeyAction, string> {
  const defaults = { ...DEFAULT_MD_KEYBINDINGS };
  if (!raw || typeof raw !== 'object') return defaults;
  const src = raw as Record<string, unknown>;
  const out = { ...defaults };
  let changed = false;
  for (const action of Object.keys(defaults) as MdKeyAction[]) {
    const v = src[action];
    if (typeof v === 'string' && isValidCombo(v)) {
      if (v !== out[action]) {
        out[action] = v;
        changed = true;
      }
    } else if (out[action] !== defaults[action]) {
      out[action] = defaults[action];
      changed = true;
    }
  }
  return changed ? out : defaults;
}

/** Is `action` a known md-editor key action? (defensive guard for the reducer.) */
export function isMdKeyAction(action: string): action is MdKeyAction {
  return VALID_ACTIONS.has(action as MdKeyAction);
}

/** Zoom-action defaults before they moved to `Mod-Shift-=` (Typora-style), at
 *  which point `Mod-=/-` were freed for the heading-level shortcuts. Only these
 *  exact legacy values are rewritten on migrate; user-customized zoom keeps. */
const LEGACY_ZOOM_DEFAULTS: Record<'zoomIn' | 'zoomOut' | 'zoomReset', string> = {
  zoomIn: 'Mod-=',
  zoomOut: 'Mod--',
  zoomReset: 'Mod-0',
};

/** Migrate persisted md-editor keybindings forward (sanitizes, then rewrites
 *  the legacy zoom defaults `Mod-=/-` to the current `Mod-Shift-=/-` defaults).
 *  User-customized values survive. Called from migrateIntegrations on rehydrate. */
export function migrateMdKeybindings(
  raw: unknown
): Record<MdKeyAction, string> {
  const sanitized = sanitizeMdKeybindings(raw);
  let out = sanitized;
  for (const action of ['zoomIn', 'zoomOut', 'zoomReset'] as const) {
    if (out[action] === LEGACY_ZOOM_DEFAULTS[action]) {
      if (out === sanitized) out = { ...sanitized };
      out[action] = DEFAULT_MD_KEYBINDINGS[action];
    }
  }
  return out;
}
