/**
 * md-editor right-click context menu (§context-menu). Custom in-iframe DOM
 * menu — an Electron native menu would need a full IPC round trip per item
 * (and per-open state), while an in-page menu reads `ctx.view` lazily and
 * shares the extension's chrome styling (`--md-*` vars in editor.css).
 *
 * Two surfaces:
 *  - editorPane: the full menu (history / clipboard / format / heading /
 *    insert / navigate / view / export). State is evaluated per open:
 *    `readOnly` disables every editing item (Cut/Paste/Bold/Italic/Link/
 *    Heading/Insert/Undo/Redo); empty selection disables Cut/Copy.
 *  - previewPane: a small menu (Copy selected text / Export as HTML).
 *
 * Paste has no iframe-native channel (Permissions-Policy), so it goes
 * through the host: `requestClipboardText` → main-process Electron
 * `clipboard.readText()` → `clipboardText` reply (see rpc-cases.ts).
 * `handleClipboardText` is the index.ts landing spot for that reply.
 */
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { ctx, dom, MD_FONT_SIZE_STEP, MD_DEFAULT_FONT_SIZE } from './md-context';
import { copyToClipboard } from './md-render';
import {
  wrapSelection,
  insertLink,
  toggleHeading,
  increaseHeading,
  decreaseHeading,
  insertCallout,
  openTableDialog,
  promptForLine,
  exportPreviewAsHtml,
} from './md-toolbar';
import { applyWrap, applyFontSize } from './md-theme';
import { T } from './md-i18n';

// --- Model ------------------------------------------------------------------

interface MenuItem {
  type: 'item';
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  submenu?: MenuEntry[];
  onSelect?: () => void;
}
interface MenuSeparator {
  type: 'separator';
}
type MenuEntry = MenuItem | MenuSeparator;

function editorMenuEntries(): MenuEntry[] {
  const v = ctx.view;
  if (!v) return [];
  const readOnly = v.state.readOnly;
  const hasSelection = !v.state.selection.main.empty;
  return [
    { type: 'item', label: T.undo, shortcut: 'Ctrl+Z', disabled: readOnly, onSelect: () => { undo(v); } },
    { type: 'item', label: T.redo, shortcut: 'Ctrl+Shift+Z', disabled: readOnly, onSelect: () => { redo(v); } },
    { type: 'separator' },
    { type: 'item', label: T.cut, shortcut: 'Ctrl+X', disabled: readOnly || !hasSelection, onSelect: cutSelection },
    { type: 'item', label: T.copy, shortcut: 'Ctrl+C', disabled: !hasSelection, onSelect: copySelection },
    { type: 'item', label: T.paste, shortcut: 'Ctrl+V', disabled: readOnly, onSelect: () => { void pasteFromClipboard(); } },
    { type: 'item', label: T.selectAll, shortcut: 'Ctrl+A', onSelect: () => {
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    } },
    { type: 'separator' },
    { type: 'item', label: T.bold, shortcut: 'Ctrl+B', disabled: readOnly, onSelect: () => { wrapSelection(v, '**', '**'); } },
    { type: 'item', label: T.italic, shortcut: 'Ctrl+I', disabled: readOnly, onSelect: () => { wrapSelection(v, '*', '*'); } },
    { type: 'item', label: T.link, shortcut: 'Ctrl+K', disabled: readOnly, onSelect: () => { insertLink(v); } },
    {
      type: 'item',
      label: T.heading,
      disabled: readOnly,
      submenu: [
        { type: 'item', label: T.heading1, onSelect: () => toggleHeading(v, 1) },
        { type: 'item', label: T.heading2, onSelect: () => toggleHeading(v, 2) },
        { type: 'item', label: T.heading3, onSelect: () => toggleHeading(v, 3) },
        { type: 'separator' },
        { type: 'item', label: T.headingIncrease, onSelect: () => { increaseHeading(v); } },
        { type: 'item', label: T.headingDecrease, onSelect: () => { decreaseHeading(v); } },
      ],
    },
    { type: 'separator' },
    { type: 'item', label: T.insertCallout, disabled: readOnly, onSelect: () => { insertCallout(v); } },
    { type: 'item', label: T.insertTable, disabled: readOnly, onSelect: () => { openTableDialog(v); } },
    { type: 'separator' },
    { type: 'item', label: T.findReplace, shortcut: 'Ctrl+F', onSelect: () => { openSearchPanel(v); } },
    { type: 'item', label: T.gotoLineMenu, shortcut: 'Ctrl+G', onSelect: () => { promptForLine(v); } },
    { type: 'separator' },
    { type: 'item', label: T.wordWrap, checked: ctx.mdWrapMode === 'wrap', onSelect: () => {
      applyWrap(ctx.mdWrapMode === 'wrap' ? 'nowrap' : 'wrap', v);
    } },
    { type: 'item', label: T.zoomInMenu, shortcut: 'Ctrl+=', onSelect: () => {
      applyFontSize(ctx.mdFontSize + MD_FONT_SIZE_STEP, v);
    } },
    { type: 'item', label: T.zoomOutMenu, shortcut: 'Ctrl+-', onSelect: () => {
      applyFontSize(ctx.mdFontSize - MD_FONT_SIZE_STEP, v);
    } },
    { type: 'item', label: T.zoomResetMenu, shortcut: 'Ctrl+0', onSelect: () => {
      applyFontSize(MD_DEFAULT_FONT_SIZE, v);
    } },
    { type: 'separator' },
    { type: 'item', label: T.exportAsHtml, onSelect: () => { exportPreviewAsHtml(); } },
  ];
}

