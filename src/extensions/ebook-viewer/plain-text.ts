/**
 * Plain-text extraction from sanitized EPUB / FB2 chapter HTML.
 *
 * The ebook viewer stores highlights and bookmarks by char offsets into a
 * stable per-chapter plain-text representation. Two properties matter:
 *
 *   1. Deterministic — same HTML in, same string out, every time, so offsets
 *      remain valid across re-opens.
 *   2. Lossless enough to round-trip — selection by char offset must hit the
 *      same DOM text node the user originally picked.
 *
 * The transformation follows the same TreeWalker pattern used by the
 * search-index: walks text nodes, skips <style>/<script>/<noscript>/comments,
 * inserts newlines at block boundaries (<p>, <h1..6>, <li>, <tr>, <br>, etc.)
 * so the plain text reads naturally when pasted into a notes app.
 *
 * FB2 chapters are emitted as a single document (chapterId = 'fb2').
 */

/** Block-level / break tags that should produce a newline in the plain text. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'noscript',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'tfoot', 'thead', 'tr',
  'ul',
]);

/** Tags whose text contents we never want to index (scripts, styles, embeds). */
const SKIP_TAGS = new Set([
  'style', 'script', 'noscript', 'template', 'svg', 'math', 'iframe',
]);

/**
 * Extracts a deterministic plain-text string from an HTML fragment or full
 * document. Always returns a string (empty when there is nothing readable).
 */
export function chapterPlainText(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const out: string[] = [];
  let lastWasBlock = true; // avoid a leading newline

  const walker = doc.createTreeWalker(
    doc.body ?? doc.documentElement,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        // Walk up the ancestors: if any is a skip-tag, drop the node.
        let p: Node | null = node.parentNode;
        while (p && p.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has((p as Element).tagName.toLowerCase())) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let current: Node | null = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const tag = (current as Element).tagName.toLowerCase();
      if (BLOCK_TAGS.has(tag) && !lastWasBlock) {
        out.push('\n');
        lastWasBlock = true;
      }
      // Special: <br> adds a newline even though it has no text node.
      if (tag === 'br' && !lastWasBlock) {
        out.push('\n');
        lastWasBlock = true;
      }
    } else if (current.nodeType === Node.TEXT_NODE) {
      const raw = current.nodeValue ?? '';
      // Collapse internal whitespace to single spaces (preserves visual gaps
      // for preformatted blocks because newlines come from block tags).
      const cleaned = raw.replace(/\s+/g, ' ');
      if (cleaned.length > 0) {
        out.push(cleaned);
        lastWasBlock = false;
      }
    }
    current = walker.nextNode();
  }

  // Trim trailing whitespace but keep the leading content as-is.
  return out.join('').replace(/\s+$/u, '');
}

/**
 * Returns a short preview string for a highlight (used in bookmarks /
 * highlights list). Caps at `max` chars and appends an ellipsis when cut.
 */
export function previewText(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}