export type Locale = 'en' | 'zh';

const catalog: Record<Locale, Record<string, string>> = {
  en: {
    loading: 'Loading Draw.io...',
    loadError: 'Failed to load Draw.io editor.',
    dropHint: 'Drop to insert as a linked thumbnail',
  },
  zh: {
    loading: '正在加载 Draw.io...',
    loadError: 'Draw.io 编辑器加载失败。',
    dropHint: '放下以插入带链接的缩略图',
  },
};

export function getMessages(locale: string): Record<string, string> {
  return catalog[(locale as Locale) in catalog ? (locale as Locale) : 'en'];
}
