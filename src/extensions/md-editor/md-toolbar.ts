/**
 * md-editor toolbar — navigation (goto-line), markdown formatting (bold/
 * italic/link), task-list toggling, HTML export, and toolbar button wiring.
 * Extracted from index.ts (Phase 5 of the architecture split).
 *
 * `setupToolbar()` wires the toolbar buttons (find/wrap/zoom/toc/export/
 * goto-line) + the initial wrap indicator; called once from createEditor
 * after the view mounts. The keymap shortcuts (Mod-B/I/K/G etc.) live in
 * md-keymaps.ts and call back into the formatting/navigation helpers here.
 *
 * Reads the shared `ctx` (view, currentPath, mdWrapMode, mdFontSize) + `dom`
 * (button + pane refs) from md-context.
 */
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import {
  ctx,
  dom,
  MD_DEFAULT_FONT_SIZE,
  MD_FONT_SIZE_STEP,
} from './md-context';
import {
  getStatusInfo,
  parseLineInput,
  triggerDownload,
  wrapHtmlDocument,
} from './md-render';
import { applyFontSize, applyWrap, readMdThemeVars } from './md-theme';
import { refreshToc } from './md-toc';
import { T } from './md-i18n';

/**
 * §task — toggle the `[ ]`/`[x]` of the Nth task-list line in the editor doc.
 * Dispatches a doc change → the updateListener fires schedulePreview (so the
 * preview checkbox re-renders in the new state) + marks dirty; the user
 * saves (Ctrl+S) to persist. `index` matches the preview checkbox order.
 */
export function toggleTaskInEditor(target: EditorView, index: number): void {
  const doc = target.state.doc;
  const taskRe = /^(\s*[-*+] \[)([ x])(\])/i;
  let count = 0;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo += 1) {
    const line = doc.line(lineNo);
    const m = taskRe.exec(line.text);
    if (!m) continue;
    if (count === index) {
      const isChecked = m[2].toLowerCase() === 'x';
      const from = line.from + m[1].length;
      target.dispatch({
        changes: { from, to: from + 1, insert: isChecked ? ' ' : 'x' },
      });
      return;
    }
    count += 1;
  }
}

/**
 * §18.2.1 — prompt for a line number and jump the editor cursor there.
 * Uses `window.prompt()` for the input — synchronous, no modal CSS to
 * design, matches the convention text-editor established (and avoids
 * pulling in a custom overlay layer for a feature users invoke rarely).
 *
 * Side effects: dispatches a transaction that places the cursor at
 * the start of the target line + scrolls it into view at the top of
 * the viewport (`y: 'start'`).
 *
 * Empty input / invalid input → no-op (we don't throw or toast — the
 * prompt()'s own OK button click just cancels).
 */
export function promptForLine(view: EditorView): void {
  const total = view.state.doc.lines;
  const raw = window.prompt(T.gotoPrompt.replace('{n}', String(total)), String(getStatusInfo(view.state).line));
  if (raw === null) return; // user hit Cancel
  const parsed = parseLineInput(raw, total);
  if (!parsed) {
    // Bad input — re-prompt with the hint. Three strikes is the usual
    // UX pattern but we keep it simple: one re-prompt, then bail.
    const retry = window.prompt(
      T.gotoInvalid.replace('{x}', raw).replace('{n}', String(total)),
      '1'
    );
    if (retry === null) return;
    const reparsed = parseLineInput(retry, total);
    if (!reparsed) return;
    gotoLine(view, reparsed.line);
    return;
  }
  gotoLine(view, parsed.line);
}

export function gotoLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(line, 1), doc.lines);
  const lineInfo = doc.line(lineNo);
  view.dispatch({
    selection: { anchor: lineInfo.from },
    effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start' }),
  });
  view.focus();
}

/**
 * Wrap the current selection with `before`/`after` markdown markers (e.g.
 * `**`/`**` for bold, `*`/`*` for italic). With no selection the markers are
 * inserted side by side and the cursor lands between them. §fmt — used by
 * the Mod-B / Mod-I keymap. Returns true (CodeMirror command handled).
 */
