/**
 * Thumbnail-render utilityProcess entry point. Spawned via
 * `utilityProcess.fork()` from `src/main/thumb-worker-host.ts`. The pure-JS
 * CPU-heavy renders — pdfjs `page.render` (pdf), `unzipSync` cover
 * extraction (ebook), `@napi-rs/canvas` rasterization (font) — run here,
 * off the Electron main event loop; see `docs/06-thumbnails.md` §8.
 *
 * The render functions themselves live in `thumb-render.ts` so tests and
 * the host's in-process fallback (ELECTRON_RUN_AS_NODE) can import them
 * without tripping the parentPort guard below.
 */

import type {
  ThumbWorkerMessage,
  ThumbWorkerRequest,
  ThumbWorkerEvent,
} from './thumb-protocol';
import {
  renderPdfThumb,
  renderFontThumb,
  renderEbookThumb,
} from './thumb-render';

// In a utilityProcess child the parent port lives on `process` —
// `require('electron').parentPort` is undefined at runtime in Electron 42
// (the type is declared on the electron module export, the value is not
// there), so importing it from 'electron' yields undefined and the guard
// below would always throw. `process.parentPort` is `null` in the main
// process, so this guard still catches accidental main-process use.
const parentPort = process.parentPort;
if (!parentPort) {
  // This file is meant to run inside a `utilityProcess.fork()` child. If
  // it's somehow required from the main process, fail loudly so a future
  // refactor that re-imports the render path into main throws on boot
  // rather than silently freezing the UI again.
  throw new Error('thumb-worker.ts must run inside a utilityProcess child');
}

function post(message: unknown): void {
  parentPort!.postMessage(message);
}

function fail(reqId: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  post({
    reqId,
    ok: false,
    error: {
      name,
      message,
      // Strip stack in prod to avoid leaking build-machine paths through
      // IPC. The renderer can still surface name + message.
      ...(process.env.NODE_ENV !== 'production' && stack
        ? { stack }
        : {}),
    },
  });
}

/**
 * Dispatch a single request to the right render function. Wrapped in
 * try/catch via the caller so any throw becomes a `ThumbWorkerErr` reply.
 */
async function dispatch(req: ThumbWorkerRequest): Promise<void> {
  switch (req.op) {
    case 'thumb:pdf': {
      const { srcPath } = req.arg as { srcPath: string };
      const buf = await renderPdfThumb(srcPath);
      post({ reqId: req.reqId, ok: true, result: { buf } });
      return;
    }
    case 'thumb:font': {
      const { srcPath } = req.arg as { srcPath: string };
      const buf = await renderFontThumb(srcPath);
      post({ reqId: req.reqId, ok: true, result: { buf } });
      return;
    }
    case 'thumb:ebook': {
      const { srcPath } = req.arg as { srcPath: string };
      const buf = await renderEbookThumb(srcPath);
      post({ reqId: req.reqId, ok: true, result: { buf } });
      return;
    }
    default: {
      fail(
        req.reqId,
        new Error(
          `unknown op: ${(req as { op?: string }).op ?? '<missing>'}`
        )
      );
      return;
    }
  }
}

/**
 * Message entry point. `MessagePortMain` emits `'message'` with an event
 * whose `.data` is the deserialized payload. Anything missing a `reqId`
 * or `op` is silently dropped (worker echoes, malformed input, etc.).
 */
parentPort.on('message', (event: { data: unknown } | unknown) => {
  const data =
    event && typeof event === 'object' && 'data' in event
      ? (event as { data: unknown }).data
      : event;
  const msg = data as ThumbWorkerMessage;
  if (!msg || typeof msg !== 'object') return;
  if (!('reqId' in msg) || !('op' in msg)) return;

  dispatch(msg as ThumbWorkerRequest).catch((err: unknown) =>
    fail(msg.reqId, err)
  );
});

// Tell the host we're ready to receive requests. The host uses this as
// one of two signals that boot completed (the other being the `'spawn'`
// event on the parent side).
post({ kind: 'ready' } satisfies ThumbWorkerEvent);
