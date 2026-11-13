export type Locale = 'en' | 'zh';

const catalog: Record<Locale, Record<string, string>> = {
  en: {
    loading: 'Loading Draw.io...',
    loadError: 'Failed to load Draw.io editor.',
    dropHint: 'Drop to insert as a linked thumbnail',
    insertFailed:
      'Could not read the current diagram, so the insert was cancelled to avoid overwriting it.',
  },
  zh: {
    loading: '正在加载 Draw.io...',
    loadError: 'Draw.io 编辑器加载失败。',
    dropHint: '放下以插入带链接的缩略图',
    insertFailed: '读取当前图表失败，已取消插入以免覆盖原有内容。',
  },
};

export function getMessages(locale: string): Record<string, string> {
  return catalog[(locale as Locale) in catalog ? (locale as Locale) : 'en'];
}
