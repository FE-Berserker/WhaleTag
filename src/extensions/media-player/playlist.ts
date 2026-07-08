/**
 * Pure helpers for the media-player playlist UI. No DOM access — these are
 * unit-tested in playlist.test.ts. Mirrors the sibling-nav semantics of
 * image-viewer/keymap.ts (wrap-around by default); we intentionally don't share
 * the implementation yet (would require a `shared/` build entry). When a third
 * extension needs it, extract to src/extensions/shared/sibling-nav.ts.
 */

export type LoopMode = 'list' | 'one' | 'none';

export type NavDirection = 'prev' | 'next' | 'first' | 'last';

/**
 * Compute the target sibling for a navigation action.
 *
 * - Empty list → `null` (caller decides whether to disable nav).
 * - Single-element list → returns that element (visual feedback without leaving).
 * - `current` not in list → `next`/`prev` fall back to first; `first`/`last` are
 *   absolute (no fallback needed).
 * - Wrap-around is the default for both ends (matches image-viewer behavior).
 */
export function siblingTarget(
  paths: string[],
  current: string,
  direction: NavDirection
): string | null {
  if (paths.length === 0) return null;
  if (paths.length === 1) return paths[0];
  const idx = paths.indexOf(current);
  switch (direction) {
    case 'first':
      return paths[0];
    case 'last':
      return paths[paths.length - 1];
    case 'prev': {
      const base = idx < 0 ? 0 : idx;
      return paths[(base - 1 + paths.length) % paths.length];
    }
    case 'next': {
      const base = idx < 0 ? 0 : idx;
      return paths[(base + 1) % paths.length];
    }
    default:
      return null;
  }
}

/**
 * Validate a stored loop mode. Anything unrecognised falls back to `list`,
 * which is also the UX default for "auto-advance with wrap".
 */
export function parsePlayMode(raw: string | null | undefined): LoopMode {
  return raw === 'one' || raw === 'none' || raw === 'list' ? raw : 'list';
}

/** Advance to the next loop mode in the canonical cycle. */
export function cyclePlayMode(mode: LoopMode): LoopMode {
  switch (mode) {
    case 'list':
      return 'one';
    case 'one':
      return 'none';
    case 'none':
    default:
      return 'list';
  }
}

/**
 * Extract just the filename from an absolute path. Handles both POSIX `/` and
 * Windows `\` separators so the playlist row labels work on every host.
 */
