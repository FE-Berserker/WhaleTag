import './viewer.css';

interface Strings {
  loading: string;
  empty: string;
  error: string;
  nestedArchive: string;
  binaryLabel: string;
  systemApp: string;
  bytesLabel: string;
  entriesLabel: string;
  noPreview: string;
  tooLarge: string;
  extractToFolder: string;
  extracting: string;
  extractDone: string;
  extractFailed: string;
  extractResult: string;
  zipBombWarning: string;
  confirmExtractAnyway: string;
  passwordRequired: string;
  passwordPrompt: string;
  ok: string;
  cancel: string;
}

const I18N: Record<string, Strings> = {
  en: {
    loading: 'Loading…',
    empty: 'This archive is empty.',
    error: 'Could not open archive: {msg}',
    nestedArchive:
      'This entry is a nested archive. Open with system app to view its contents.',
    binaryLabel: 'Binary file. Hex header:',
    systemApp: 'Open with system app',
    bytesLabel: 'bytes',
    entriesLabel: '{n} entries',
    noPreview: 'Select an entry from the tree to preview it.',
    tooLarge:
      'This archive contains too many entries ({n}) to render in the viewer. Open with system app.',
    extractToFolder: 'Extract to folder…',
    extracting: 'Extracting…',
    extractDone: 'Extraction complete.',
    extractFailed: 'Extraction failed: {msg}',
    extractResult: 'Written: {written} · Skipped: {skipped} · Errors: {errors}',
    zipBombWarning:
      'This entry has an extreme compression ratio and may be a zip-bomb. Extract/view anyway?',
    confirmExtractAnyway: 'This archive has an extreme compression ratio. Extract anyway?',
    passwordRequired: 'This archive is encrypted. Please enter the password:',
    passwordPrompt: 'Password',
    ok: 'OK',
    cancel: 'Cancel',
  },
  zh: {
    loading: '加载中…',
    empty: '此压缩包为空。',
    error: '无法打开压缩包:{msg}',
    nestedArchive: '此条目为嵌套压缩包。请用系统应用打开查看。',
    binaryLabel: '二进制文件。十六进制头部:',
    systemApp: '用系统应用打开',
    bytesLabel: '字节',
    entriesLabel: '{n} 个条目',
    noPreview: '请在左侧树中选择条目预览。',
    tooLarge: '此压缩包条目过多({n} 个),无法在查看器中渲染。请用系统应用打开。',
    extractToFolder: '解压到文件夹…',
    extracting: '解压中…',
    extractDone: '解压完成。',
    extractFailed: '解压失败:{msg}',
    extractResult: '已写入:{written} · 已跳过:{skipped} · 错误:{errors}',
    zipBombWarning: '此条目压缩率极高,可能是压缩炸弹。仍要查看/解压?',
    confirmExtractAnyway: '此压缩包压缩率极高,仍要解压?',
    passwordRequired: '此压缩包已加密,请输入密码:',
    passwordPrompt: '密码',
    ok: '确定',
    cancel: '取消',
  },
};

let T: Strings = I18N.en;

/** UI element typed getter; throws if a required element is missing. */
function getEl<T extends HTMLElement>(id: string, _cls: new () => T): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

// --- DOM refs ---
const toolbarNameEl = getEl('archive-name', HTMLSpanElement);
const toolbarStatusEl = getEl('status', HTMLSpanElement);
const toolbarOpenNativeBtn = getEl('open-system', HTMLButtonElement);
const toolbarExtractBtn = getEl('extract-folder', HTMLButtonElement);
const treeEl = getEl('tree', HTMLElement);
const previewEl = getEl('preview', HTMLElement);
const errorEl = getEl('error', HTMLDivElement);
const errorMessageEl = getEl('error-message', HTMLParagraphElement);
const openNativeBtn = getEl('btn-open-native', HTMLButtonElement);
const dialogEl = getEl('dialog', HTMLDivElement);
const dialogTitleEl = getEl('dialog-title', HTMLParagraphElement);
const dialogInputEl = getEl('dialog-input', HTMLInputElement);
const dialogOkBtn = getEl('dialog-ok', HTMLButtonElement);
const dialogCancelBtn = getEl('dialog-cancel', HTMLButtonElement);