function previewMenuEntries(): MenuEntry[] {
  const selected = window.getSelection()?.toString() ?? '';
  return [
    { type: 'item', label: T.copy, shortcut: 'Ctrl+C', disabled: selected.length === 0, onSelect: () => {
      void copyToClipboard(window.getSelection()?.toString() ?? '');
    } },
    { type: 'separator' },
    { type: 'item', label: T.exportAsHtml, onSelect: () => { exportPreviewAsHtml(); } },
  ];
}

// --- Clipboard bridge (Paste) ------------------------------------------------

const pendingClipboard = new Map<string, (text: string) => void>();
let clipboardReqId = 0;

/** Landing spot for the host's `clipboardText` reply (index.ts routes it here). */
export function handleClipboardText(msg: { requestId: string; text: string }): void {
  const resolve = pendingClipboard.get(msg.requestId);
  if (!resolve) return;
  pendingClipboard.delete(msg.requestId);
  resolve(msg.text);
}

function requestClipboardText(): Promise<string> {
  const requestId = `clip-${++clipboardReqId}`;
  return new Promise<string>((resolve) => {
    pendingClipboard.set(requestId, resolve);
    window.whaleExt.postMessage({ type: 'requestClipboardText', requestId });
  });
}

function cutSelection(): void {
  const v = ctx.view;
  if (!v) return;
  const { from, to } = v.state.selection.main;
  void copyToClipboard(v.state.sliceDoc(from, to));
  if (!v.state.readOnly) {
    v.dispatch(v.state.replaceSelection(''));
  }
}

function copySelection(): void {
  const v = ctx.view;
  if (!v) return;
  const { from, to } = v.state.selection.main;
  void copyToClipboard(v.state.sliceDoc(from, to));
}

async function pasteFromClipboard(): Promise<void> {
  const text = await requestClipboardText();
  const v = ctx.view;
  if (!text || !v || v.state.readOnly) return;
  v.dispatch(v.state.replaceSelection(text));
}

// --- Positioning (pure, testable) --------------------------------------------

/** Clamp a menu's top-left so it stays fully inside the viewport (with a
 *  small margin). Exported for tests — jsdom can't lay out real rects. */
