/**
 * md-editor chrome i18n — toolbar / status bar / TOC header / goto-line
 * prompt / reading-time / wrap-indicator strings, localized into the host's
 * 5 languages (en / zh / zh-TW / ja / ko).
 *
 * Mirrors the office-viewer pattern: an `I18N` catalog keyed by locale, a
 * live-binding `T` holding the current strings, and `applyLocale()` that
 * re-reads `window.whaleExt.t(I18N)` and rewrites the static chrome DOM.
 * `index.ts` subscribes via `window.whaleExt.onLocale(applyLocale)`; dynamic
 * strings (wrap indicator, "N min read", goto-line prompt) read `T` at the
 * point they're rendered, so they pick up the live-binding automatically.
 *
 * `t(catalog)` falls back base-lang → `en`, so a missing locale never crashes.
 */
import { ctx, dom } from './md-context';

export interface Strings {
  findTitle: string;
  findLabel: string;
  wrapTitle: string;
  wrapLabel: string;
  zoomOutTitle: string;
  zoomResetTitle: string;
  zoomInTitle: string;
  tocTitle: string;
  tocLabel: string;
  gotoLineTitle: string;
  gotoLineLabel: string;
  exportHtmlTitle: string;
  exportHtmlLabel: string;
  tableDialogTitle: string;
  tableColumns: string;
  tableRows: string;
  tableCancel: string;
  tableInsert: string;
  ln: string;
  col: string;
  length: string;
  sel: string;
  words: string;
  modified: string;
  modifiedTitle: string;
  readOnly: string;
  undo: string;
  undoTitle: string;
  redo: string;
  redoTitle: string;
  /** Wrap-indicator text when wrap is ON / OFF. */
  wrapOn: string;
  wrapOff: string;
  /** TOC sidebar header. */
  outline: string;
  docTitle: string;
  /** `{n}` → minute count. */
  minRead: string;
  /** `{n}` → total line count. */
  gotoPrompt: string;
  /** `{x}` → the bad input, `{n}` → total line count. */
  gotoInvalid: string;
  // --- Right-click context menu (§context-menu) ---
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  bold: string;
  italic: string;
  link: string;
  heading: string;
  heading1: string;
  heading2: string;
  heading3: string;
  headingIncrease: string;
  headingDecrease: string;
  insertCallout: string;
  insertTable: string;
  findReplace: string;
  gotoLineMenu: string;
  wordWrap: string;
  zoomInMenu: string;
  zoomOutMenu: string;
  zoomResetMenu: string;
  exportAsHtml: string;
}