export function wrapSelection(v: EditorView, before: string, after: string): boolean {
  if (v.state.readOnly) return false;
  const sel = v.state.selection.main;
  if (sel.to <= sel.from) {
    // No selection: insert empty markers + place cursor between.
    v.dispatch({
      changes: { from: sel.from, insert: before + after },
      selection: EditorSelection.cursor(sel.from + before.length),
    });
  } else {
    const selected = v.state.sliceDoc(sel.from, sel.to);
    v.dispatch({
      changes: { from: sel.from, to: sel.to, insert: before + selected + after },
      selection: EditorSelection.range(sel.from + before.length, sel.to + before.length),
    });
  }
  v.focus();
  return true;
}

/**
 * Insert a `[text](url)` link template. The selected text becomes the link
 * text; with no selection `text` is the placeholder. The cursor then selects
 * `url` so the user can type the URL right away. §fmt — used by Mod-K.
 */
export function insertLink(v: EditorView): boolean {
  if (v.state.readOnly) return false;
  const sel = v.state.selection.main;
  const selected = sel.to > sel.from ? v.state.sliceDoc(sel.from, sel.to) : 'text';
  const insert = `[${selected}](url)`;
  // `url` starts after `[${selected}](` = selected.length + 3 chars.
  const urlStart = sel.from + selected.length + 3;
  v.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + 3),
  });
  v.focus();
  return true;
}

const TABLE_MIN_ROWS = 1;
const TABLE_MAX_ROWS = 100;
const TABLE_MIN_COLUMNS = 1;
const TABLE_MAX_COLUMNS = 20;

export interface TableDialogElements {
  /**
   * Fixed full-viewport overlay (backdrop + flex-centered panel). This used to
   * be a `<dialog>` shown via `showModal()`, but `<dialog>.showModal()`'s
   * top-layer rendering is unreliable inside the extension's nested iframe —
   * the modal silently failed to appear on Ctrl+T. A plain `<div>` overlay
   * renders in any iframe, so the table dialog reliably pops now.
   */
  overlay: HTMLDivElement;
  panel: HTMLDivElement;
  title: HTMLHeadingElement;
  columnsLabel: HTMLSpanElement;
  columnsInput: HTMLInputElement;
  rowsLabel: HTMLSpanElement;
  rowsInput: HTMLInputElement;
  cancelButton: HTMLButtonElement;
  insertButton: HTMLButtonElement;
}

let tableDialogElements: TableDialogElements | null = null;
let tableTargetView: EditorView | null = null;

function isEditable(view: EditorView): boolean {
  return !view.state.readOnly && view.state.facet(EditorView.editable);
}

function clampTableDimension(
  value: number,
  min: number,
  max: number,
  fallback: number
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Build a `> [!NOTE]\n> <body>` blockquote. Each line of the body (the
 * selection text, if any) is prefixed with `> `. Used by Mod-Q (§18.2.3).
 */
export function createCalloutMarkdown(content = ''): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  const body = normalized
    ? normalized
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')
    : '> ';
  return `> [!NOTE]\n${body}`;
}

/**
 * Build a GFM table markdown block with `rows` body rows and `columns`
 * columns. The output is a pipe-table that `marked` parses as a real
 * `<table>` — no leading/trailing whitespace tricks. Empty cells are
 * intentional so the user can tab through them.
 */
export function createTableMarkdown(rows: number, columns: number): string {
  const rowCount = clampTableDimension(
    rows,
    TABLE_MIN_ROWS,
    TABLE_MAX_ROWS,
    2
  );
  const columnCount = clampTableDimension(
    columns,
    TABLE_MIN_COLUMNS,
    TABLE_MAX_COLUMNS,
    2
  );
  const blankRow = `| ${Array(columnCount).fill('').join(' | ')} |`;
  const separator = `| ${Array(columnCount).fill('---').join(' | ')} |`;
  return [
    blankRow,
    separator,
    ...Array(Math.max(0, rowCount - 1)).fill(blankRow),
  ].join('\n');
}