// --- Tree model ---
interface TreeFile {
  name: string;
  path: string;
  size: number;
}
interface TreeDir {
  name: string;
  path: string;
  children: TreeNode[];
}
type TreeNode = TreeDir | TreeFile;

let currentPath: string | null = null;
let currentEntries: TreeFile[] = [];
let currentEntryBlobUrl: string | null = null;
let pendingRequestId: string | null = null;
let pendingPassword: string | undefined;
let pendingForce: boolean | undefined;

// --- Helpers ---
function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable hex string of the first `count` bytes, e.g. `00 01 02 03`. */
function hexHead(bytes: Uint8Array, count: number): string {
  const n = Math.min(count, bytes.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

function mimeFor(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'avif',
]);

const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'xml',
  'html',
  'htm',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'ini',
  'log',
  'env',
  'toml',
  'conf',
  'cfg',
  'properties',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'less',
  'sass',
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'hh',
  'sh',
  'bash',
  'zsh',
  'bat',
  'cmd',
  'ps1',
  'sql',
  'diff',
  'patch',
  'gitignore',
  'editorconfig',
]);

function isArchiveExt(ext: string): boolean {
  return ['zip', 'tar', 'tgz', 'tbz2', 'txz', 'gz', 'bz2', 'xz', '7z'].includes(ext);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = window.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- UI helpers ---
function setStatus(text: string) {
  toolbarStatusEl.textContent = text;
}

function setToolbarNativeOpen(path: string | null) {
  toolbarOpenNativeBtn.hidden = path == null;
  toolbarExtractBtn.hidden = path == null;
  toolbarOpenNativeBtn.dataset.path = path ?? '';
}

function showError(message: string, path: string | null) {
  errorMessageEl.textContent = message;
  errorEl.classList.remove('hidden');
  previewEl.innerHTML = '';
  treeEl.innerHTML = '';
  setToolbarNativeOpen(path);
  if (path) openNativeBtn.dataset.path = path;
}

function clearError() {
  errorEl.classList.add('hidden');
}

function applyTheme(theme: 'light' | 'dark') {
  document.body.setAttribute('data-theme', theme);
}

function applyLocale() {
  T = window.whaleExt.t(I18N);
  document.documentElement.lang = window.whaleExt.locale;
  toolbarOpenNativeBtn.textContent = T.systemApp;
  toolbarExtractBtn.textContent = T.extractToFolder;
  openNativeBtn.textContent = T.systemApp;
  dialogOkBtn.textContent = T.ok;
  dialogCancelBtn.textContent = T.cancel;
  dialogInputEl.placeholder = T.passwordPrompt;
}

// --- Tree rendering ---
function buildTree(entries: TreeFile[]): TreeDir {
  const root: TreeDir = { name: '', path: '', children: [] };
  const dirByPath = new Map<string, TreeDir>();
  dirByPath.set('', root);

  const sorted = [...entries].sort((a, b) => naturalCompare(a.path, b.path));
  for (const entry of sorted) {
    const parts = entry.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let parent = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      let next = dirByPath.get(acc);
      if (!next) {
        next = { name: part, path: acc, children: [] };
        dirByPath.set(acc, next);
        parent.children.push(next);
      }
      parent = next;
    }
    const fileName = parts[parts.length - 1];
    parent.children.push({
      name: fileName,
      path: entry.path,
      size: entry.size,
    });
  }

  const sortChildren = (n: TreeNode): void => {
    if ('children' in n) {
      n.children.sort((a, b) => {
        const aDir = 'children' in a;
        const bDir = 'children' in b;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return naturalCompare(a.name, b.name);
      });
      n.children.forEach(sortChildren);
    }
  };
  sortChildren(root);
  return root;
}

