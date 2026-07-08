import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { ffmpegPath } from './thumbnail';

export interface ConvertAudioOptions {
  /** Maximum time to wait for the transcode, in milliseconds. */
  timeout?: number;
}

/**
 * Transcodes an audio file Chromium can't decode (APE / WMA / AIFF / AMR /
 * AC-3 / DTS / MusePack / WavPack / DSD) into Opus-in-Ogg bytes via the bundled
 * `ffmpeg-static`. Output is always Opus regardless of input: Chromium plays it
 * natively, the `libopus` encoder is BSD (MIT-compatible), and 128 kbps keeps a
 * typical song a few MB. ffmpeg auto-resamples, so odd input rates (AMR 8 kHz,
 * DSD 2.8 MHz) are handled.
 *
 * Runs in a temp dir and returns the `.opus` as a Buffer. Throws when ffmpeg is
 * missing or the transcode fails / produces no output — the caller surfaces the
 * error to media-player, which falls back to the system app. Mirrors the shape
 * of `convertOfficeToPdf` (office-convert.ts).
 */
export async function convertAudioToOpus(
  srcPath: string,
  options: ConvertAudioOptions = {}
): Promise<Buffer> {
  const bin = ffmpegPath();
  if (!bin) {
    throw new Error('ffmpeg-static unavailable');
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-audio-'));
  const expectedOut = path.join(tmpDir, 'out.opus');

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        bin,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          srcPath,
          // First audio stream only; drop video (e.g. cover-art), subtitle,
          // and data tracks some containers (m4a/mov) carry alongside audio.
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
          '-y',
          expectedOut,
        ],
        { timeout: options.timeout ?? 300000 },
        (err) => (err ? reject(err) : resolve())
      );
    });

    if (!existsSync(expectedOut)) {
      throw new Error('ffmpeg did not produce audio');
    }
    const buf = await fsp.readFile(expectedOut);
    if (buf.length === 0) {
      throw new Error('ffmpeg produced an empty file');
    }
    return buf;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Returns true when the bundled ffmpeg binary can be located. */
export function isAudioConvertAvailable(): boolean {
  return ffmpegPath() !== null;
}