function isEscapedPipe(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function markdownTableCellRanges(
  line: string
): Array<{ from: number; to: number }> {
  const firstContent = line.search(/\S/);
  if (firstContent < 0) return [];
  let lastContent = line.length - 1;
  while (lastContent >= 0 && /\s/.test(line[lastContent])) lastContent -= 1;
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '|' && !isEscapedPipe(line, i)) pipes.push(i);
  }
  const leading = pipes[0] === firstContent;
  const trailing = pipes[pipes.length - 1] === lastContent;
  const innerPipes = pipes.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  const starts = [leading ? pipes[0] + 1 : 0, ...innerPipes.map((i) => i + 1)];
  const ends = [...innerPipes, trailing ? pipes[pipes.length - 1] : line.length];
  return starts.map((from, index) => {
    let nextFrom = from;
    let nextTo = ends[index];
    if (!leading && index === 0) {
      while (nextFrom < nextTo && /\s/.test(line[nextFrom])) nextFrom += 1;
    }
    if (!trailing && index === starts.length - 1) {
      while (nextTo > nextFrom && /\s/.test(line[nextTo - 1])) nextTo -= 1;
    }
    return { from: nextFrom, to: nextTo };
  });
}

export function replaceMarkdownTableCellText(
  line: string,
  column: number,
  value: string
): string | null {
  const range = markdownTableCellRanges(line)[column];
  if (!range) return null;
  const normalized = value
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const escaped = normalized.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  return `${line.slice(0, range.from)} ${escaped} ${line.slice(range.to)}`;
}

export function replaceTableCellInEditor(
  view: EditorView,
  sourceLine: number,
  column: number,
  value: string
): boolean {
  if (!isEditable(view) || sourceLine < 1 || sourceLine > view.state.doc.lines) {
    return false;
  }
  const line = view.state.doc.line(sourceLine);
  const next = replaceMarkdownTableCellText(line.text, column, value);
  if (next === null) return false;
  if (next === line.text) return true;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
  return true;
}