function renderTreeChildren(parentEl: HTMLElement, nodes: TreeNode[]) {
  const ul = document.createElement('ul');
  ul.className = 'tree-children';
  for (const node of nodes) {
    const li = document.createElement('li');
    li.className = 'tree-node';
    if ('children' in node) {
      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle';
      toggle.textContent = '▸';
      toggle.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'tree-label dir';
      label.textContent = `📁 ${node.name}`;
      label.title = node.path;
      const nested = document.createElement('ul');
      nested.className = 'tree-children collapsed';
      renderTreeChildren(nested, node.children);
      const onToggle = () => {
        const collapsed = nested.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '▸' : '▾';
      };
      label.addEventListener('click', onToggle);
      toggle.addEventListener('click', onToggle);
      li.appendChild(toggle);
      li.appendChild(label);
      li.appendChild(nested);
    } else {
      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle-spacer';
      toggle.textContent = ' ';
      const label = document.createElement('span');
      label.className = 'tree-label file';
      const ext = extOf(node.name);
      const icon = IMAGE_EXT.has(ext) ? '🖼' : isArchiveExt(ext) ? '🗜' : '📄';
      label.textContent = `${icon} ${node.name}`;
      label.title = `${node.path} · ${node.size.toLocaleString()} ${T.bytesLabel}`;
      label.addEventListener('click', () => {
        highlightSelected(label);
        showPreview(node);
      });
      li.appendChild(toggle);
      li.appendChild(label);
    }
    ul.appendChild(li);
  }
  parentEl.appendChild(ul);
}

function highlightSelected(target: HTMLElement) {
  treeEl
    .querySelectorAll('.tree-label.file.selected')
    .forEach((el) => el.classList.remove('selected'));
  target.classList.add('selected');
}

// --- Preview rendering ---
function clearPreview() {
  previewEl.innerHTML = '';
  if (currentEntryBlobUrl != null) {
    URL.revokeObjectURL(currentEntryBlobUrl);
    currentEntryBlobUrl = null;
  }
}

function showPreview(file: TreeFile) {
  clearPreview();
  const ext = extOf(file.name);

  if (isArchiveExt(ext)) {
    const card = document.createElement('div');
    card.className = 'placeholder-card';
    const title = document.createElement('p');
    title.className = 'placeholder-title';
    title.textContent = file.name;
    const body = document.createElement('p');
    body.className = 'placeholder-body';
    body.textContent = T.nestedArchive;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.type = 'button';
    btn.textContent = T.systemApp;
    btn.addEventListener('click', () => openCurrentInSystemApp());
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(btn);
    previewEl.appendChild(card);
    return;
  }

  requestArchiveEntry(file.path);
}

function renderImagePreview(fileName: string, bytes: Uint8Array, ext: string) {
  const blob = new Blob([bytes.slice()], { type: mimeFor(ext) });
  currentEntryBlobUrl = URL.createObjectURL(blob);
  const img = document.createElement('img');
  img.className = 'preview-image';
  img.alt = fileName;
  img.src = currentEntryBlobUrl;
  previewEl.appendChild(img);
}

function renderTextPreview(fileName: string, bytes: Uint8Array) {
  const TEXT_PREVIEW_LIMIT = 1_048_576;
  const truncated = bytes.byteLength > TEXT_PREVIEW_LIMIT;
  const slice = truncated ? bytes.slice(0, TEXT_PREVIEW_LIMIT) : bytes;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = decoder.decode(slice);
  if (truncated) {
    text += `\n\n[… truncated; file is ${bytes.byteLength} ${T.bytesLabel} …]`;
  }
  const pre = document.createElement('pre');
  pre.className = 'preview-text';
  pre.textContent = text;
  previewEl.appendChild(pre);
}

function renderHtmlPreview(fileName: string, bytes: Uint8Array) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const wrapperHtml =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style>html,body{margin:0;padding:16px;font-family:sans-serif;color:#222;}' +
    'img{max-width:100%;}</style></head><body>' +
    text +
    '</body></html>';
  const blob = new Blob([wrapperHtml], { type: 'text/html' });
  currentEntryBlobUrl = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.className = 'preview-html';
  iframe.sandbox = '';
  iframe.src = currentEntryBlobUrl;
  previewEl.appendChild(iframe);
}

function renderBinaryPreview(file: TreeFile, bytes: Uint8Array) {
  const card = document.createElement('div');
  card.className = 'placeholder-card';
  const title = document.createElement('p');
  title.className = 'placeholder-title';
  title.textContent = `${file.name} — ${bytes.byteLength.toLocaleString()} ${T.bytesLabel}`;
  const body = document.createElement('p');
  body.className = 'placeholder-body';
  body.textContent = T.binaryLabel;
  const hex = document.createElement('pre');
  hex.className = 'preview-hex';
  hex.textContent = hexHead(bytes, 16);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(hex);
  previewEl.appendChild(card);
}

