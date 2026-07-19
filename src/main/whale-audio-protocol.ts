import path from 'path';
import { createWriteStream, promises as fsp } from 'fs';
import { protocol } from 'electron';
import { decodeWhaleAudioUrl } from '../shared/whale-file-url';
import { assertWithinAllowedRoot } from './allowed-roots';
import { isTranscodeCached, transcodePathFor } from './transcode-cache';
import { createFileRangeResponse } from './protocol-range';
import { spawnTranscodeStream } from './audio-convert';
import { mediaConvertSemaphore } from './concurrency';

/**
 * Live Opus transcode protocol for audio formats Chromium can't decode
 * (APE / WMA / AIFF / …). Solves the "large APE album rip takes minutes to
 * start playing" problem: Opus-in-Ogg is a streaming-first container, so we
 * pipe ffmpeg's stdout straight to `<audio>` and playback begins on the
 * first Ogg page instead of after the whole file is transcoded.
 *
 * Two paths:
 *  - Cache hit (`.whale/transcodes/<basename>.opus` fresh, mtime ≥ source):
 *    serve the complete file with Range/206 via `createFileRangeResponse` —
 *    instant start + full seekability (same as `whale-file`).
 *  - Cache miss: spawn ffmpeg → Ogg/Opus on stdout, tee it to the `<audio>`
 *    Response (live, no `Content-Length`) AND to `<cache>.tmp`, which is
 *    renamed to the final cache path only on a clean ffmpeg exit. So the
 *    first open plays within ~1s AND warms a seekable cache for next time.
 *
 * Concurrency: the inflight `Map` dedups same-source requests (a 2nd listener
 * awaits the running transcode, then serves the cache). The semaphore bounds
 * total ffmpeg/ebook/cad children. A `Set` of live children is killed on
 * `before-quit` so a long transcode never outlives the app (Windows would
 * otherwise keep the cache `.tmp` handle locked).
 *
 * Security: identical to `whale-file` — `assertWithinAllowedRoot` on the
 * decoded SOURCE path; the cache path lives under the same root so it's
 * transitively covered.
 *
 * Split out of `main.ts` (docs/01 §12) — behavior is verbatim.
 */

const activeAudioTranscodes = new Map<string, Promise<void>>();
const liveAudioChildren = new Set<import('child_process').ChildProcess>();

