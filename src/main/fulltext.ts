import path from 'path';
import { promises as fsp, createReadStream } from 'fs';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { META_DIR } from '../shared/whale-meta';
import type { FulltextHit } from '../shared/ipc-types';
import {
  ingestFulltext,
  queryFulltext,
  hasFulltext,
  fulltextPrior,
} from './index-db';

// pdfjs-dist (Mozilla's official PDF library). We use the legacy build because
// it runs in Node/Electron-main without DOM APIs. The library is kept as a
// webpack external so Node resolves it at runtime; the worker script must also
// be resolved from the installed package (dev vs production paths differ).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const nodeRequire = createRequire(__filename);
const workerPath = nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

// Point pdfjs at the bundled standard font files so text extraction for
// PDFs that reference standard fonts doesn't fall back with warnings.
const standardFontDataUrl =
  pathToFileURL(path.join(path.dirname(workerPath), '..', '..', 'standard_fonts'))
    .href + '/';

/**
 * Full-text indexing for Whale. Keyed by an arbitrary directory root P (a
 * location root OR any subdirectory). Walks P, extracts text from supported
 * files, and ingests it into the SQLite `fulltext_fts` table (index-db.ts) —
 * replacing the old `wsft.jsonl` line-scan with an FTS5 inverted index. Search
 * returns `snippet()` excerpts and runs in O(matches) instead of O(N).
 */

/** Directories never indexed (our metadata dir + common heavy artifacts). */
const IGNORE_DIRS = new Set(['.whale', 'node_modules', '.git']);

/** Extensions we attempt to read as UTF-8 text. */
const SUPPORTED_TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'log',
  'html', 'htm', 'xml', 'svg',
  'json', 'jsonl', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'less',
  'py', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cc',
  'cs', 'kt', 'swift', 'sh', 'bash', 'zsh', 'sql', 'r', 'lua', 'pl',
  'pdf', // binary — handled by extractPdfText, not the UTF-8 reader
]);

/** Files larger than this are truncated to the first N bytes when extracting. */
const MAX_FULLTEXT_BYTES = 2 * 1024 * 1024;

/** Per-file content stored uncapped here would bloat the index; cap the record. */
const MAX_TEXT_PER_FILE = 200 * 1024;

interface FulltextRecord {
  /** Path relative to the index root, '/'-separated (portable). */
  path: string;
  name: string;
  /** Source file mtime in ms — lets rebuilds reuse unchanged files (incremental). */
  mtime: number;
  content: string;
}

function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

/** Relative path with forward slashes. */
function toRel(rootPath: string, fullPath: string): string {
  return path.relative(rootPath, fullPath).split(path.sep).join('/');
}

/** Crude HTML → text: drop script/style blocks and tags, decode a few entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
}

/** Reads at most `cap` bytes from the start of a file as UTF-8. '' on error. */
function readCapped(fullPath: string, cap: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const stream = createReadStream(fullPath, {
      start: 0,
      end: cap - 1,
      encoding: 'utf8',
    });
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(''));
  });
}

/**
 * Extracts text from a PDF via pdfjs-dist (Mozilla's official library, legacy
 * Node-compatible build). Returns null for corrupt / encrypted / image-only
 * PDFs. The worker is resolved from the installed package so it runs in a
 * separate thread; text extraction is I/O bound and per-file capped by a 10s
 * timeout.
 */
async function extractPdfText(filePath: string): Promise<string | null> {
  const data = new Uint8Array(await fsp.readFile(filePath));
  let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Promise((resolve) => {
    const done = (text: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      loadingTask?.destroy?.().catch(() => undefined);
      resolve(text);
    };

    // Guard against pdfjs hanging on malformed or tricky PDFs.
    timer = setTimeout(() => {
      done(null);
    }, 10000);

    loadingTask = pdfjsLib.getDocument({
      data,
      useSystemFonts: true,
      standardFontDataUrl,
    });
    loadingTask.promise
      .then(async (doc) => {
        const parts: string[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const page = await doc.getPage(i);
          try {
            const content = await page.getTextContent();
            const pageText = content.items
              .map((item: unknown) => (item as { str?: string }).str ?? '')
              .join(' ');
            if (pageText.trim()) parts.push(pageText);
          } finally {
            page.cleanup?.();
          }
        }
        const text = parts.join('\n').trim();
        done(text || null);
      })
      .catch(() => {
        done(null);
      });
  });
}

async function extractText(
  fullPath: string,
  ext: string,
  size: number
): Promise<string | null> {
  // PDFs are binary — go through pdfjs, not the UTF-8 reader.
  if (ext === 'pdf') {
    const text = await extractPdfText(fullPath);
    if (!text) return null;
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > MAX_TEXT_PER_FILE
      ? collapsed.slice(0, MAX_TEXT_PER_FILE)
      : collapsed;
  }
  const cap = Math.min(size, MAX_FULLTEXT_BYTES);
  if (cap <= 0) return null;
  let text = await readCapped(fullPath, cap);
  if (!text) return null;
  if (ext === 'html' || ext === 'htm') text = stripHtml(text);
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_TEXT_PER_FILE ? text.slice(0, MAX_TEXT_PER_FILE) : text;
}

/**
 * Incrementally (re)builds the fulltext index in SQLite. Files whose mtime is
 * unchanged since the last build reuse their extracted text (no re-read);
 * new/modified files are re-extracted; deleted files drop out (ingestFulltext
 * does a full replace). Returns how many files are indexed.
 */
export async function buildFulltextIndex(
  rootPath: string
): Promise<{ count: number }> {
  await fsp.mkdir(path.join(rootPath, META_DIR), { recursive: true });
  const prior = fulltextPrior(rootPath);
  const records: FulltextRecord[] = [];
  let count = 0;

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return; // unreadable subdir — skip silently
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        await walk(full);
      } else if (stat.isFile()) {
        const ext = extOf(name);
        if (!SUPPORTED_TEXT_EXT.has(ext)) continue;
        const rel = toRel(rootPath, full);

        // Reuse the prior record if the file hasn't changed (skip content read).
        const prev = prior.get(rel);
        if (prev && prev.mtime === stat.mtimeMs) {
          records.push({ path: rel, name, mtime: prev.mtime, content: prev.content });
          count += 1;
          continue;
        }

        const text = await extractText(full, ext, stat.size);
        if (!text) continue;
        records.push({ path: rel, name, mtime: stat.mtimeMs, content: text });
        count += 1;
      }
    }
  }

  await walk(rootPath);
  await ingestFulltext(rootPath, records);
  return { count };
}

/** Full-text search via SQLite FTS5 (returns snippet excerpts). Empty if none. */
export async function searchFulltext(
  rootPath: string,
  query: string
): Promise<FulltextHit[]> {
  return queryFulltext(rootPath, query);
}

/** True if the root has any full-text content indexed. */
export async function hasFulltextIndex(rootPath: string): Promise<boolean> {
  return hasFulltext(rootPath);
}
