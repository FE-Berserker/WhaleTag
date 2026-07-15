import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import type { Readable } from 'node:stream';
import { ffmpegPath } from './thumbnail';

/**
 * Spawns ffmpeg to transcode an audio file Chromium can't decode (APE / WMA /
 * AIFF / AMR / AC-3 / DTS / MusePack / WavPack / DSD) into an Ogg/Opus stream
 * on **stdout**, so the `whale-audio://` protocol handler can pipe it straight
 * to the renderer's `<audio>` element and begin playback as soon as the first
 * Ogg pages arrive — instead of waiting for ffmpeg to transcode the whole file
 * (the old buffer-the-whole-`.opus` path, which made large APE album rips take
 * minutes to start).
 *
 * Output is always Opus regardless of input: Chromium plays it natively, the
 * `libopus` encoder is BSD (MIT-compatible), and 128 kbps keeps a typical song
 * a few MB. ffmpeg auto-resamples, so odd input rates (AMR 8 kHz, DSD 2.8 MHz)
 * are handled. `-f ogg pipe:1` writes a streaming Ogg/Opus mux to stdout
 * (drop `-y` — there's no output file to clobber).
 *
 * The caller owns the lifecycle: it MUST drain `child.stderr` (an undrained
 * stderr pipe deadlocks ffmpeg once its OS buffer fills), enforce a timeout
 * via `setTimeout` + `child.kill` (spawn ignores the `timeout` option), kill
 * the child on consumer cancel, and — for cache warming — tee `stdout` to the
 * `.whale/transcodes/<basename>.opus` cache file.
 */
export interface TranscodeStream {
  child: ChildProcess;
  stdout: Readable;
}

export function spawnTranscodeStream(srcPath: string): TranscodeStream {
  const bin = ffmpegPath();
  if (!bin) {
    throw new Error('ffmpeg-static unavailable');
  }
  const child = spawn(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      srcPath,
      // First audio stream only; drop video (e.g. cover-art), subtitle, and
      // data tracks some containers (m4a/mov) carry alongside audio.
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-vbr',
      'on',
      '-application',
      'audio',
      '-f',
      'ogg',
      'pipe:1',
    ],
    // Pipe stdout + stderr so the caller can drain stderr (a full stderr OS
    // buffer deadlocks ffmpeg) and read the Ogg/Opus bytes off stdout.
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return { child, stdout: child.stdout };
}