function renderEntry(file: TreeFile, base64: string) {
  clearPreview();
  const ext = extOf(file.name);
  const bytes = base64ToBytes(base64);

  if (IMAGE_EXT.has(ext)) {
    renderImagePreview(file.name, bytes, ext);
    return;
  }
  if (TEXT_EXT.has(ext)) {
    renderTextPreview(file.name, bytes);
    return;
  }
  if (ext === 'html' || ext === 'htm') {
    renderHtmlPreview(file.name, bytes);
    return;
  }
  renderBinaryPreview(file, bytes);
}

function renderTree(root: TreeDir) {
  treeEl.innerHTML = '';
  renderTreeChildren(treeEl, root.children);
}

function showEmptyState() {
  treeEl.innerHTML = '';
  const msg = document.createElement('p');
  msg.className = 'tree-empty';
  msg.textContent = T.empty;
  treeEl.appendChild(msg);
}

function showNoPreviewPlaceholder() {
  previewEl.innerHTML = '';
  const msg = document.createElement('p');
  msg.className = 'preview-empty';
  msg.textContent = T.noPreview;
  previewEl.appendChild(msg);
}

// --- Host communication ---
function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function requestArchiveList(path: string) {
  const requestId = newRequestId();
  pendingRequestId = requestId;
  window.whaleExt.postMessage({
    type: 'requestArchiveList',
    requestId,
    path,
    password: pendingPassword,
  });
}

function requestArchiveEntry(entryPath: string) {
  const requestId = newRequestId();
  pendingRequestId = requestId;
  window.whaleExt.postMessage({
    type: 'requestArchiveEntry',
    requestId,
    path: currentPath ?? '',
    entryPath,
    password: pendingPassword,
    force: pendingForce,
  });
}

function openArchive(path: string) {
  clearError();
  clearPreview();
  currentPath = path;
  toolbarNameEl.textContent = path.split(/[\\/]/).pop() ?? path;
  setStatus(T.loading);
  showNoPreviewPlaceholder();
  setToolbarNativeOpen(path);
  requestArchiveList(path);
}

function cleanup() {
  currentPath = null;
  currentEntries = [];
  pendingPassword = undefined;
  pendingForce = undefined;
  clearPreview();
  treeEl.innerHTML = '';
  showNoPreviewPlaceholder();
  toolbarNameEl.textContent = '';
  setStatus('');
  setToolbarNativeOpen(null);
}

// --- Event wiring ---
function openCurrentInSystemApp(path?: string) {
  const target = path ?? currentPath;
  if (!target) return;
  window.whaleExt.postMessage({ type: 'openLinkExternally', url: target });
}

toolbarOpenNativeBtn.addEventListener('click', () => openCurrentInSystemApp());
openNativeBtn.addEventListener('click', () =>
  openCurrentInSystemApp(openNativeBtn.dataset.path || undefined)
);

function showDialog(title: string, password: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    dialogTitleEl.textContent = title;
    dialogInputEl.type = password ? 'password' : 'text';
    dialogInputEl.value = '';
    dialogEl.classList.remove('hidden');
    dialogInputEl.focus();

    const onOk = () => {
      cleanupDialog();
      resolve(dialogInputEl.value);
    };
    const onCancel = () => {
      cleanupDialog();
      resolve(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    };

    function cleanupDialog() {
      dialogEl.classList.add('hidden');
      dialogOkBtn.removeEventListener('click', onOk);
      dialogCancelBtn.removeEventListener('click', onCancel);
      dialogInputEl.removeEventListener('keydown', onKey);
    }

    dialogOkBtn.addEventListener('click', onOk);
    dialogCancelBtn.addEventListener('click', onCancel);
    dialogInputEl.addEventListener('keydown', onKey);
  });
}

async function handleExtract() {
  if (!currentPath) return;
  const requestId = newRequestId();
  window.whaleExt.postMessage({
    type: 'requestDirectoryDialog',
    requestId,
  });
}

toolbarExtractBtn.addEventListener('click', handleExtract);

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  )
    return;
  if (e.key === 'Escape') {
    errorEl.classList.add('hidden');
  }
});