export function computeMenuPosition(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  viewportW: number,
  viewportH: number,
  margin = 4
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, viewportW - menuW - margin));
  const top = Math.max(margin, Math.min(y, viewportH - menuH - margin));
  return { left, top };
}

// --- DOM menu ----------------------------------------------------------------

let openMenuEl: HTMLDivElement | null = null;
let openSubmenuEl: HTMLDivElement | null = null;
let outsideAttached = false;

function closeMenu(): void {
  openMenuEl?.remove();
  openMenuEl = null;
  closeSubmenu();
}

function closeSubmenu(): void {
  openSubmenuEl?.remove();
  openSubmenuEl = null;
}

function attachGlobalClosers(): void {
  if (outsideAttached) return;
  outsideAttached = true;
  document.addEventListener(
    'mousedown',
    (e) => {
      const t = e.target as Node | null;
      if (openMenuEl && t && !openMenuEl.contains(t) && !(openSubmenuEl?.contains(t) ?? false)) {
        closeMenu();
      }
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
    }
  });
  window.addEventListener('blur', closeMenu);
}

function buildMenuDom(entries: MenuEntry[], isSubmenu = false): HTMLDivElement {
  const el = document.createElement('div');
  el.className = isSubmenu ? 'cm-context-menu submenu' : 'cm-context-menu';
  el.setAttribute('role', 'menu');
  for (const entry of entries) {
    if (entry.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'cm-context-sep';
      el.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-context-item' + (entry.disabled ? ' disabled' : '');
    btn.setAttribute('role', 'menuitem');
    if (entry.disabled) btn.setAttribute('aria-disabled', 'true');

    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = entry.checked ? '✓' : '';
    btn.appendChild(check);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.label;
    btn.appendChild(label);

    if (entry.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'shortcut';
      sc.textContent = entry.shortcut;
      btn.appendChild(sc);
    }
    if (entry.submenu) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '▸';
      btn.appendChild(arrow);
      btn.addEventListener('mouseenter', () => openSubmenu(btn, entry.submenu!));
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSubmenu(btn, entry.submenu!);
      });
    } else if (!entry.disabled) {
      btn.addEventListener('click', () => {
        closeMenu();
        entry.onSelect?.();
      });
    }
    el.appendChild(btn);
  }
  return el;
}

function openSubmenu(anchor: HTMLElement, entries: MenuEntry[]): void {
  if (openSubmenuEl && openSubmenuEl.dataset.anchor === anchor.dataset.menuKey) return;
  closeSubmenu();
  if (!anchor.dataset.menuKey) {
    anchor.dataset.menuKey = `k${Math.random().toString(36).slice(2)}`;
  }
  const el = buildMenuDom(entries, true);
  el.dataset.anchor = anchor.dataset.menuKey;
  document.body.appendChild(el);
  openSubmenuEl = el;
  const r = anchor.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const pos = computeMenuPosition(
    r.right - 2,
    r.top - 4,
    rect.width,
    rect.height,
    window.innerWidth,
    window.innerHeight
  );
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
}

function openMenu(entries: MenuEntry[], x: number, y: number): void {
  closeMenu();
  if (entries.length === 0) return;
  attachGlobalClosers();
  const el = buildMenuDom(entries);
  document.body.appendChild(el);
  openMenuEl = el;
  const rect = el.getBoundingClientRect();
  const pos = computeMenuPosition(
    x,
    y,
    rect.width,
    rect.height,
    window.innerWidth,
    window.innerHeight
  );
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
}

/** Wire both surfaces. Called once at boot (menu state is evaluated lazily
 *  per open, so no re-attachment is needed across file switches). */
export function setupContextMenu(): void {
  dom.editorPane.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(editorMenuEntries(), e.clientX, e.clientY);
  });
  dom.previewPane.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(previewMenuEntries(), e.clientX, e.clientY);
  });
}

/** Test hook: close any open menu (teardown). */
export function _closeContextMenuForTest(): void {
  closeMenu();
}
