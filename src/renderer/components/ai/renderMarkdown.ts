import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Render a chunk of assistant markdown to sanitized HTML. Mirrors the
 * md-editor extension pattern (`marked` → `DOMPurify`). Output is safe to
 * inject via `dangerouslySetInnerHTML`.
 */
export function renderMarkdown(md: string): string {
  if (!md) return '';
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    // Allow inline code + code blocks; block syntax is default-allowed.
    ADD_ATTR: ['target'],
  });
}
