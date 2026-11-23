export const languages = ['en', 'zh', 'zh-TW', 'ja', 'ko'] as const;
export type Language = (typeof languages)[number];

export const languageNames: Record<Language, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
};

const en = {
  language: 'Language',
  readOnly: 'Read-only access',
  pairTitle: 'Connect to WhaleTag',
  pairDescription: 'Pair this browser on the same Wi-Fi. The token is used once and is never stored.',
  tokenLabel: 'Pairing token',
  connect: 'Connect',
  connecting: 'Connecting…',
  pairFailed: 'Pairing failed. Check the token and try again.',
  sessionExpired: 'Your session expired. Pair again to continue.',
  roots: 'Locations',
  selectRoot: 'Select a location',
  noRoots: 'No shared locations are available.',
  breadcrumb: 'Folders',
  back: 'Back',
  searchLabel: 'Search files and folders',
  searchPlaceholder: 'File name',
  tags: 'Tags',
  clearFilter: 'Clear search and tag filter',
  listView: 'List view',
  gridView: 'Grid view',
  loading: 'Loading…',
  retry: 'Retry',
  refresh: 'Refresh',
  emptyFolder: 'This folder is empty.',
  noResults: 'No matching files or tags.',
  indexUnavailable: 'Search and tags are unavailable until the desktop app builds its index.',
  loadFailed: 'Could not load this content. Check the connection and try again.',
  open: 'Open',
  download: 'Download',
  close: 'Close preview',
  previewError: 'The preview could not be loaded. You can download the file instead.',
  textTruncated: 'Only the first 256 KiB is shown. Download the file to view all of it.',
  directoryTruncated: 'Only the first 500 entries are shown. Open a subfolder or search to narrow the results.',
  metadataUnavailable: 'Tag metadata is damaged or unreadable. Files are listed, but sidecar tags may be incomplete.',
  pdfDownloadOnly: 'PDF preview is disabled for safety. Download the file to view it.',
  unsupportedPreview: 'This file type cannot be previewed safely. Download it instead.',
  item: '{{count}} item',
  items: '{{count}} items',
  appTitle: 'WhaleTag — Read-only',
  pairRateLimited: 'Too many pairing attempts. Wait a minute and try again.',
  pairUnavailable: 'Could not reach WhaleTag. Check the Wi-Fi connection and try again.',
  tagsUnavailable: 'Tags could not be loaded. Files are still listed; try again.',
} as const;

export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;

const zh: Dictionary = {
  language: '语言', readOnly: '只读访问', pairTitle: '连接到 WhaleTag',
  pairDescription: '在同一 Wi-Fi 下配对浏览器。令牌仅使用一次，不会被存储。',
  tokenLabel: '配对令牌', connect: '连接', connecting: '正在连接…',
  pairFailed: '配对失败，请检查令牌后重试。', sessionExpired: '会话已过期，请重新配对。',
  roots: '位置', selectRoot: '选择位置', noRoots: '没有可用的共享位置。',
  breadcrumb: '文件夹', back: '返回', searchLabel: '搜索文件和文件夹', searchPlaceholder: '文件名',
  tags: '标签', clearFilter: '清除搜索和标签筛选', listView: '列表视图', gridView: '网格视图',
  loading: '正在加载…', retry: '重试', refresh: '刷新', emptyFolder: '此文件夹为空。',
  noResults: '没有匹配的文件或标签。',
  indexUnavailable: '桌面应用建立索引后才能使用搜索和标签。',
  loadFailed: '无法加载内容，请检查连接后重试。', open: '打开', download: '下载', close: '关闭预览',
  previewError: '无法加载预览，你可以改为下载文件。',
  textTruncated: '仅显示前 256 KiB，请下载文件以查看完整内容。',
  directoryTruncated: '仅显示前 500 个项目。请打开子文件夹或搜索以缩小范围。',
  metadataUnavailable: '标签元数据已损坏或无法读取。文件仍会列出，但 sidecar 标签可能不完整。',
  pdfDownloadOnly: '为安全起见已禁用 PDF 内嵌预览，请下载后查看。',
  unsupportedPreview: '此文件类型无法安全预览，请下载后查看。', item: '{{count}} 项', items: '{{count}} 项',
  appTitle: 'WhaleTag — 只读访问',
  pairRateLimited: '配对尝试过于频繁，请稍等一分钟再试。',
  pairUnavailable: '无法连接 WhaleTag，请检查 Wi-Fi 连接后重试。',
  tagsUnavailable: '标签加载失败，文件仍会列出，请重试。',
};