export function registerWhaleAudioProtocol(): void {
  protocol.handle('whale-audio', async (request) => {
    try {
      const filePath = decodeWhaleAudioUrl(request.url);
      if (!filePath) {
        return new Response('Malformed whale-audio URL', { status: 400 });
      }
      assertWithinAllowedRoot(filePath);

      const baseHeaders = new Headers({
        // `audio/opus` matches what media-player's MIME_MAP + the old blob
        // path used; Chromium plays Ogg/Opus under this MIME. Same header for
        // the live stream and the cache-hit file so the browser treats them
        // identically.
        'Content-Type': 'audio/opus',
        'Cache-Control': 'no-cache',
      });

      // Cache hit → serve seekable Opus file (Range/206).
      const cached = await isTranscodeCached(filePath);
      if (cached.fresh) {
        return createFileRangeResponse(cached.path, request, baseHeaders);
      }

      // Another request is already transcoding this exact source — wait for
      // it to finish writing the cache, then serve the now-complete file.
      // v1: the second listener does NOT get instant-start; teeing one ffmpeg
      // stdout to N web streams is a follow-up.
      const inflight = activeAudioTranscodes.get(filePath);
      if (inflight) {
        await inflight.catch(() => undefined);
        const recheck = await isTranscodeCached(filePath);
        if (recheck.fresh) {
          return createFileRangeResponse(recheck.path, request, baseHeaders);
        }
        // producer failed → fall through and try a fresh transcode
      }

      return await streamAudioTranscode(filePath, request, baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.startsWith('Refused') ? 403 : 500;
      return new Response(msg, { status });
    }
  });
}

/**
 * Spawn ffmpeg for `filePath`, tee its Ogg/Opus stdout to (1) a live
 * `<audio>` Response and (2) a `<cache>.tmp` write stream, and return the
 * Response. Owns the ffmpeg lifecycle: stderr drain, 5-min SIGKILL timeout,
 * cache rename on clean exit / tmp cleanup on failure, semaphore release,
 * and inflight resolution. Registers the child in `liveAudioChildren` for
 * app-quit teardown.
 */
async function streamAudioTranscode(
  filePath: string,
  request: Request,
  baseHeaders: Headers
): Promise<Response> {
  // Register as in-flight SYNCHRONOUSLY (before the first await) so a
  // concurrent same-source request sees us and waits instead of starting a
  // second ffmpeg. JS is single-threaded: no other request can interleave
  // between this Map.set and the awaits below.
  let resolveInflight!: () => void;
  let rejectInflight!: (err: Error) => void;
  const inflight = new Promise<void>((resolve, reject) => {
    resolveInflight = resolve;
    rejectInflight = reject;
  });
  activeAudioTranscodes.set(filePath, inflight);

  await mediaConvertSemaphore.acquire();
  const cachePath = transcodePathFor(filePath);
  const tmpPath = `${cachePath}.tmp`;
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });

  const { child, stdout } = spawnTranscodeStream(filePath);
  if (!stdout) {
    mediaConvertSemaphore.release();
    activeAudioTranscodes.delete(filePath);
    throw new Error('ffmpeg produced no stdout stream');
  }
  liveAudioChildren.add(child);

  // Capture stderr for a useful error message. Draining it is also REQUIRED:
  // an undrained stderr pipe fills its OS buffer (~64KB) and ffmpeg blocks
  // forever on write(stderr).
  let stderrText = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderrText += b.toString('utf8').slice(-2048);
  });

  const cacheWrite = createWriteStream(tmpPath);
  // 5-min SIGKILL bound (spawn ignores the `timeout` option). Matches the old
  // buffer path's ceiling. Cleared on a clean finish.
  const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);

  // Handle to the web-stream controller, set synchronously inside the
  // ReadableStream's `start()` (which runs during `new ReadableStream()`).
  // Declared here so `finish()` (below) can drive the stream to its terminal
  // state from any event handler — they all fire after `start()` has run.
  const controllerRef: {
    current: ReadableStreamDefaultController<Uint8Array> | null;
  } = { current: null };

  let finished = false;
  const finish = (err?: Error): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      child.kill();
    } catch {
      /* already exited */
    }
    liveAudioChildren.delete(child);
    mediaConvertSemaphore.release();
    if (err) {
      cacheWrite.destroy();
      void fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      rejectInflight(err);
    } else {
      // Flush + publish the cache atomically: only rename after the write
      // stream has finished, so a half-written file is never visible.
      cacheWrite.end(() => {
        fsp
          .rename(tmpPath, cachePath)
          .then(() => resolveInflight())
          .catch(() => rejectInflight(new Error('failed to finalize transcode cache')));
      });
    }
    // Drive the web stream to its terminal state. The double-close guard
    // (`finished`) means a later `cancel()` / `child close` is a no-op —
    // same race that crashed the renderer in the `whale-file` path.
    const controller = controllerRef.current;
    if (controller) {
      try {
        if (err) {
          controller.error(err);
        } else {
          controller.close();
        }
      } catch {
        /* controller already terminal */
      }
    }
    activeAudioTranscodes.delete(filePath);
  };

  // Node → Web ReadableStream: tee stdout to the controller (browser) AND the
  // cache write stream. One copy per chunk detaches it from Node's reused
  // pool buffer (both the controller queue and the async fs write outlive the
  // 'data' listener, so the original pool view would be overwritten). The
  // write stream's backpressure propagates to ffmpeg via stdout.pause/resume.
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef.current = controller;
      stdout.on('data', (chunk: Buffer) => {
        if (finished) return;
        // Copy the chunk off Node's reused stdout pool buffer — both the
        // controller queue and the async fs write outlive this 'data'
        // listener, so the original pool view would be overwritten by the
        // next emission. ArrayBuffer.slice copies; Buffer.from(ArrayBuffer)
        // is a view over that fresh copy (nothing else mutates it). Mirrors
        // the whale-file adapter in protocol-range.ts.
        const buf = chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength
        );
        const copy = Buffer.from(buf);
        try {
          controller.enqueue(new Uint8Array(buf));
        } catch (enqueueErr) {
          finish(enqueueErr instanceof Error ? enqueueErr : new Error(String(enqueueErr)));
          return;
        }
        if (!cacheWrite.write(copy)) {
          stdout.pause();
          cacheWrite.once('drain', () => stdout.resume());
        }
      });
      stdout.on('error', (err) => finish(err));
      child.on('error', (err) => finish(err)); // spawn ENOENT etc.
      // child 'close' fires after stdio drains + process exits — the source
      // of truth for "transcode done". code 0 = success; anything else is a
      // failure (partial Opus stream + must NOT be cached).
      child.on('close', (code, signal) => {
        if (code === 0 && signal == null) {
          finish();
        } else {
          finish(
            new Error(
              `ffmpeg exited code=${code} signal=${signal ?? 'null'}${stderrText ? `: ${stderrText.trim()}` : ''}`
            )
          );
        }
      });
    },
    cancel() {
      finish(new Error('client cancelled transcode stream'));
    },
  });

  // Hand back the live Response. No Content-Length, no Accept-Ranges: the
  // browser plays the chunked Ogg/Opus as it arrives. Seeking on this first
  // (uncached) play is not supported — restored once the cache completes.
  return new Response(webStream, { status: 200, headers: baseHeaders });
}

/**
 * Kill every live audio transcode child. Called on `before-quit` so a long
 * ffmpeg doesn't outlive the app (on Windows it would keep the cache `.tmp`
 * handle locked, blocking cleanup).
 */
export function killAllAudioTranscodes(): void {
  for (const child of liveAudioChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
  liveAudioChildren.clear();
}