const I18N: Record<string, Strings> = {
  en: {
    findTitle: 'Find / Replace (Ctrl+F)',
    findLabel: 'Find',
    wrapTitle: 'Toggle Word Wrap',
    wrapLabel: 'Wrap',
    zoomOutTitle: 'Zoom Out (Ctrl+-)',
    zoomResetTitle: 'Actual Size (Ctrl+0)',
    zoomInTitle: 'Zoom In (Ctrl++)',
    tocTitle: 'Toggle Outline / TOC (Ctrl+Shift+O)',
    tocLabel: 'TOC',
    gotoLineTitle: 'Go to Line (Ctrl+G)',
    gotoLineLabel: 'Line',
    exportHtmlTitle: 'Export Preview as HTML',
    exportHtmlLabel: 'HTML',
    tableDialogTitle: 'Insert Table',
    tableColumns: 'Columns',
    tableRows: 'Rows',
    tableCancel: 'Cancel',
    tableInsert: 'Insert',
    ln: 'Ln',
    col: 'Col',
    length: 'Length',
    sel: 'Sel',
    words: 'Words',
    modified: 'Modified',
    modifiedTitle: 'Document has unsaved changes',
    readOnly: 'Read Only',
    undo: 'Undo',
    undoTitle: 'Undo (Ctrl+Z)',
    redo: 'Redo',
    redoTitle: 'Redo (Ctrl+Shift+Z)',
    wrapOn: 'Wrap',
    wrapOff: 'No Wrap',
    outline: 'Outline',
    docTitle: 'Markdown Editor',
    minRead: '{n} min read',
    gotoPrompt: 'Go to line (1–{n}):',
    gotoInvalid: '"{x}" is not a valid line number.\nEnter a number between 1 and {n}:',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    bold: 'Bold',
    italic: 'Italic',
    link: 'Link',
    heading: 'Heading',
    heading1: 'Heading 1',
    heading2: 'Heading 2',
    heading3: 'Heading 3',
    headingIncrease: 'Increase Heading',
    headingDecrease: 'Decrease Heading',
    insertCallout: 'Insert Callout',
    insertTable: 'Insert Table…',
    findReplace: 'Find & Replace',
    gotoLineMenu: 'Go to Line',
    wordWrap: 'Word Wrap',
    zoomInMenu: 'Zoom In',
    zoomOutMenu: 'Zoom Out',
    zoomResetMenu: 'Reset Zoom',
    exportAsHtml: 'Export as HTML',
  },
  zh: {
    findTitle: '查找 / 替换 (Ctrl+F)',
    findLabel: '查找',
    wrapTitle: '切换自动换行',
    wrapLabel: '换行',
    zoomOutTitle: '缩小 (Ctrl+-)',
    zoomResetTitle: '实际大小 (Ctrl+0)',
    zoomInTitle: '放大 (Ctrl++)',
    tocTitle: '切换大纲 / 目录 (Ctrl+Shift+O)',
    tocLabel: '目录',
    gotoLineTitle: '跳转到行 (Ctrl+G)',
    gotoLineLabel: '行',
    exportHtmlTitle: '导出预览为 HTML',
    exportHtmlLabel: 'HTML',
    tableDialogTitle: '插入表格',
    tableColumns: '列数',
    tableRows: '行数',
    tableCancel: '取消',
    tableInsert: '插入',
    ln: '行',
    col: '列',
    length: '长度',
    sel: '选定',
    words: '字数',
    modified: '已修改',
    modifiedTitle: '文档有未保存的更改',
    readOnly: '只读',
    undo: '撤销',
    undoTitle: '撤销 (Ctrl+Z)',
    redo: '重做',
    redoTitle: '重做 (Ctrl+Shift+Z)',
    wrapOn: '换行',
    wrapOff: '不换行',
    outline: '大纲',
    docTitle: 'Markdown 编辑器',
    minRead: '{n} 分钟阅读',
    gotoPrompt: '跳转到行 (1–{n}):',
    gotoInvalid: '"{x}" 不是有效的行号。\n请输入 1 到 {n} 之间的数字:',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    bold: '粗体',
    italic: '斜体',
    link: '链接',
    heading: '标题',
    heading1: '标题 1',
    heading2: '标题 2',
    heading3: '标题 3',
    headingIncrease: '提升标题级别',
    headingDecrease: '降低标题级别',
    insertCallout: '插入提示框',
    insertTable: '插入表格…',
    findReplace: '查找和替换',
    gotoLineMenu: '跳转到行',
    wordWrap: '自动换行',
    zoomInMenu: '放大',
    zoomOutMenu: '缩小',
    zoomResetMenu: '重置缩放',
    exportAsHtml: '导出为 HTML',
  },
  'zh-TW': {
    findTitle: '尋找 / 取代 (Ctrl+F)',
    findLabel: '尋找',
    wrapTitle: '切換自動換行',
    wrapLabel: '換行',
    zoomOutTitle: '縮小 (Ctrl+-)',
    zoomResetTitle: '實際大小 (Ctrl+0)',
    zoomInTitle: '放大 (Ctrl++)',
    tocTitle: '切換大綱 / 目錄 (Ctrl+Shift+O)',
    tocLabel: '目錄',
    gotoLineTitle: '跳转到行 (Ctrl+G)',
    gotoLineLabel: '行',
    exportHtmlTitle: '匯出預覽為 HTML',
    exportHtmlLabel: 'HTML',
    tableDialogTitle: '插入表格',
    tableColumns: '欄數',
    tableRows: '列數',
    tableCancel: '取消',
    tableInsert: '插入',
    ln: '行',
    col: '列',
    length: '長度',
    sel: '選取',
    words: '字數',
    modified: '已修改',
    modifiedTitle: '文件有未儲存的變更',
    readOnly: '唯讀',
    undo: '復原',
    undoTitle: '復原 (Ctrl+Z)',
    redo: '重做',
    redoTitle: '重做 (Ctrl+Shift+Z)',
    wrapOn: '換行',
    wrapOff: '不換行',
    outline: '大綱',
    docTitle: 'Markdown 編輯器',
    minRead: '{n} 分鐘閱讀',
    gotoPrompt: '跳转到行 (1–{n}):',
    gotoInvalid: '"{x}" 不是有效的行號。\n請輸入 1 到 {n} 之間的數字:',
    cut: '剪下',
    copy: '複製',
    paste: '貼上',
    selectAll: '全選',
    bold: '粗體',
    italic: '斜體',
    link: '連結',
    heading: '標題',
    heading1: '標題 1',
    heading2: '標題 2',
    heading3: '標題 3',
    headingIncrease: '提升標題層級',
    headingDecrease: '降低標題層級',
    insertCallout: '插入提示方塊',
    insertTable: '插入表格…',
    findReplace: '尋找和取代',
    gotoLineMenu: '跳轉到行',
    wordWrap: '自動換行',
    zoomInMenu: '放大',
    zoomOutMenu: '縮小',
    zoomResetMenu: '重設縮放',
    exportAsHtml: '匯出為 HTML',
  },
  ja: {
    findTitle: '検索 / 置換 (Ctrl+F)',
    findLabel: '検索',
    wrapTitle: '折り返しの切り替え',
    wrapLabel: '折り返し',
    zoomOutTitle: '縮小 (Ctrl+-)',
    zoomResetTitle: '実際のサイズ (Ctrl+0)',
    zoomInTitle: '拡大 (Ctrl++)',
    tocTitle: 'アウトライン / 目次の切り替え (Ctrl+Shift+O)',
    tocLabel: '目次',
    gotoLineTitle: '指定行へ移動 (Ctrl+G)',
    gotoLineLabel: '行',
    exportHtmlTitle: 'プレビューを HTML にエクスポート',
    exportHtmlLabel: 'HTML',
    tableDialogTitle: '表を挿入',
    tableColumns: '列数',
    tableRows: '行数',
    tableCancel: 'キャンセル',
    tableInsert: '挿入',
    ln: '行',
    col: '桁',
    length: '長さ',
    sel: '選択',
    words: '単語数',
    modified: '変更あり',
    modifiedTitle: 'ドキュメントに未保存の変更があります',
    readOnly: '読み取り専用',
    undo: '元に戻す',
    undoTitle: '元に戻す (Ctrl+Z)',
    redo: 'やり直し',
    redoTitle: 'やり直し (Ctrl+Shift+Z)',
    wrapOn: '折り返し',
    wrapOff: '折り返しなし',
    outline: 'アウトライン',
    docTitle: 'Markdown エディター',
    minRead: '{n} 分で読了',
    gotoPrompt: '指定行へ移動 (1–{n}):',
    gotoInvalid: '"{x}" は有効な行番号ではありません。\n1 から {n} までの数値を入力してください:',
    cut: '切り取り',
    copy: 'コピー',
    paste: '貼り付け',
    selectAll: 'すべて選択',
    bold: '太字',
    italic: '斜体',
    link: 'リンク',
    heading: '見出し',
    heading1: '見出し 1',
    heading2: '見出し 2',
    heading3: '見出し 3',
    headingIncrease: '見出しレベルを上げる',
    headingDecrease: '見出しレベルを下げる',
    insertCallout: 'コールアウトを挿入',
    insertTable: '表を挿入…',
    findReplace: '検索と置換',
    gotoLineMenu: '指定行へ移動',
    wordWrap: '折り返し',
    zoomInMenu: '拡大',
    zoomOutMenu: '縮小',
    zoomResetMenu: 'ズームをリセット',
    exportAsHtml: 'HTML にエクスポート',
  },
  ko: {
    findTitle: '찾기 / 바꾸기 (Ctrl+F)',
    findLabel: '찾기',
    wrapTitle: '자동 줄 바꿈 전환',
    wrapLabel: '줄바꿈',
    zoomOutTitle: '축소 (Ctrl+-)',
    zoomResetTitle: '실제 크기 (Ctrl+0)',
    zoomInTitle: '확대 (Ctrl++)',
    tocTitle: '개요 / 목차 전환 (Ctrl+Shift+O)',
    tocLabel: '목차',
    gotoLineTitle: '줄로 이동 (Ctrl+G)',
    gotoLineLabel: '줄',
    exportHtmlTitle: '미리보기를 HTML로 내보내기',
    exportHtmlLabel: 'HTML',
    tableDialogTitle: '표 삽입',
    tableColumns: '열 수',
    tableRows: '행 수',
    tableCancel: '취소',
    tableInsert: '삽입',
    ln: '줄',
    col: '열',
    length: '길이',
    sel: '선택',
    words: '단어',
    modified: '수정됨',
    modifiedTitle: '저장하지 않은 변경 사항이 있습니다',
    readOnly: '읽기 전용',
    undo: '실행 취소',
    undoTitle: '실행 취소 (Ctrl+Z)',
    redo: '다시 실행',
    redoTitle: '다시 실행 (Ctrl+Shift+Z)',
    wrapOn: '줄바꿈',
    wrapOff: '줄바꿈 없음',
    outline: '개요',
    docTitle: 'Markdown 편집기',
    minRead: '{n}분 분량',
    gotoPrompt: '줄로 이동 (1–{n}):',
    gotoInvalid: '"{x}"은(는) 올바른 줄 번호가 아닙니다.\n1에서 {n} 사이의 숫자를 입력하세요:',
    cut: '잘라내기',
    copy: '복사',
    paste: '붙여넣기',
    selectAll: '모두 선택',
    bold: '굵게',
    italic: '기울임',
    link: '링크',
    heading: '제목',
    heading1: '제목 1',
    heading2: '제목 2',
    heading3: '제목 3',
    headingIncrease: '제목 수준 올리기',
    headingDecrease: '제목 수준 내리기',
    insertCallout: '콜아웃 삽입',
    insertTable: '표 삽입…',
    findReplace: '찾기 및 바꾸기',
    gotoLineMenu: '줄로 이동',
    wordWrap: '자동 줄 바꿈',
    zoomInMenu: '확대',
    zoomOutMenu: '축소',
    zoomResetMenu: '확대/축소 재설정',
    exportAsHtml: 'HTML로 내보내기',
  },
};

