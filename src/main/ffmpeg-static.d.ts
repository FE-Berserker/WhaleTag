/**
 * Ambient declaration for `ffmpeg-static` (ships no bundled types and we don't
 * pull in @types). Resolves to the absolute path of the ffmpeg binary or null
 * when the package couldn't provide one for the current platform.
 */
declare module 'ffmpeg-static' {
  const path: string | null;
  export default path;
}