// --- Host message handling ---
window.whaleExt.onMessage((msg) => {
  switch (msg.type) {
    case 'fileContent':
      if (msg.encoding === 'base64') {
        openArchive(msg.path);
      }
      break;
    case 'setTheme':
      applyTheme(msg.theme);
      break;
    case 'archiveList': {
      if (pendingRequestId !== msg.requestId) return;
      pendingRequestId = null;
      if (msg.error) {
        if (msg.error.toLowerCase().includes('password')) {
          showDialog(T.passwordRequired, true).then((pwd) => {
            if (pwd != null) {
              pendingPassword = pwd;
              if (currentPath) requestArchiveList(currentPath);
            }
          });
          return;
        }
        showError(
          T.error.replace('{msg}', msg.error),
          currentPath
        );
        return;
      }
      currentEntries = msg.entries.filter((e) => !e.isDir).map((e) => ({
        path: e.path,
        name: e.path.split('/').pop() ?? e.path,
        size: e.size,
      }));
      if (msg.entries.length === 0) {
        showEmptyState();
        showNoPreviewPlaceholder();
        setStatus(T.entriesLabel.replace('{n}', '0'));
        return;
      }
      if (msg.truncated) {
        setStatus(
          `${T.entriesLabel.replace('{n}', String(msg.entries.length))} · ${T.tooLarge.replace(
            '{n}',
            String(msg.entries.length)
          )}`
        );
      } else {
        setStatus(T.entriesLabel.replace('{n}', String(msg.entries.length)));
      }
      const tree = buildTree(currentEntries);
      renderTree(tree);
      showNoPreviewPlaceholder();
      break;
    }
    case 'archiveEntryContent': {
      if (pendingRequestId !== msg.requestId) return;
      pendingRequestId = null;
      if (msg.error) {
        const err = msg.error;
        if (err.includes('zip-bomb') || err.includes('ZipBombError')) {
          if (pendingForce) {
            showError(T.error.replace('{msg}', err), currentPath);
            return;
          }
          const confirmed = window.confirm(T.zipBombWarning);
          if (confirmed) {
            pendingForce = true;
            // Re-request last selected entry via tree selection is lost; rely on
            // the user clicking again. Simpler: we cannot replay without state.
            // Instead, keep force flag on for next preview/extract.
          }
          return;
        }
        if (err.toLowerCase().includes('password')) {
          showDialog(T.passwordRequired, true).then((pwd) => {
            if (pwd != null) {
              pendingPassword = pwd;
              // User must re-click the entry.
            }
          });
          return;
        }
        showError(T.error.replace('{msg}', err), currentPath);
        return;
      }
      const selected = treeEl.querySelector('.tree-label.file.selected');
      if (!selected) return;
      const file = currentEntries.find((e) => selected.getAttribute('title')?.startsWith(e.path));
      if (!file) return;
      renderEntry(file, msg.base64);
      break;
    }
    case 'archiveExtracted': {
      if (msg.error) {
        showError(T.extractFailed.replace('{msg}', msg.error), currentPath);
        return;
      }
      clearPreview();
      const card = document.createElement('div');
      card.className = 'placeholder-card';
      const title = document.createElement('p');
      title.className = 'placeholder-title';
      title.textContent = T.extractDone;
      const body = document.createElement('p');
      body.className = 'placeholder-body';
      body.textContent = T.extractResult
        .replace('{written}', String(msg.written))
        .replace('{skipped}', String(msg.skipped.length))
        .replace('{errors}', String(msg.errors.length));
      card.appendChild(title);
      card.appendChild(body);
      if (msg.errors.length > 0) {
        const list = document.createElement('pre');
        list.className = 'preview-text';
        list.textContent = msg.errors.join('\n');
        card.appendChild(list);
      }
      previewEl.appendChild(card);
      break;
    }
    case 'directoryDialogResult': {
      if (!msg.path || !currentPath) return;
      const requestId = newRequestId();
      window.whaleExt.postMessage({
        type: 'requestArchiveExtract',
        requestId,
        path: currentPath,
        destDir: msg.path,
        password: pendingPassword,
      });
      setStatus(T.extracting);
      break;
    }
    default:
      break;
  }
});

window.whaleExt.onLocale(() => applyLocale());
window.whaleExt.postMessage({ type: 'ready' });
applyTheme('light');
applyLocale();
cleanup();