const zhTW: Dictionary = {
  language: '語言', readOnly: '唯讀存取', pairTitle: '連線到 WhaleTag',
  pairDescription: '在相同 Wi-Fi 下配對瀏覽器。權杖只使用一次，不會儲存。',
  tokenLabel: '配對權杖', connect: '連線', connecting: '正在連線…',
  pairFailed: '配對失敗，請檢查權杖後再試。', sessionExpired: '工作階段已過期，請重新配對。',
  roots: '位置', selectRoot: '選擇位置', noRoots: '沒有可用的共享位置。',
  breadcrumb: '資料夾', back: '返回', searchLabel: '搜尋檔案與資料夾', searchPlaceholder: '檔名',
  tags: '標籤', clearFilter: '清除搜尋與標籤篩選', listView: '清單檢視', gridView: '網格檢視',
  loading: '正在載入…', retry: '重試', refresh: '重新整理', emptyFolder: '此資料夾是空的。',
  noResults: '沒有符合的檔案或標籤。',
  indexUnavailable: '桌面應用程式建立索引後才能使用搜尋與標籤。',
  loadFailed: '無法載入內容，請檢查連線後再試。', open: '開啟', download: '下載', close: '關閉預覽',
  previewError: '無法載入預覽，你可以改為下載檔案。',
  textTruncated: '僅顯示前 256 KiB，請下載檔案以檢視完整內容。',
  directoryTruncated: '僅顯示前 500 個項目。請開啟子資料夾或搜尋以縮小範圍。',
  metadataUnavailable: '標籤中繼資料已損毀或無法讀取。檔案仍會列出，但 sidecar 標籤可能不完整。',
  pdfDownloadOnly: '為安全起見已停用 PDF 內嵌預覽，請下載後檢視。',
  unsupportedPreview: '此檔案類型無法安全預覽，請下載後檢視。', item: '{{count}} 項', items: '{{count}} 項',
  appTitle: 'WhaleTag — 唯讀存取',
  pairRateLimited: '配對嘗試過於頻繁，請稍等一分鐘再試。',
  pairUnavailable: '無法連線到 WhaleTag，請檢查 Wi-Fi 連線後再試。',
  tagsUnavailable: '標籤載入失敗，檔案仍會列出，請重試。',
};

const ja: Dictionary = {
  language: '言語', readOnly: '読み取り専用', pairTitle: 'WhaleTag に接続',
  pairDescription: '同じ Wi-Fi でブラウザーをペアリングします。トークンは一度だけ使用され、保存されません。',
  tokenLabel: 'ペアリングトークン', connect: '接続', connecting: '接続中…',
  pairFailed: 'ペアリングに失敗しました。トークンを確認して再試行してください。',
  sessionExpired: 'セッションの有効期限が切れました。もう一度ペアリングしてください。',
  roots: '場所', selectRoot: '場所を選択', noRoots: '共有されている場所はありません。',
  breadcrumb: 'フォルダー', back: '戻る', searchLabel: 'ファイルとフォルダーを検索', searchPlaceholder: 'ファイル名',
  tags: 'タグ', clearFilter: '検索とタグフィルターをクリア', listView: 'リスト表示', gridView: 'グリッド表示',
  loading: '読み込み中…', retry: '再試行', refresh: '更新', emptyFolder: 'このフォルダーは空です。',
  noResults: '一致するファイルやタグはありません。',
  indexUnavailable: 'デスクトップアプリでインデックスを作成するまで、検索とタグは利用できません。',
  loadFailed: 'コンテンツを読み込めませんでした。接続を確認して再試行してください。',
  open: '開く', download: 'ダウンロード', close: 'プレビューを閉じる',
  previewError: 'プレビューを読み込めませんでした。代わりにファイルをダウンロードできます。',
  textTruncated: '先頭 256 KiB のみ表示しています。完全な内容はファイルをダウンロードして確認してください。',
  directoryTruncated: '最初の 500 件のみ表示しています。サブフォルダーを開くか検索して絞り込んでください。',
  metadataUnavailable: 'タグメタデータが破損しているか読み取れません。ファイルは表示されますが、サイドカータグは不完全な場合があります。',
  pdfDownloadOnly: '安全のため PDF のインラインプレビューは無効です。ダウンロードして表示してください。',
  unsupportedPreview: 'このファイル形式は安全にプレビューできません。ダウンロードしてください。',
  item: '{{count}} 件',
  items: '{{count}} 件',
  appTitle: 'WhaleTag — 読み取り専用',
  pairRateLimited: 'ペアリングの試行が多すぎます。1 分ほど待って再試行してください。',
  pairUnavailable: 'WhaleTag に接続できませんでした。Wi-Fi 接続を確認して再試行してください。',
  tagsUnavailable: 'タグを読み込めませんでした。ファイルは表示されます。再試行してください。',
};