export function formatTrackLabel(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Format `Bytes`-style sizes for the playlist row. Files in this extension are
 * always positive sizes; we floor to integer to keep the UI predictable.
 */
export function formatTrackSize(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  // 1 decimal for KB+, integer for B. Always show at least one decimal above B
  // so 1.5 KB / 800 MB don't read like "2 KB" / "0 GB".
  const formatted = u === 0 ? `${v}` : v >= 100 ? `${Math.round(v)}` : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${formatted} ${units[u]}`;
}

// --- Shuffle + history ---

/**
 * Pick a uniformly-random element from `paths`, excluding `current`.
 *
 * - Empty list → `null`.
 * - Single-element list equal to `current` → `null` (no other choice).
 * - Single-element list different from `current` → that element.
 * - Otherwise: filter out `current`, then pick uniformly.
 *
 * `random` is an injectable PRNG so tests can be deterministic. Production
 * callers pass `Math.random`.
 */
export function pickShuffleNext(
  paths: string[],
  current: string | null,
  random: () => number = Math.random
): string | null {
  if (paths.length === 0) return null;
  if (paths.length === 1) {
    return paths[0] === current ? null : paths[0];
  }
  const pool = paths.filter((p) => p !== current);
  if (pool.length === 0) return null; // every other entry === current (defensive)
  const i = Math.floor(random() * pool.length) % pool.length;
  return pool[i];
}

/**
 * Append `path` to the navigation history, capped at `limit` (FIFO eviction
 * from the front). Returns a new array — never mutates the input.
 *
 * The history represents "tracks played in order, most-recent at the end".
 * When the user presses prev in shuffle mode, we pop the most-recent entry
 * (the track that was playing before the current one).
 */
export function pushHistory(
  history: string[],
  path: string,
  limit: number
): string[] {
  if (!path) return history;
  // De-dupe adjacent: don't push if it's already the tail (e.g. user double-
  // tapped prev at the boundary).
  if (history.length > 0 && history[history.length - 1] === path) return history;
  const next = history.concat(path);
  if (next.length <= limit) return next;
  // Drop from the front until we're under the limit.
  return next.slice(next.length - limit);
}

/**
 * Pop and return the most-recent entry from `history` (the track to go back
 * to). Returns `null` when the history is empty — the caller should fall
 * back to wrap-around `prev` in that case.
 *
 * Never mutates the input.
 */
export function popHistory(history: string[]): {
  history: string[];
  value: string | null;
} {
  if (history.length === 0) return { history, value: null };
  const value = history[history.length - 1];
  return { history: history.slice(0, -1), value };
}

/** Validate a stored shuffle flag. Anything other than `'true'` → `false`. */
export function parseShuffleOn(raw: string | null | undefined): boolean {
  return raw === 'true';
}

// --- Playback rate + progress memory ---

/** Canonical rate ladder exposed in the UI. The default (1) is included so the
 *  dropdown always lists the current selection. Other rates are clamped into
 *  this list at runtime — anything outside the ladder is normalised to 1. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const DEFAULT_PLAYBACK_RATE = 1;

/** Round to 2 decimals so localStorage stays tidy (e.g. "1" not "1.0000000001"). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Validate a stored playback rate. Accepts any positive finite number that's
 *  in the canonical ladder; everything else (including NaN, negatives, zero,
 *  Infinity, "abc") falls back to `DEFAULT_PLAYBACK_RATE`. */
export function parsePlaybackRate(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_PLAYBACK_RATE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PLAYBACK_RATE;
  // Snap to the closest step in PLAYBACK_RATES so we never persist a stray
  // value like 0.73 (which the UI can't represent).
  let best: number = PLAYBACK_RATES[0];
  let bestDiff = Math.abs(n - best);
  for (const r of PLAYBACK_RATES) {
    const d = Math.abs(n - r);
    if (d < bestDiff) {
      best = r;
      bestDiff = d;
    }
  }
  return best;
}

/** Step the rate by ±1 in the canonical ladder; clamps to the ends. Returns
 *  the same rate when already at the boundary. */
export function stepPlaybackRate(current: number, dir: 'up' | 'down'): number {
  // Snap the current to the ladder first (defensive — should already be there).
  const snapped = parsePlaybackRate(String(current));
  const idx = PLAYBACK_RATES.indexOf(snapped as (typeof PLAYBACK_RATES)[number]);
  const i = idx < 0 ? PLAYBACK_RATES.indexOf(DEFAULT_PLAYBACK_RATE as (typeof PLAYBACK_RATES)[number]) : idx;
  const next = dir === 'up' ? Math.min(i + 1, PLAYBACK_RATES.length - 1) : Math.max(i - 1, 0);
  return PLAYBACK_RATES[next];
}

/** Format the rate for UI labels: `1` → `"1x"`, `1.5` → `"1.5x"`. */
export function formatPlaybackRate(rate: number): string {
  // strip trailing zeros from the rounded value so we get "1x" not "1.00x"
  const rounded = round2(rate);
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${text}x`;
}

// --- Progress memory (per-path currentTime) ---

/** Read the progress map from a JSON-encoded localStorage value. Anything
 *  malformed (no JSON, wrong shape, non-numeric values, negative numbers,
 *  NaN, Infinity) is dropped silently — corrupt storage should never crash
 *  the extension. */
export function parseProgressMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out[k] = round2(v);
  }
  return out;
}

/** Serialise the progress map for localStorage. */
export function stringifyProgressMap(map: Record<string, number>): string {
  return JSON.stringify(map);
}

/** Return the saved progress for `path` (0 when never saved). */
export function getProgress(map: Record<string, number>, path: string): number {
  const v = map[path];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Return a new map with `path`'s entry set to `seconds`. Does NOT mutate the
 *  input. Negative or non-finite values clear the entry (so callers can pass
 *  `currentTime` directly and get sensible behaviour at end-of-track). */
export function setProgress(
  map: Record<string, number>,
  path: string,
  seconds: number
): Record<string, number> {
  if (!path) return map;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    if (!(path in map)) return map;
    const next = { ...map };
    delete next[path];
    return next;
  }
  if (map[path] === round2(seconds)) return map;
  return { ...map, [path]: round2(seconds) };
}