/** Current strings for the active locale. Live-binding: re-assigned by
 *  `applyLocale`, so importers always see the latest values. */
export let T: Strings = I18N.en;

/** Re-read the catalog for the host's current locale and rewrite the static
 *  chrome DOM. Called once on boot (onLocale fires immediately) and again on
 *  every locale change. Dynamic strings (wrap indicator / "N min read" /
 *  goto prompt) read `T` at render time, so they follow automatically. */
export function applyLocale(): void {
  T = window.whaleExt.t(I18N);
  document.documentElement.lang = window.whaleExt.locale;
  document.title = T.docTitle;

  // Toolbar buttons: title + aria-label + textContent (icon prefix preserved).
  const labelled: Array<[HTMLElement, string, string]> = [
    [dom.findBtn, T.findTitle, `⌕ ${T.findLabel}`],
    [dom.toggleWrapBtn, T.wrapTitle, `↩ ${T.wrapLabel}`],
    [dom.zoomOutBtn, T.zoomOutTitle, 'A−'],
    [dom.zoomResetBtn, T.zoomResetTitle, 'A'],
    [dom.zoomInBtn, T.zoomInTitle, 'A+'],
    [dom.toggleTocBtn, T.tocTitle, `≡ ${T.tocLabel}`],
    [dom.gotoLineBtn, T.gotoLineTitle, `↦ ${T.gotoLineLabel}`],
    [dom.exportHtmlBtn, T.exportHtmlTitle, `⇩ ${T.exportHtmlLabel}`],
  ];
  for (const [btn, title, text] of labelled) {
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = text;
  }

  // Wrap indicator (depends on the current wrap mode).
  dom.wrapStateEl.textContent = ctx.mdWrapMode === 'wrap' ? T.wrapOn : T.wrapOff;

  // TOC sidebar header.
  const tocHeader = dom.tocSidebarEl.querySelector('.toc-header');
  if (tocHeader) tocHeader.textContent = T.outline;

  // Status bar labels + indicators.
  dom.statusLabelLnEl.textContent = T.ln;
  dom.statusLabelColEl.textContent = T.col;
  dom.statusLabelLengthEl.textContent = T.length;
  dom.statusLabelSelEl.textContent = T.sel;
  dom.statusLabelWordsEl.textContent = T.words;
  dom.statusDirtyEl.textContent = `● ${T.modified}`;
  dom.statusDirtyEl.title = T.modifiedTitle;
  dom.statusReadonlyEl.textContent = T.readOnly;
  dom.statusUndoEl.textContent = `↶ ${T.undo}`;
  dom.statusUndoEl.title = T.undoTitle;
  dom.statusRedoEl.textContent = `↷ ${T.redo}`;
  dom.statusRedoEl.title = T.redoTitle;
}
