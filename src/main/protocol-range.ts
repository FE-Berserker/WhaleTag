/**
 * Range-serving helper shared by the `whale-file://` and `whale-audio://`
 * protocol handlers. Both serve a regular file to `<video>` / `<audio>` /
 * `<img>` with HTTP Range support so the browser can scrub and load metadata
 * without re-downloading from byte 0.
 *
 * Factored out of `main.ts` so the Range math (`parseRange`) becomes unit-
 * testable and the Node→Web stream adaptation (with its load-bearing
 * double-close guard) isn't duplicated. See `registerWhaleFileProtocol` and
 * the cache-hit branch of `registerWhaleAudioProtocol` in `main.ts`.
 */
import { createReadStream, statSync } from 'fs';

/**
 * Parse an HTTP `Range:` header value into a single `{ start, end }` slice.
 * Returns `null` for malformed input or an out-of-bounds request so the
 * caller can fall back to a full 200. Only the `bytes=START-END` form is
 * recognized; suffix (`bytes=-N`) and multi-range are intentionally not
 * supported — `<video>` / `<audio>` don't send them.
 */
export function parseRange(
  header: string,
  totalSize: number
): { start: number; end: number } | null {
  // Match `bytes=START-END` or `bytes=START-` (open-ended). Reject anything
  // else up front rather than silently truncating.
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? totalSize - 1 : Number(m[2]);
  // Bounds: start must be in range, end must be >= start and <= last byte.
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= totalSize) return null;
  if (end < start || end >= totalSize) return null;
  return { start, end };
}

/**
 * Build a `Response` that streams `filePath` with optional Range support.
 *
 * `baseHeaders` carries the caller-specific headers (Content-Type,
 * Cache-Control, …). This helper adds `Accept-Ranges: bytes` and, when the
 * request carries a `Range:` header, a `206 Partial Content` with
 * `Content-Range` + a clamped `Content-Length`; otherwise a plain `200`
 * with the full `Content-Length`. The body is a Web `ReadableStream`
 * adapted from a Node `fs.createReadStream` with the same double-close
 * guard used by the streaming file protocol — without it, undici's
 * `controller.close()` on an already-closed controller (which Chromium
 * triggers on every `<video>` / `<audio>` teardown) throws and crashes the
 * renderer.
 *
 * Assumes the caller has already validated the path (allowed-roots guard)
 * and that `filePath` exists and is a regular file.
 */
export function createFileRangeResponse(
  filePath: string,
  request: Request,
  baseHeaders: Headers
): Response {
  const stat = statSync(filePath);
  const headers = new Headers(baseHeaders);
  headers.set('Accept-Ranges', 'bytes');

  // Optional Range request from `<video>` / `<audio>`. We accept the single-
  // range form; multi-range is ignored — media elements never send it.
  // Malformed ranges fall through to a 200 with the full file, matching how
  // nginx behaves.
  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, stat.size) : null;

  const nodeStream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);
  if (range) {
    const chunkSize = range.end - range.start + 1;
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    headers.set('Content-Length', String(chunkSize));
  } else {
    headers.set('Content-Length', String(stat.size));
  }

  // Manual Node → Web ReadableStream adaptation with double-close guards.
  // Electron's internal cast shim double-closes the controller on the Node
  // `'close'` event when the web consumer has already cancelled — Chromium
  // does this when `<video>` / `<audio>` is mid-teardown, when the user
  // skips, when the renderer destroys the element via track-switch, etc.
  // The double-close surfaces as
  // `TypeError [ERR_INVALID_STATE]: ReadableStream is already closed` from
  // undici, escaping `protocol.handle`'s try/catch (it's outside the async
  // boundary) and bubbling up as an unhandled promise rejection that drags
  // the entire renderer down with a "WhaleTag encountered an error" dialog.
  // Manually driving `controller` with a `finished` flag swallows that race.
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      const finish = (err?: Error): void => {
        if (finished) return;
        finished = true;
        try {
          if (err) {
            controller.error(err);
          } else {
            controller.close();
          }
        } catch {
          // controller already in terminal state — ignore the late call so
          // the consumer's `cancel()` doesn't surface as an unhandled
          // rejection.
        }
      };
      nodeStream.on('data', (chunk: Buffer | string) => {
        if (finished) return;
        try {
          if (typeof chunk === 'string') {
            controller.enqueue(new TextEncoder().encode(chunk));
          } else {
            // Slice the pool buffer — Node may reuse it after the listener
            // returns.
            const buf = chunk.buffer.slice(
              chunk.byteOffset,
              chunk.byteOffset + chunk.byteLength
            );
            controller.enqueue(new Uint8Array(buf));
          }
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
      nodeStream.on('end', () => finish());
      nodeStream.on('error', (err) => finish(err));
      nodeStream.on('close', () => finish());
    },
    cancel() {
      try {
        nodeStream.destroy();
      } catch {
        /* already destroyed */
      }
    },
  });

  return new Response(webStream, { status: range ? 206 : 200, headers });
}
