# FFmpeg

This product bundles **FFmpeg** (the gyan.dev `essentials` build, distributed
via the npm package `ffmpeg-static` and invoked as a separate OS process), used
by Whale for:

- video thumbnail extraction — `src/main/thumbnail.ts` (`encodeVideoThumb`)
- audio transcoding of formats Chromium can't decode (APE / WMA / AIFF / AMR /
  AC-3 / DTS / MusePack / WavPack / DSD → Opus) — `src/main/audio-convert.ts`

FFmpeg is licensed under the **GNU General Public License v3.0 or later**
(GPL-3.0-or-later). This build is configured `--enable-gpl --enable-version3`
and includes GPL components (libx264, libx265, libmp3lame, libxvid, etc.).

- Home: https://ffmpeg.org
- Legal / license: https://ffmpeg.org/legal.html
- Source: https://ffmpeg.org/download.html
- Build (Windows essentials): https://www.gyan.dev/ffmpeg/builds/
- npm wrapper: https://github.com/eugeneware/ffmpeg-static

Whale as a whole is MIT-licensed. FFmpeg is used as an **unmodified, independent
executable invoked via a child process** (`child_process.execFile`), which
communicates only over stdio/files and is **not linked** into the Electron
binary — a "mere aggregation" of two separate programs (the same arrangement
countless MIT/BSD-licensed apps use to bundle ffmpeg). The corresponding FFmpeg
source code is available at the URLs above.

This file satisfies the GPLv3 §5(c) attribution / "prominent notices"requirement. The binary's own license and readme also ship alongside the
executable (`ffmpeg.exe.LICENSE` / `ffmpeg.exe.README`), unpacked from the asar
archive via `asarUnpack` (see `resources/builder.json`).
