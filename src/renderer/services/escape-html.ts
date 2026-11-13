/**
 * Escape a value for interpolation into an HTML string Whale does not author.
 *
 * ECharts' default tooltip renderer is `renderMode: 'html'`: it assigns the
 * formatter's return value to `innerHTML`. Tag names, folder names and file
 * names are user data (importable from sidecars on disk or via MCP), so a tag
 * called `<img src=x onerror=...>` executed script in the renderer as soon as
 * the tooltip opened. Every tooltip formatter that interpolates a name uses
 * this helper; the i18n text around it is trusted.
 *
 * Keep escaping at the sink. Display labels are also rendered as React text
 * nodes, where escaping the stored value would show `&lt;` literally.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape `& < > " '` so the value renders as text in HTML markup. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
