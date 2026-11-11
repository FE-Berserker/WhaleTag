/**
 * Range-serving helper for the `whale-file://` protocol handler: serves a
 * regular file to `<video>` / `<audio>` / `<img>` with HTTP Range support so
 * the browser can scrub and load metadata without re-downloading from byte 0.
 *
 * Factored out of `main.ts` so the Range math (`parseRange`) becomes unit-
 * testable and the Node→Web stream adaptation (with its load-bearing
 * double-close guard) isn't duplicated. See `registerWhaleFileProtocol` in
 * `main.ts`.
 */
import { createReadStream, statSync } from 'fs';
import type { Readable } from 'stream';

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
 * Adapt a paused Node readable to a Web stream without running ahead of the
 * consumer. `ReadableStream` calls `pull()` only while its queue has room;
 * each pull resumes the Node stream and the next `data` event pauses it again.
 * Node may retain its own bounded read-ahead buffer, but a slow web consumer
 * can no longer cause the whole file to be enqueued.
 *
 * Exported separately from `createFileRangeResponse` so producer pressure and
 * teardown races can be tested deterministically with an instrumented stream.
 */
export function createBackpressuredWebStream(
  nodeStream: Readable
): ReadableStream<Uint8Array> {
  let finished = false;
  const destroy = (): void => {
    try {
      nodeStream.destroy();
    } catch {
      /* already destroyed */
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
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

      // Adding a `data` listener normally enters flowing mode immediately.
      // Pause first so only `pull()` can authorize the next chunk.
      nodeStream.pause();
      nodeStream.on('data', (chunk: Buffer | string) => {
        nodeStream.pause();
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
          destroy();
        }
      });
      nodeStream.on('end', () => finish());
      nodeStream.on('error', (err) => {
        finish(err);
        destroy();
      });
      // Electron's internal cast shim can close the controller again after a
      // web consumer cancels during `<video>` / `<audio>` teardown. `finish`'s
      // guard absorbs that race instead of leaking an unhandled rejection.
      nodeStream.on('close', () => finish());
    },
    pull() {
      if (!finished && !nodeStream.destroyed) nodeStream.resume();
    },
    cancel() {
      // Mark terminal before `destroy()` emits `close`; cancellation already
      // closes the web side and must not attempt a second controller close.
      finished = true;
      destroy();
    },
  });
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

  const webStream = createBackpressuredWebStream(nodeStream);

  return new Response(webStream, { status: range ? 206 : 200, headers });
}
