/**
 * Size caps shared between the index utilityProcess worker (which enforces
 * them during extraction, `fulltext.ts`) and the Electron main process
 * (which pre-checks a PDF's size so the MCP tool can return a friendly
 * error, `mcp/mcp-tools.ts`). Kept in a dependency-free module so the
 * main-process side can import the exact cap the worker enforces WITHOUT
 * dragging `fulltext.ts` — and through it `index-db.ts` — into the
 * main-process bundle: index-db.ts throws when loaded outside the worker
 * in production builds (see its header guard), which used to crash the
 * packaged app at startup.
 */

/**
 * Refuse PDFs larger than this before `readFile` — pdfjs needs the whole file
 * in memory (plus its own parse buffers), so an unbounded read can OOM the
 * index worker. Text extraction from a 128 MiB PDF is already pathological and
 * the 10 s per-file timeout would usually kill it. Files above the cap keep
 * whatever row they already had instead of disappearing from the index.
 */
export const MAX_PDF_BYTES = 128 * 1024 * 1024;