function insertMarkdownBlock(
  view: EditorView,
  markdown: string,
  cursorOffset: number
): boolean {
  if (!isEditable(view)) return false;
  const { from, to } = view.state.selection.main;
  const before = view.state.sliceDoc(0, from);
  const after = view.state.sliceDoc(to);
  const prefix =
    before.length === 0 || before.endsWith('\n\n')
      ? ''
      : before.endsWith('\n')
        ? '\n'
        : '\n\n';
  const suffix =
    after.length === 0 || after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n';
  const insert = `${prefix}${markdown}${suffix}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + prefix.length + cursorOffset),
  });
  view.focus();
  return true;
}

export function insertCallout(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const { from, to } = view.state.selection.main;
  const markdown = createCalloutMarkdown(view.state.sliceDoc(from, to));
  return insertMarkdownBlock(view, markdown, markdown.length);
}

export function insertTable(
  view: EditorView,
  rows: number,
  columns: number
): boolean {
  const markdown = createTableMarkdown(rows, columns);
  return insertMarkdownBlock(view, markdown, 2);
}

function createNumberField(
  name: string,
  min: number,
  max: number,
  value: number
): {
  label: HTMLLabelElement;
  labelText: HTMLSpanElement;
  input: HTMLInputElement;
} {
  const label = document.createElement('label');
  label.className = 'md-table-dialog-field';
  const labelText = document.createElement('span');
  const input = document.createElement('input');
  input.type = 'number';
  input.name = name;
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.required = true;
  input.inputMode = 'numeric';
  label.append(labelText, input);
  return { label, labelText, input };
}

export function createTableDialogElements(
  onInsert: (rows: number, columns: number) => void,
  onClose: () => void
): TableDialogElements {
  // §table-dialog — plain `<div>` overlay (NOT `<dialog>`/showModal). showModal's
  // top-layer rendering is unreliable in this nested extension iframe; a div
  // overlay with a fixed backdrop works everywhere. No `<form>`: under a strict
  // CSP a form submit would reload the iframe, so the buttons are type=button
  // and Enter is handled by the keydown listener.
  const overlay = document.createElement('div');
  overlay.className = 'md-table-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'md-table-dialog-title');
  overlay.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'md-table-dialog-panel';

  const title = document.createElement('h2');
  title.id = 'md-table-dialog-title';
  title.className = 'md-table-dialog-title';

  const fields = document.createElement('div');
  fields.className = 'md-table-dialog-fields';
  const columns = createNumberField(
    'columns',
    TABLE_MIN_COLUMNS,
    TABLE_MAX_COLUMNS,
    2
  );
  const rows = createNumberField('rows', TABLE_MIN_ROWS, TABLE_MAX_ROWS, 2);
  fields.append(columns.label, rows.label);

  const actions = document.createElement('div');
  actions.className = 'md-table-dialog-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  const insertButton = document.createElement('button');
  insertButton.type = 'button';
  insertButton.className = 'primary';
  actions.append(cancelButton, insertButton);

  panel.append(title, fields, actions);
  overlay.append(panel);
  document.body.append(overlay);

  const close = (): void => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    onClose();
  };
  const submit = (): void => {
    if (!columns.input.checkValidity()) {
      columns.input.reportValidity();
      columns.input.focus();
      return;
    }
    if (!rows.input.checkValidity()) {
      rows.input.reportValidity();
      rows.input.focus();
      return;
    }
    onInsert(rows.input.valueAsNumber, columns.input.valueAsNumber);
    close();
  };

  cancelButton.addEventListener('click', close);
  insertButton.addEventListener('click', submit);
  // Click on the backdrop (the overlay itself, not the panel) closes — matches
  // `<dialog>.showModal()`'s light-dismiss feel without its top-layer quirks.
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  });

  return {
    overlay,
    panel,
    title,
    columnsLabel: columns.labelText,
    columnsInput: columns.input,
    rowsLabel: rows.labelText,
    rowsInput: rows.input,
    cancelButton,
    insertButton,
  };
}

function ensureTableDialog(): TableDialogElements {
  if (tableDialogElements) return tableDialogElements;
  tableDialogElements = createTableDialogElements(
    (rows, columns) => {
      const target = tableTargetView;
      if (target) insertTable(target, rows, columns);
    },
    () => {
      const target = tableTargetView;
      tableTargetView = null;
      if (target) target.focus();
    }
  );
  return tableDialogElements;
}

export function openTableDialog(view: EditorView): boolean {
  if (!isEditable(view)) return false;
  const elements = ensureTableDialog();
  elements.title.textContent = T.tableDialogTitle;
  elements.columnsLabel.textContent = T.tableColumns;
  elements.rowsLabel.textContent = T.tableRows;
  elements.cancelButton.textContent = T.tableCancel;
  elements.insertButton.textContent = T.tableInsert;
  tableTargetView = view;
  elements.overlay.hidden = false;
  elements.columnsInput.focus();
  elements.columnsInput.select();
  return true;
}

/**
 * §18.3.2 — export the current preview as a self-contained HTML file.
 * Wraps `previewPane.innerHTML` in a full document with inline CSS
 * (subset of editor.css that renders the document, not the chrome) and
 * triggers a browser download. Filename is the basename of the current
 * path (sans extension) + `.html`. If no path is open, falls back to
 * `untitled.html`.
 */
export function exportPreviewAsHtml(): void {
  const themeVars = readMdThemeVars();
  if (!ctx.currentPath) {
    triggerDownload(
      'untitled.html',
      wrapHtmlDocument('Untitled', dom.previewPane.innerHTML, themeVars),
      'text/html'
    );
    return;
  }
  // Strip the .md / .markdown extension from the basename.
  const sep = Math.max(ctx.currentPath.lastIndexOf('/'), ctx.currentPath.lastIndexOf('\\'));
  const fileName = sep >= 0 ? ctx.currentPath.slice(sep + 1) : ctx.currentPath;
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const outName = `${stem}.html`;
  const title = stem || 'Untitled';
  triggerDownload(
    outName,
    wrapHtmlDocument(title, dom.previewPane.innerHTML, themeVars),
    'text/html'
  );
}

/**
 * §toolbar — wire the toolbar buttons (find/wrap/zoom/toc/export/goto-line)
 * + the initial wrap indicator. Called once from createEditor after the view
 * mounts. Each click goes through the `apply*()` helpers so the persisted
 * value, the compartment reconfiguration, and the toolbar indicator stay
 * in sync.
 */
export function setupToolbar(): void {
  dom.gotoLineBtn.addEventListener('click', () => {
    if (ctx.view) promptForLine(ctx.view);
  });
  dom.findBtn.addEventListener('click', () => {
    if (ctx.view) openSearchPanel(ctx.view);
  });
  dom.toggleWrapBtn.addEventListener('click', () => {
    if (!ctx.view) return;
    applyWrap(ctx.mdWrapMode === 'wrap' ? 'nowrap' : 'wrap', ctx.view);
  });
  dom.zoomInBtn.addEventListener('click', () => {
    if (ctx.view) applyFontSize(ctx.mdFontSize + MD_FONT_SIZE_STEP, ctx.view);
  });
  dom.zoomOutBtn.addEventListener('click', () => {
    if (ctx.view) applyFontSize(ctx.mdFontSize - MD_FONT_SIZE_STEP, ctx.view);
  });
  dom.zoomResetBtn.addEventListener('click', () => {
    if (ctx.view) applyFontSize(MD_DEFAULT_FONT_SIZE, ctx.view);
  });

  // §18.3.1 — TOC toggle. Re-extracts from the current doc on open
  // (so the sidebar is populated immediately, not only on next edit).
  dom.toggleTocBtn.addEventListener('click', () => {
    if (!ctx.view) return;
    const willShow = dom.tocSidebarEl.hasAttribute('hidden');
    if (willShow) {
      dom.tocSidebarEl.removeAttribute('hidden');
      dom.toggleTocBtn.classList.add('active');
      refreshToc(ctx.view.state.doc.toString());
    } else {
      dom.tocSidebarEl.setAttribute('hidden', '');
      dom.toggleTocBtn.classList.remove('active');
    }
  });

  // §18.3.2 — Export Preview as HTML. Uses the current `previewPane`
  // innerHTML (which has been sanitized + highlighted + image-resolved).
  dom.exportHtmlBtn.addEventListener('click', () => {
    exportPreviewAsHtml();
  });

  // Initial toolbar state indicator.
  dom.wrapStateEl.textContent = ctx.mdWrapMode === 'wrap' ? T.wrapOn : T.wrapOff;
  dom.toggleWrapBtn.classList.toggle('active', ctx.mdWrapMode === 'wrap');
}

/** §heading — toggle the current line's ATX heading to `level` (1-6). If the
 *  line is already that level, the heading is removed; if it's a different
 *  heading level, it's changed to `level`; otherwise `level` `#`s are added. */
export function toggleHeading(view: EditorView, level: number): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const text = line.text;
  const m = /^(#{1,6})\s+/.exec(text);
  let next: string;
  if (m && m[1].length === level) {
    next = text.slice(m[0].length);
  } else if (m) {
    next = '#'.repeat(level) + ' ' + text.slice(m[0].length);
  } else {
    next = '#'.repeat(level) + ' ' + text;
  }
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
}

/** §heading — bump the current line's heading level up one (max 6). No-op on a
 *  non-heading line. */
export function increaseHeading(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(#{1,6})\s+/.exec(line.text);
  if (!m) return;
  const level = m[1].length;
  if (level >= 6) return;
  const next = '#'.repeat(level + 1) + ' ' + line.text.slice(m[0].length);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
}

/** §heading — drop the current line's heading level by one; at level 1 the
 *  heading is removed entirely. No-op on a non-heading line. */
export function decreaseHeading(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(#{1,6})\s+/.exec(line.text);
  if (!m) return;
  const level = m[1].length;
  if (level <= 1) {
    const next = line.text.slice(m[0].length);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
    return;
  }
  const next = '#'.repeat(level - 1) + ' ' + line.text.slice(m[0].length);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
}
