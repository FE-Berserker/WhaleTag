import { unzipSync } from 'fflate';
import DOMPurify from 'dompurify';

export interface EpubChapter {
  id: string;
  title: string;
  html: string;
}

export interface EpubBookMetadata {
  title: string | null;
  creator: string | null;
  publisher: string | null;
  language: string | null;
  date: string | null;
  description: string | null;
}

export interface EpubBook {
  title: string | null;
  metadata: EpubBookMetadata;
  chapters: EpubChapter[];
  /** Revoke all Blob URLs created for this book. */
  destroy(): void;
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

interface EpubResource {
  blobUrl: string;
  mediaType: string;
}

/** UTF-8 view of a byte array. */
function textOf(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** POSIX-style dirname for a ZIP path ('' when at the archive root). */
function zipDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Joins a base dir and a relative href into a normalized ZIP path. */
function resolveZipPath(base: string, href: string): string {
  let rel = href.split('#')[0].split('?')[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // leave as-is if not valid percent-encoding
  }
  const stack: string[] = [];
  for (const part of (base ? base.split('/') : []).concat(rel.split('/'))) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function isResourceMediaType(mt: string): boolean {
  return (
    /^image\//i.test(mt) ||
    mt === 'text/css' ||
    /^font\//i.test(mt) ||
    /\/(?:ttf|otf|woff|woff2|eot)$/i.test(mt)
  );
}

function guessMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    css: 'text/css',
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    eot: 'application/vnd.ms-fontobject',
  };
  return map[ext] ?? 'application/octet-stream';
}

function parseOpfManifest(opf: Document): ManifestItem[] {
  const items: ManifestItem[] = [];
  opf.querySelectorAll('manifest > item').forEach((el) => {
    const id = el.getAttribute('id') ?? '';
    const href = el.getAttribute('href') ?? '';
    const mediaType = el.getAttribute('media-type') ?? '';
    const properties = el.getAttribute('properties') ?? undefined;
    if (id && href) {
      items.push({ id, href, mediaType, properties });
    }
  });
  return items;
}

function parseSpine(opf: Document): string[] {
  return Array.from(opf.querySelectorAll('spine > itemref'))
    .map((el) => el.getAttribute('idref'))
    .filter((id): id is string => !!id);
}

function findChapterTitle(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const h1 = doc.querySelector('h1');
  if (h1?.textContent?.trim()) return h1.textContent.trim();
  const title = doc.querySelector('title');
  if (title?.textContent?.trim()) return title.textContent.trim();
  return '';
}

/** Case-insensitive lookup for a ZIP entry (some EPUB creators use mixed case). */
function getEntry(entries: Map<string, Uint8Array>, key: string): Uint8Array | undefined {
  return entries.get(key) ?? entries.get(key.toLowerCase());
}

/**
 * Loads an EPUB from raw bytes and prepares sanitized chapter HTML with Blob
 * URLs for images, CSS and fonts.
 */
export function loadEpub(bytes: Uint8Array): EpubBook {
  const archive = unzipSync(bytes);
  const entries = new Map(Object.entries(archive));

  const containerKeys = Array.from(entries.keys()).filter(
    (k) => k.toLowerCase() === 'meta-inf/container.xml'
  );
  const containerText = textOf(
    (containerKeys.length > 0 ? entries.get(containerKeys[0]) : undefined) ??
      new Uint8Array()
  );
  if (!containerText.trim()) {
    throw new Error('EPUB: META-INF/container.xml not found');
  }
  const opfMatch = containerText.match(
    /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i
  );
  if (!opfMatch) {
    throw new Error('EPUB: missing rootfile in container.xml');
  }
  const opfPath = opfMatch[1];
  const opfDir = zipDirname(opfPath);
  const opfBytes = getEntry(entries, opfPath);
  if (!opfBytes) {
    throw new Error(`EPUB: OPF not found at ${opfPath}`);
  }

  const opf = new DOMParser().parseFromString(textOf(opfBytes), 'application/xml');
  const manifestItems = parseOpfManifest(opf);
  const spineIds = parseSpine(opf);

  const titleEl = opf.querySelector('metadata > title');
  const title = titleEl?.textContent?.trim() || null;

  // Dublin Core metadata lives in `dc:*` elements under `<metadata>`. Use
  // namespace-aware lookups so mixed OPF files (with explicit xmlns) still
  // resolve correctly. Falls back to local-name search if no namespace.
  const DC = 'http://purl.org/dc/elements/1.1/';
  const dcGet = (local: string): string | null => {
    const ns = opf.getElementsByTagNameNS(DC, local)[0];
    if (ns?.textContent?.trim()) return ns.textContent.trim();
    const loose = opf.querySelector(`metadata > ${local}`);
    return loose?.textContent?.trim() || null;
  };
  const metadata: EpubBookMetadata = {
    title,
    creator: dcGet('creator'),
    publisher: dcGet('publisher'),
    language: dcGet('language'),
    date: dcGet('date'),
    description: dcGet('description'),
  };

  // Build resource map keyed by absolute ZIP path.
  const resourceMap = new Map<string, EpubResource>();
  for (const item of manifestItems) {
    if (!isResourceMediaType(item.mediaType)) continue;
    const zipPath = resolveZipPath(opfDir, item.href);
    const data = getEntry(entries, zipPath);
    if (!data) continue;
    const blob = new Blob([data as BlobPart], {
      type: item.mediaType || guessMimeType(zipPath),
    });
    resourceMap.set(zipPath, {
      blobUrl: URL.createObjectURL(blob),
      mediaType: item.mediaType,
    });
  }

  function resolveHref(href: string): string | undefined {
    const zipPath = resolveZipPath(opfDir, href);
    return resourceMap.get(zipPath)?.blobUrl ?? resourceMap.get(zipPath.toLowerCase())?.blobUrl;
  }

  // Prepare chapters from spine order.
  const chapters: EpubChapter[] = [];
  for (const idref of spineIds) {
    const item = manifestItems.find((i) => i.id === idref);
    if (!item) continue;
    const zipPath = resolveZipPath(opfDir, item.href);
    const data = getEntry(entries, zipPath);
    if (!data) continue;

    const rawHtml = textOf(data);
    // Sanitize first, then rewrite URLs to blob URLs. DOMPurify's default URL
    // policy may strip relative or blob URLs in src/href; by sanitizing before
    // rewriting we keep the relative refs, then substitute our own blob URLs
    // after the dangerous content has been removed.
    const sanitized = DOMPurify.sanitize(rawHtml, {
      WHOLE_DOCUMENT: true,
      ALLOWED_TAGS: [
        'html', 'head', 'body', 'title', 'meta', 'link', 'style',
        'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup',
        'a', 'img', 'figure', 'figcaption', 'picture', 'source',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
        'blockquote', 'q', 'pre', 'code', 'samp', 'kbd',
        'section', 'article', 'header', 'footer', 'nav', 'aside', 'main',
        'ruby', 'rt', 'rp', 'wbr', 'mark', 'small', 'time', 'abbr', 'cite', 'dfn',
        'audio', 'video', 'track',
      ],
      ALLOWED_ATTR: [
        'id', 'class', 'style', 'title', 'lang', 'dir', 'role', 'aria-*',
        'href', 'target', 'rel', 'name',
        'src', 'srcset', 'alt', 'width', 'height', 'loading',
        'media', 'type', 'crossorigin',
        'colspan', 'rowspan', 'headers', 'scope',
        'controls', 'preload', 'autoplay', 'loop', 'muted', 'poster',
      ],
      ALLOW_DATA_ATTR: false,
    });
    const rewritten = rewriteHtml(sanitized, resolveHref);

    chapters.push({
      id: item.id,
      title: findChapterTitle(rewritten) || item.href,
      html: rewritten,
    });
  }

  if (chapters.length === 0) {
    throw new Error('EPUB: no readable chapters');
  }

  return {
    title,
    metadata,
    chapters,
    destroy() {
      for (const res of resourceMap.values()) {
        URL.revokeObjectURL(res.blobUrl);
      }
    },
  };
}

function rewriteHtml(html: string, resolveHref: (href: string) => string | undefined): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  function rewriteUrl(value: string): string {
    if (!value) return value;
    // Ignore data URLs, absolute URLs, and anchors.
    if (
      value.startsWith('data:') ||
      value.startsWith('http:') ||
      value.startsWith('https:') ||
      value.startsWith('//') ||
      value.startsWith('#')
    ) {
      return value;
    }
    const resolved = resolveHref(value);
    return resolved ?? value;
  }

  // Rewrite src/href attributes.
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of ['src', 'href', 'srcset']) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      if (attr === 'srcset') {
        el.setAttribute(
          attr,
          val
            .split(',')
            .map((part) => {
              const [url, descriptor] = part.trim().split(/\s+/, 2);
              return `${rewriteUrl(url)}${descriptor ? ` ${descriptor}` : ''}`;
            })
            .join(', ')
        );
      } else {
        const next = rewriteUrl(val);
        if (next !== val) el.setAttribute(attr, next);
      }
    }

    // Inline style: rewrite url(...) references.
    const style = el.getAttribute('style');
    if (style) {
      el.setAttribute(
        'style',
        style.replace(/url\(['"]?([^'"()]+)['"]?\)/gi, (_m, url: string) => {
          return `url("${rewriteUrl(url)}")`;
        })
      );
    }
  });

  // Rewrite <style> tag contents.
  doc.querySelectorAll('style').forEach((styleEl) => {
    styleEl.textContent =
      styleEl.textContent?.replace(
        /url\(['"]?([^'"()]+)['"]?\)/gi,
        (_m, url: string) => `url("${rewriteUrl(url)}")`
      ) ?? '';
  });

  // Return the serialized body contents (or full document if it has head assets).
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}