const ko: Dictionary = {
  language: '언어', readOnly: '읽기 전용', pairTitle: 'WhaleTag에 연결',
  pairDescription: '같은 Wi-Fi에서 브라우저를 페어링하세요. 토큰은 한 번만 사용되며 저장되지 않습니다.',
  tokenLabel: '페어링 토큰', connect: '연결', connecting: '연결 중…',
  pairFailed: '페어링에 실패했습니다. 토큰을 확인하고 다시 시도하세요.',
  sessionExpired: '세션이 만료되었습니다. 계속하려면 다시 페어링하세요.',
  roots: '위치', selectRoot: '위치 선택', noRoots: '사용 가능한 공유 위치가 없습니다.',
  breadcrumb: '폴더', back: '뒤로', searchLabel: '파일 및 폴더 검색', searchPlaceholder: '파일 이름',
  tags: '태그', clearFilter: '검색 및 태그 필터 지우기', listView: '목록 보기', gridView: '그리드 보기',
  loading: '불러오는 중…', retry: '다시 시도', refresh: '새로고침', emptyFolder: '이 폴더는 비어 있습니다.',
  noResults: '일치하는 파일이나 태그가 없습니다.',
  indexUnavailable: '데스크톱 앱이 색인을 만들어야 검색과 태그를 사용할 수 있습니다.',
  loadFailed: '콘텐츠를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.',
  open: '열기', download: '다운로드', close: '미리 보기 닫기',
  previewError: '미리 보기를 불러오지 못했습니다. 대신 파일을 다운로드할 수 있습니다.',
  textTruncated: '처음 256KiB만 표시합니다. 전체 내용을 보고 싶으면 파일을 다운로드하세요.',
  directoryTruncated: '처음 500개 항목만 표시합니다. 하위 폴더를 열거나 검색하여 결과를 좁혀 주세요.',
  metadataUnavailable: '태그 메타데이터가 손상되었거나 읽을 수 없습니다. 파일은 표시되지만 sidecar 태그가 불완전할 수 있습니다.',
  pdfDownloadOnly: '안전을 위해 PDF 인라인 미리 보기가 비활성화되어 있습니다. 다운로드하여 확인하세요.',
  unsupportedPreview: '이 파일 형식은 안전하게 미리 볼 수 없습니다. 다운로드하세요.',
  item: '항목 {{count}}개',
  items: '항목 {{count}}개',
  appTitle: 'WhaleTag — 읽기 전용',
  pairRateLimited: '페어링 시도가 너무 많습니다. 1분 후 다시 시도하세요.',
  pairUnavailable: 'WhaleTag에 연결할 수 없습니다. Wi-Fi 연결을 확인하고 다시 시도하세요.',
  tagsUnavailable: '태그를 불러오지 못했습니다. 파일은 계속 표시됩니다. 다시 시도하세요.',
};

export const dictionaries: Record<Language, Dictionary> = { en, zh, 'zh-TW': zhTW, ja, ko };

export function detectLanguage(locale?: string): Language {
  const value = (locale ?? globalThis.navigator?.language ?? 'en').toLowerCase();
  if (value.startsWith('zh')) return /tw|hk|hant/.test(value) ? 'zh-TW' : 'zh';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  return 'en';
}

export function translate(
  language: Language,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  let message = dictionaries[language][key] ?? en[key];
  for (const [name, value] of Object.entries(params)) {
    message = message.replaceAll(`{{${name}}}`, String(value));
  }
  return message;
}
