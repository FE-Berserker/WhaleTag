import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Read the running app's `version` from its on-disk `package.json`.
 *
 * Why this exists — `app.getVersion()` from Electron falls back to the
 * bundled Electron version (e.g. `42.4.0`) when the app is launched with a
 * script path (`electron ./release/app/dist/main/main.js`, the way `npm
 * start` ultimately spawns it) instead of an app directory. That makes the
 * Settings → About chip and the auto-update "current" comparison report
 * `42.4.0` rather than the WhaleTag release (e.g. `0.3.1`). We side-step
 * the quirk by reading the package.json directly from `app.getAppPath()`,
 * which Electron does compute correctly for both dev and packaged runs.
 *
 * Cached on first call: package.json never changes for the life of the
 * process.
 */
let cachedVersion: string | null = null;

export function getWhaleAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pjPath = path.join(app.getAppPath(), 'package.json');
    const raw = fs.readFileSync(pjPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      cachedVersion = parsed.version;
      return cachedVersion;
    }
  } catch {
    // fall through
  }
  // Last-ditch fallback: process.versions.electron is always present,
  // and a wrong-but-stable string beats a crash on the Settings screen.
  cachedVersion = `0.0.0+electron-${process.versions.electron}`;
  return cachedVersion;
}
