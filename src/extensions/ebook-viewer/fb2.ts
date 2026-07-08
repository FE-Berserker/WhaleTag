export interface Fb2BookMetadata {
  title: string | null;
  author: string | null;
  language: string | null;
  date: string | null;
  genre: string | null;
  sequence: string | null;
}

export interface Fb2Book {
  title: string | null;
  metadata: Fb2BookMetadata;
  /** Complete HTML document string ready for srcdoc or direct insertion. */
  html: string;
}

/**
 * Parses a FictionBook 2 XML file and returns a self-contained HTML document.
 *
 * Inline `<binary>` images are converted to data URLs and referenced from
 * transformed `<image>` tags. The output is a single HTML string intended to be
 * rendered in a sandboxed iframe.
 */
export function loadFb2(bytes: Uint8Array): Fb2Book {
  // FB2 is normally UTF-8; some legacy files are windows-1251. Try UTF-8 first,
  // then fallback to latin1 (single-byte) which preserves bytes for ASCII tags.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Failed to parse FB2 XML');
  }

  // Build id -> data URL map from <binary> elements.
  const binaries = new Map<string, string>();
  doc.querySelectorAll('binary').forEach((el) => {
    const id = el.getAttribute('id');
    const contentType = el.getAttribute('content-type') ?? 'image/jpeg';
    if (id) {
      const b64 = el.textContent?.replace(/\s+/g, '') ?? '';
      if (b64) binaries.set(id, `data:${contentType};base64,${b64}`);
    }
    el.remove();
  });

  // Extract title and a few more metadata fields from <title-info>. The
  // author can be <first-name> + <middle-name> + <last-name> split across
  // elements; concatenate with spaces. <sequence> carries series name +
  // optional number ("name,number"); we keep only the name for the panel.
  const titleInfo = doc.querySelector('description > title-info');
  const titleEl = titleInfo?.querySelector('book-title');
  const title = titleEl?.textContent?.trim() || null;
  const authorEl = titleInfo?.querySelector('author');
  const authorFirst = authorEl?.querySelector('first-name')?.textContent?.trim() ?? '';
  const authorMiddle = authorEl?.querySelector('middle-name')?.textContent?.trim() ?? '';
  const authorLast = authorEl?.querySelector('last-name')?.textContent?.trim() ?? '';
  const authorJoined = [authorFirst, authorMiddle, authorLast].filter(Boolean).join(' ').trim() || null;
  const langEl = titleInfo?.querySelector('lang');
  const dateEl = titleInfo?.querySelector('date');
  const genreEl = titleInfo?.querySelector('genre');
  const seqEl = titleInfo?.querySelector('sequence');
  const metadata: Fb2BookMetadata = {
    title,
    author: authorJoined,
    language: langEl?.textContent?.trim() || null,
    date: dateEl?.textContent?.trim() || null,
    genre: genreEl?.textContent?.trim() || null,
    sequence: seqEl?.getAttribute('name')?.trim() || null,
  };

  // Transform the body.
  const bodyEl = doc.querySelector('body');
  const bodyHtml = bodyEl ? transformNode(bodyEl, binaries) : '';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Georgia, serif; line-height: 1.7; padding: 2em; max-width: 44em; margin: 0 auto; }
          h1, h2, h3 { font-family: sans-serif; }
          img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
          blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid #ccc; }
          .epigraph { font-style: italic; }
          .stanza { margin: 1em 0; }
          .v { margin: 0.2em 0; }
          a { color: #8d6e63; }
        </style>
      </head>
      <body>${bodyHtml}</body>
    </html>
  `;

  return { title, metadata, html };
}

function transformNode(node: Node, binaries: Map<string, string>): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const el = node as Element;
  const _tag = el.tagName.toLowerCase();
  const local = el.localName.toLowerCase();

  // Resolve image href: FB2 uses xlink:href="#id" or href="#id".
  if (local === 'image') {
    const href =
      el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      el.getAttribute('xlink:href') ??
      el.getAttribute('href') ??
      '';
    const id = href.replace(/^#/, '');
    const src = binaries.get(id) ?? '';
    const alt = el.getAttribute('alt') ?? '';
    return src ? `<img src="${src}" alt="${escapeHtml(alt)}">` : '';
  }

  const children = Array.from(el.childNodes)
    .map((child) => transformNode(child, binaries))
    .join('');

  const map: Record<string, string> = {
    body: 'div',
    section: 'section',
    title: 'h2',
    subtitle: 'h3',
    p: 'p',
    v: 'p class="v"',
    epigraph: 'blockquote class="epigraph"',
    poem: 'div class="poem"',
    stanza: 'div class="stanza"',
    cite: 'blockquote',
    table: 'table',
    tr: 'tr',
    td: 'td',
    th: 'th',
    a: 'a',
    emphasis: 'em',
    strong: 'strong',
    code: 'code',
    sub: 'sub',
    sup: 'sup',
    strikethrough: 's',
    emptyline: 'br',
    coverpage: 'div class="coverpage"',
  };

  if (local === 'emptyline') {
    return '<br>';
  }

  if (local === 'a') {
    const href = el.getAttribute('xlink:href') ?? el.getAttribute('href') ?? '#';
    return `<a href="${escapeHtml(href)}" target="_blank">${children}</a>`;
  }

  const htmlTag = map[local] ?? 'span';
  return `<${htmlTag}>${children}</${htmlTag.split(' ')[0]}>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
