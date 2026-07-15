/**
 * media-player extension — viewer for video + audio files (incl. APE/WMA/...
 * via host transcoding). Built on the standard postMessage iframe protocol:
 * `whaleExt` for host I/O, `SiblingsMessage` for prev/next navigation,
 * `RequestFileMessage` for jumping to a different track in the directory.
 *
 * Feature surface:
 * - Custom toolbar: prev / counter / next / ⏪ rewind 10s / ⏩ forward 10s /
 * loop mode / speed / volume / shuffle / playlist.
 * - Auto-advance on playback end: respects loop mode (list/one/none) AND
 * shuffle (when on + list mode, picks random next instead of wrap-next).
 * - Shuffle has its own prev semantics: prev pops the navigation history
 * stack so the user can return to the track they were on before the most
 * recent random pick. When history is empty, falls back to wrap-around.
 * - Bottom playlist panel: click any track to jump, current row highlighted.
 * - Custom playback speed dropdown (0.5 / 0.75 / 1 / 1.25 / 1.5 / 2x); applied
 * to every mounted element and persisted in localStorage.
 * - Custom volume dropdown (slider 0–100% + mute toggle); volume level and
 * mute state persist via localStorage and carry across track changes.
 * - Playback progress memory: per-path `currentTime` is saved to localStorage
 * on pause / seek / periodic timeupdate / ended; restored silently when the
 * same track is opened again. Cleared on natural `ended` so the next open
 * starts from 0.
 * - Native `<video controls>` download button is suppressed via
 * `controlsList="nodownload"` so users can't bypass Whale's permission
 * model with a one-click save.
 * - Keyboard: ← prev track, → next track, Home/End first/last, J seek −10s,
 * L seek +10s, ↑/↓ volume ±10%, M toggle mute, Space play/pause,
 * < / > step speed, S shuffle, P playlist, (L no longer cycles loop —
 * loop now lives on the toolbar button only).
 * - Loop mode, shuffle, speed, volume, mute, and panel open/closed state
 * persist via localStorage.
 *
 * State invariants:
 * - `state.currentPath` is updated only on `fileContent` envelope arrival, never
 * optimistically on `requestFile` send. Optimistic updates race the host's
 * fileContent re-broadcast — for transcoded tracks that gap is 1-3s, long
 * enough for `ended` to fire on the old element against a stale currentPath.
 * - `state.loopMode === 'one'` does NOT set HTML `loop`. We manually rewind +
 * play on `ended` so `ended` remains the single source of truth.
 * - `state.loadingNew` debounces rapid prev/next presses; cleared at the end of
 * `playBytes` / `playStreamingUrl` and in the streaming error branch.
 * - `state.history` is pushed on every real navigation (when the new
 * `fileContent` arrives with a different path than the previous currentPath).
 * It is cleared on `first` / `last` jumps — those are absolute, not part of
 * the play order.
 * - `state.playbackRate` is applied on every `playBytes` mount so the rate
 * carries across track changes; it does NOT depend on per-track persistence.
 *
 * Bar mode (?mode=bar):
 * - Hosted by BackgroundPlayerDock at the bottom of the main window; renders a
 * compact single-row UI instead of the full toolbar + stage + playlist.
 * Playback / queue / loop / shuffle / rate / volume / progress all behave
 * identically — only the chrome differs.
 * - The dock's "maximize" button sends `requestOpenInView` so the user can
 * promote the current track to the fullscreen viewer without losing queue
 * state.
 * - The dock's "collapse" button sends `requestHide` so the dock un-mounts
 * (BackgroundPlayerContext persists `dismissed=true`; the dock re-appears
 * on the next non-empty enqueue).
 */
import './player.css';

import {
 siblingTarget,
 parsePlayMode,
 cyclePlayMode,
 formatTrackLabel,
 formatTrackSize,
 pickShuffleNext,
 pushHistory,
 popHistory,
 parseShuffleOn,
 parsePlaybackRate,
 stepPlaybackRate,
 formatPlaybackRate,
 PLAYBACK_RATES,
 parseProgressMap,
 stringifyProgressMap,
 getProgress,
 setProgress,
 type LoopMode,
 type NavDirection,
} from './playlist';

const containerEl = document.getElementById('container') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const btnPrev = document.getElementById('btn-prev') as HTMLButtonElement;
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const btnSeekBack = document.getElementById('btn-seek-back') as HTMLButtonElement;
const btnSeekForward = document.getElementById('btn-seek-forward') as HTMLButtonElement;
const btnLoop = document.getElementById('btn-loop') as HTMLButtonElement;
const loopLabelEl = document.getElementById('loop-label') as HTMLSpanElement;

/** Detect bar mode (hosted by BackgroundPlayerDock). Set on `<body
 * data-mode>` so CSS can hide fullscreen chrome and show the bar. Read
 * once at module load — the extension is loaded with a single mode for its
 * entire lifetime (a bar-mode instance never becomes fullscreen and vice
 * versa; maximize = a NEW fullscreen instance opens on top). */
const MODE: 'full' | 'bar' = (() => {
 try {
 return new URLSearchParams(window.location.search).get('mode') === 'bar'
 ? 'bar'
 : 'full';
 } catch {
 return 'full';
 }
})();
document.body.setAttribute('data-mode', MODE);

// Bar-mode DOM refs (only meaningful when MODE === 'bar').
const barEl = document.getElementById('bar') as HTMLDivElement;
const barTitleEl = barEl.querySelector('.bar-title') as HTMLDivElement;
const barTimeCurEl = barEl.querySelector('.bar-time-cur') as HTMLSpanElement;
const barTimeTotEl = barEl.querySelector('.bar-time-tot') as HTMLSpanElement;
const barProgressEl = barEl.querySelector('.bar-progress') as HTMLDivElement;
const barProgressFillEl = barEl.querySelector(
 '.bar-progress-fill'
) as HTMLDivElement;
const barPlayBtn = document.getElementById('bar-play') as HTMLButtonElement;
const barPrevBtn = document.getElementById('bar-prev') as HTMLButtonElement;
const barNextBtn = document.getElementById('bar-next') as HTMLButtonElement;
const barLoopBtn = document.getElementById('bar-loop') as HTMLButtonElement;
const barShuffleBtn = document.getElementById('bar-shuffle') as HTMLButtonElement;
const barMuteBtn = document.getElementById('bar-mute') as HTMLButtonElement;
const barMaxBtn = document.getElementById('bar-max') as HTMLButtonElement;

if (MODE === 'bar') {
 // Un-hide the bar; CSS hides #toolbar/#stage/#playlist when data-mode=bar.
 barEl.removeAttribute('hidden');
}
const btnSpeed = document.getElementById('btn-speed') as HTMLButtonElement;
const speedLabelEl = document.getElementById('speed-label') as HTMLSpanElement;
const speedMenuEl = document.getElementById('speed-menu') as HTMLUListElement;
const btnShuffle = document.getElementById('btn-shuffle') as HTMLButtonElement;
const btnPlaylist = document.getElementById('btn-playlist') as HTMLButtonElement;
const counterEl = document.getElementById('counter') as HTMLSpanElement;
const playlistEl = document.getElementById('playlist') as HTMLDivElement;
const playlistListEl = document.getElementById('playlist-list') as HTMLUListElement;
const playlistHeaderEl = document.getElementById('playlist-header') as HTMLDivElement;

let currentElement: HTMLVideoElement | HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;

const VIDEO_EXT = new Set([
 'mp4',
 'mov',
 'mkv',
 'webm',
 'm4v',
 'avi',
 '3gp',
 'ogv',
 'wmv',
 'flv',
]);

const MIME_MAP: Record<string, string> = {
 mp4: 'video/mp4',
 mov: 'video/quicktime',
 mkv: 'video/x-matroska',
 webm: 'video/webm',
 m4v: 'video/mp4',
 avi: 'video/x-msvideo',
 '3gp': 'video/3gpp',
 ogv: 'video/ogg',
 wmv: 'video/x-ms-wm',
 flv: 'video/x-flv',
 mp3: 'audio/mpeg',
 ogg: 'audio/ogg',
 wav: 'audio/wav',
 flac: 'audio/flac',
 aac: 'audio/aac',
 m4a: 'audio/mp4',
 // opus is in manifest.fileTypes and not in TRANSCODE_EXT, so it can flow
 // through the native branch — without this entry the blob would be served
 // as application/octet-stream and Chromium would reject it. (Latent fix.)
 opus: 'audio/opus',
};

// Audio extensions Chromium <audio> can't decode; the host transcodes these to
// Opus (cached under .whale/transcodes/) and we play the result. Mirrors
// whale-meta.AUDIO_TRANSCODE_EXT — kept in sync manually (no shared import
// between the extension bundle and the shared module).
const TRANSCODE_EXT = new Set([
 'ape',
 'wma',
 'aiff',
 'amr',
 'ac3',
 'dts',
 'mpc',
 'wv',
 'dsf',
]);

// --- i18n catalog (mirrors text-editor/json-viewer Batch 1 pattern) ---

interface Strings {
 transcoding: string;
 transcodeError: string;
 prevTitle: string;
 nextTitle: string;
 seekBackTitle: string;
 seekForwardTitle: string;
 playlistTitle: string;
 playlistHeader: string;
 playlistEmpty: string;
 loopListTitle: string;
 loopOneTitle: string;
 loopNoneTitle: string;
 loopLabelList: string;
 loopLabelOne: string;
 loopLabelNone: string;
 loopAriaList: string;
 loopAriaOne: string;
 loopAriaNone: string;
 shuffleOnTitle: string;
 shuffleOffTitle: string;
 shuffleAriaOn: string;
 shuffleAriaOff: string;
 speedTitle: string;
 speedAria: (rate: string) => string;
 speedMenuLabel: string;
 counter: (idx: number, total: number) => string;
 counterSingle: (total: number) => string;
 counterEmpty: string;
}

const I18N: Record<string, Strings> = {
 en: {
 transcoding: 'Transcoding…',
 transcodeError: 'Failed to transcode audio: {msg}',
 prevTitle: 'Previous track',
 nextTitle: 'Next track',
 seekBackTitle: 'Rewind 10 seconds (J)',
 seekForwardTitle: 'Fast forward 10 seconds (L)',
 playlistTitle: 'Show playlist',
 playlistHeader: 'Playlist',
 playlistEmpty: 'No other tracks in this folder.',
 loopListTitle: 'Loop: list (auto-advance with wrap)',
 loopOneTitle: 'Loop: one (replay current track)',
 loopNoneTitle: 'Loop: off (stop at end)',
 loopLabelList: 'list',
 loopLabelOne: 'one',
 loopLabelNone: 'off',
 loopAriaList: 'Loop mode: list',
 loopAriaOne: 'Loop mode: one',
 loopAriaNone: 'Loop mode: off',
 shuffleOnTitle: 'Shuffle: on (next picks a random track)',
 shuffleOffTitle: 'Shuffle: off',
 shuffleAriaOn: 'Shuffle: on',
 shuffleAriaOff: 'Shuffle: off',
 speedTitle: 'Playback speed',
 speedAria: (rate) => `Playback speed: ${rate}`,
 speedMenuLabel: 'Playback speed',
 counter: (idx, total) => `${idx} / ${total}`,
 counterSingle: (total) => `1 / ${total}`,
 counterEmpty: '—',
 },
 zh: {
 transcoding: '转码中…',
 transcodeError: '音频转码失败:{msg}',
 prevTitle: '上一首',
 nextTitle: '下一首',
 seekBackTitle: '快退 10 秒 (J)',
 seekForwardTitle: '快进 10 秒 (L)',
 playlistTitle: '显示播放列表',
 playlistHeader: '播放列表',
 playlistEmpty: '当前目录没有其他可播放文件。',
 loopListTitle: '循环:列表(自动连播)',
 loopOneTitle: '循环:单曲(重复播放当前)',
 loopNoneTitle: '循环:关闭(播完停止)',
 loopLabelList: '列表',
 loopLabelOne: '单曲',
 loopLabelNone: '关闭',
 loopAriaList: '循环模式:列表',
 loopAriaOne: '循环模式:单曲',
 loopAriaNone: '循环模式:关闭',
 shuffleOnTitle: '随机播放:开启(下一首随机)',
 shuffleOffTitle: '随机播放:关闭',
 shuffleAriaOn: '随机播放:开启',
 shuffleAriaOff: '随机播放:关闭',
 speedTitle: '播放速度',
 speedAria: (rate) => `播放速度:${rate}`,
 speedMenuLabel: '播放速度',
 counter: (idx, total) => `${idx} / ${total}`,
 counterSingle: (total) => `1 / ${total}`,
 counterEmpty: '—',
 },
};

let T: Strings = I18N.en;

// --- Host convert bridge removed: transcode-only formats now stream live via
// whale-audio:// (host live-transcodes ffmpeg → Opus → <audio>). No more
// buffer-the-whole-file round trip, so the pendingConversions Map +
// requestAudioConvert are gone. See shouldStream + playStreamingUrl. ---

function extOf(filePath: string): string {
 const dot = filePath.lastIndexOf('.');
 return dot > 0 ? filePath.slice(dot + 1).toLowerCase() : '';
}

function base64ToUint8Array(base64: string): Uint8Array {
 const binary = window.atob(base64);
 const len = binary.length;
 const bytes = new Uint8Array(len);
 for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
 return bytes;
}

// --- State (single source of truth for the extension) ---

interface State {
 /** All sibling paths (filtered by host to media fileTypes). Source of truth
 * for prev/next navigation. */
 siblings: string[];
 /** Currently loaded path. Updated ONLY on `fileContent` arrival (not on
 * `requestFile` send) so `ended` always computes next against the actual
 * playing track. */
 currentPath: string;
 /** Loop mode; persisted in localStorage. */
 loopMode: LoopMode;
 /** Whether shuffle is on; persisted in localStorage. When on, `next` /
 * `onPlaybackEnded` pick a random sibling instead of wrap-next. */
 shuffleOn: boolean;
 /** Navigation history — paths played in order, most-recent at the end.
 * Popped by prev in shuffle mode so the user can return to the track they
 * were on before the most recent random pick. Capped at `HISTORY_LIMIT`. */
 history: string[];
 /** Whether the bottom playlist panel is open; persisted in localStorage. */
 playlistOpen: boolean;
 /** Set on emit `requestFile`, cleared at the end of `playBytes` / in the
 * transcode error branch. Prevents burst-press on prev/next from spamming
 * the host while a load is in flight. */
 loadingNew: boolean;
 /** Best-effort size cache keyed by path. Populated when the host forwards
 * `fileContent.size`; falls back to `undefined` (UI shows `—`). Cleared on
 * each new `siblings` envelope. */
 sizeByPath: Map<string, number>;
 /** Current playback rate (e.g. 1, 1.5, 0.5). Always snapped to the
 * PLAYBACK_RATES ladder. Persisted in localStorage. Applied to every
 * mounted element via `playBytes`. */
 playbackRate: number;
 /** Current volume (0..1). Persisted in localStorage; applied to every
 * mounted element via `playBytes`. */
 volume: number;
 /** Whether the player is muted. Persisted in localStorage; applied to every
 * mounted element via `playBytes`. When muted, the volume level itself is
 * preserved (`volumeBeforeMute`) so unmute restores the prior level. */
 muted: boolean;
 /** Volume level captured when the user muted, so an unmute can restore it
 * without forcing them back to 100%. Lives only in-memory — never
 * persisted (the saved `volume` is the source of truth on disk). */
 volumeBeforeMute: number;
 /** Per-path saved currentTime (seconds). Persisted as a single JSON object
 * under `STORAGE_KEY_PROGRESS`. Cleared on natural `ended` so the next
 * open starts from 0. */
 progressByPath: Record<string, number>;
 /** Whether the speed dropdown menu is currently open. Local UI state —
 * NOT persisted. */
 speedMenuOpen: boolean;
}

const STORAGE_KEY_LOOP = 'media-player-loop';
const STORAGE_KEY_SHUFFLE = 'media-player-shuffle';
const STORAGE_KEY_PLAYLIST = 'media-player-playlist-open';
const STORAGE_KEY_RATE = 'media-player-rate';
const STORAGE_KEY_VOLUME = 'media-player-volume';
const STORAGE_KEY_MUTED = 'media-player-muted';
const STORAGE_KEY_PROGRESS = 'media-player-progress';
const HISTORY_LIMIT = 100;
/** Save progress at most every N seconds during active playback. Keeps
 * localStorage writes cheap without losing much on a crash. */
const PROGRESS_SAVE_THROTTLE_MS = 5_000;

/** Clamp + sanitise a stored volume value. Anything outside [0,1] (or
 * non-finite) collapses to `DEFAULT_VOLUME`. We store the raw 0..1 float
 * and round to 4 decimals to keep localStorage compact. */
function parseVolume(raw: string | null | undefined): number {
 if (raw == null) return DEFAULT_VOLUME;
 const n = Number(raw);
 if (!Number.isFinite(n)) return DEFAULT_VOLUME;
 if (n < 0) return 0;
 if (n > 1) return 1;
 return Math.round(n * 10000) / 10000;
}

/** Clamp + sanitise a stored mute flag. Anything other than the literal
 * 'true' is treated as unmuted. */
function parseMuted(raw: string | null | undefined): boolean {
 return raw === 'true';
}

const DEFAULT_VOLUME = 1;

const state: State = {
 siblings: [],
 currentPath: '',
 loopMode: parsePlayMode(safeLocalStorageGet(STORAGE_KEY_LOOP)),
 shuffleOn: parseShuffleOn(safeLocalStorageGet(STORAGE_KEY_SHUFFLE)),
 history: [],
 playlistOpen: safeLocalStorageGet(STORAGE_KEY_PLAYLIST) === 'true',
 loadingNew: false,
 sizeByPath: new Map(),
 playbackRate: parsePlaybackRate(safeLocalStorageGet(STORAGE_KEY_RATE)),
 volume: parseVolume(safeLocalStorageGet(STORAGE_KEY_VOLUME)),
 muted: parseMuted(safeLocalStorageGet(STORAGE_KEY_MUTED)),
 volumeBeforeMute: parseVolume(safeLocalStorageGet(STORAGE_KEY_VOLUME)) || DEFAULT_VOLUME,
 progressByPath: parseProgressMap(safeLocalStorageGet(STORAGE_KEY_PROGRESS)),
 speedMenuOpen: false,
};

let lastProgressSaveAt = 0;

// --- DOM helpers ---

function applyTheme(theme: 'light' | 'dark') {
 document.body.setAttribute('data-theme', theme);
}

/** First-paint theme picker — reads `prefers-color-scheme` synchronously so
 * the dark background is on screen before the host's setTheme envelope lands.
 * Mirrors Batch 1. */
function detectInitialTheme(): 'light' | 'dark' {
 try {
 return window.matchMedia('(prefers-color-scheme: dark)').matches
 ? 'dark'
 : 'light';
 } catch {
 return 'light';
 }
}

function safeLocalStorageGet(key: string): string | null {
 try {
 return window.localStorage.getItem(key);
 } catch {
 return null;
 }
}

function safeLocalStorageSet(key: string, value: string): void {
 try {
 window.localStorage.setItem(key, value);
 } catch {
 /* quota / disabled — ignore */
 }
}

function clearCurrent() {
 if (currentObjectUrl) {
 URL.revokeObjectURL(currentObjectUrl);
 currentObjectUrl = null;
 }
 if (currentElement) {
 currentElement.pause();
 currentElement.removeEventListener('ended', onPlaybackEnded);
 currentElement.removeEventListener('pause', saveCurrentProgress);
 currentElement.removeEventListener('seeked', saveCurrentProgress);
 currentElement.removeEventListener('timeupdate', onTimeUpdate);
 currentElement.remove();
 currentElement = null;
 }
}

// --- Render: toolbar counter + playlist rows + nav enablement ---

function updateToolbar(): void {
 // Counter
 if (state.siblings.length === 0) {
 counterEl.textContent = T.counterEmpty;
 } else {
 const idx = state.siblings.indexOf(state.currentPath);
 if (idx < 0) {
 // currentPath not in the list yet (first siblings envelope, or stale).
 // Show "1 / N" optimistically — the fileContent envelope will fix it.
 counterEl.textContent = state.siblings.length === 1
 ? T.counterSingle(state.siblings.length)
 : '? / ' + state.siblings.length;
 } else {
 counterEl.textContent = state.siblings.length === 1
 ? T.counterSingle(state.siblings.length)
 : T.counter(idx + 1, state.siblings.length);
 }
 }

 // Prev / next enablement — require at least 2 siblings AND we know the
 // current index. A single-element list still gets the loop button lit so
 // the user can pick "loop one".
 const hasSiblings = state.siblings.length > 1 && state.siblings.includes(state.currentPath);
 btnPrev.disabled = !hasSiblings || state.loadingNew;
 btnNext.disabled = !hasSiblings || state.loadingNew;
}

function updateLoopButton(): void {
 const titleKey =
 state.loopMode === 'one'
 ? 'loopOneTitle'
 : state.loopMode === 'none'
 ? 'loopNoneTitle'
 : 'loopListTitle';
 const ariaKey =
 state.loopMode === 'one'
 ? 'loopAriaOne'
 : state.loopMode === 'none'
 ? 'loopAriaNone'
 : 'loopAriaList';
 const labelKey =
 state.loopMode === 'one'
 ? 'loopLabelOne'
 : state.loopMode === 'none'
 ? 'loopLabelNone'
 : 'loopLabelList';
 // Apply via title attr (no DOM i18n-title walker — keys are small).
 btnLoop.setAttribute('title', T[titleKey]);
 btnLoop.setAttribute('aria-label', T[ariaKey]);
 loopLabelEl.textContent = T[labelKey];
 // Bar mode shares the same loop state; mirror into the compact dock.
 if (MODE === 'bar') {
 barLoopBtn.setAttribute('title', T[titleKey]);
 barLoopBtn.setAttribute('aria-label', T[ariaKey]);
 barLoopBtn.setAttribute('aria-pressed', state.loopMode !== 'none' ? 'true' : 'false');
 }
}

function updateShuffleButton(): void {
 btnShuffle.setAttribute('title', state.shuffleOn ? T.shuffleOnTitle : T.shuffleOffTitle);
 btnShuffle.setAttribute('aria-label', state.shuffleOn ? T.shuffleAriaOn : T.shuffleAriaOff);
 btnShuffle.setAttribute('aria-pressed', state.shuffleOn ? 'true' : 'false');
 // Bar mode mirror.
 if (MODE === 'bar') {
 barShuffleBtn.setAttribute('title', state.shuffleOn ? T.shuffleOnTitle : T.shuffleOffTitle);
 barShuffleBtn.setAttribute('aria-label', state.shuffleOn ? T.shuffleAriaOn : T.shuffleAriaOff);
 barShuffleBtn.setAttribute('aria-pressed', state.shuffleOn ? 'true' : 'false');
 }
}

// --- Speed dropdown ---

function updateSpeedButton(): void {
 const label = formatPlaybackRate(state.playbackRate);
 speedLabelEl.textContent = label;
 btnSpeed.setAttribute('aria-label', T.speedAria(label));
 btnSpeed.setAttribute('title', T.speedTitle);
 speedMenuEl.setAttribute('aria-label', T.speedMenuLabel);
}

function renderSpeedMenu(): void {
 speedMenuEl.replaceChildren();
 for (const r of PLAYBACK_RATES) {
 const li = document.createElement('li');
 li.setAttribute('role', 'menuitemradio');
 li.setAttribute('aria-checked', r === state.playbackRate ? 'true' : 'false');
 li.setAttribute('data-rate', String(r));

 const labelSpan = document.createElement('span');
 labelSpan.textContent = formatPlaybackRate(r);

 const checkSpan = document.createElement('span');
 checkSpan.className = 'menu-check';
 checkSpan.textContent = r === state.playbackRate ? '✓' : '';

 li.append(labelSpan, checkSpan);
 li.addEventListener('click', (ev) => {
 ev.stopPropagation();
 setPlaybackRate(r);
 closeSpeedMenu();
 });
 speedMenuEl.appendChild(li);
 }
}

function setPlaybackRate(rate: number): void {
 state.playbackRate = rate;
 safeLocalStorageSet(STORAGE_KEY_RATE, String(rate));
 // Apply to the currently mounted element, if any. New mounts (via playBytes)
 // also pick up the rate automatically.
 if (currentElement) {
 currentElement.playbackRate = rate;
 }
 updateSpeedButton();
 renderSpeedMenu();
}

function stepSpeed(dir: 'up' | 'down'): void {
 setPlaybackRate(stepPlaybackRate(state.playbackRate, dir));
}

function openSpeedMenu(): void {
 state.speedMenuOpen = true;
 speedMenuEl.removeAttribute('hidden');
 btnSpeed.setAttribute('aria-expanded', 'true');
}

function closeSpeedMenu(): void {
 state.speedMenuOpen = false;
 speedMenuEl.setAttribute('hidden', '');
 btnSpeed.setAttribute('aria-expanded', 'false');
}

function toggleSpeedMenu(): void {
 if (state.speedMenuOpen) closeSpeedMenu();
 else openSpeedMenu();
}

/** Seek the mounted element by `delta` seconds (positive = forward, negative
 * backward). YouTube-style ±10s on J/L. Clamped to [0, duration] so the
 * browser doesn't throw on a too-large currentTime write. No-op when no
 * element is mounted (transcode, between tracks) or when duration isn't
 * known yet (`Number.isFinite(duration)` check). */
function seekBy(delta: number): void {
 if (!currentElement) return;
 const duration = currentElement.duration;
 if (!Number.isFinite(duration) || duration <= 0) return;
 const next = Math.max(0, Math.min(duration, currentElement.currentTime + delta));
 currentElement.currentTime = next;
}

// --- Progress memory ---

/** Save the currently mounted element's `currentTime` to the progress map and
 * localStorage. Safe to call when no element is mounted (no-op). */
function saveCurrentProgress(): void {
 if (!currentElement || !state.currentPath) return;
 const t = currentElement.currentTime;
 if (!Number.isFinite(t) || t <= 0) return;
 const next = setProgress(state.progressByPath, state.currentPath, t);
 if (next === state.progressByPath) return; // no change → skip the write
 state.progressByPath = next;
 safeLocalStorageSet(STORAGE_KEY_PROGRESS, stringifyProgressMap(state.progressByPath));
 lastProgressSaveAt = Date.now();
}

/** Clear the saved progress for `path` (e.g. after natural `ended`). */
function clearProgressFor(path: string): void {
 if (!path) return;
 const next = setProgress(state.progressByPath, path, 0);
 if (next === state.progressByPath) return;
 state.progressByPath = next;
 safeLocalStorageSet(STORAGE_KEY_PROGRESS, stringifyProgressMap(state.progressByPath));
}

/** Throttled save hook for `timeupdate` events. Skips when the time delta is
 * below the throttle. */
function onTimeUpdate(): void {
 const now = Date.now();
 if (now - lastProgressSaveAt < PROGRESS_SAVE_THROTTLE_MS) return;
 saveCurrentProgress();
}

function updatePlaylistPanel(): void {
 btnPlaylist.setAttribute('aria-pressed', state.playlistOpen ? 'true' : 'false');
 if (state.playlistOpen) {
 playlistEl.removeAttribute('hidden');
 } else {
 playlistEl.setAttribute('hidden', '');
 }
 playlistHeaderEl.textContent = T.playlistHeader;
 renderPlaylistRows();
}

function renderPlaylistRows(): void {
 playlistListEl.replaceChildren();
 if (state.siblings.length === 0) {
 playlistListEl.setAttribute('data-empty', T.playlistEmpty);
 return;
 }
 playlistListEl.removeAttribute('data-empty');

 for (let i = 0; i < state.siblings.length; i += 1) {
 const path = state.siblings[i];
 const li = document.createElement('li');
 li.setAttribute('role', 'option');
 li.setAttribute('data-path', path);
 li.setAttribute('data-index', String(i));
 const isCurrent = path === state.currentPath;
 li.setAttribute('aria-selected', isCurrent ? 'true' : 'false');

 const idxSpan = document.createElement('span');
 idxSpan.className = 'pl-index';
 idxSpan.textContent = String(i + 1);

 const nameSpan = document.createElement('span');
 nameSpan.className = 'pl-name';
 nameSpan.textContent = formatTrackLabel(path);
 nameSpan.setAttribute('title', path);

 const sizeSpan = document.createElement('span');
 sizeSpan.className = 'pl-size';
 sizeSpan.textContent = formatTrackSize(state.sizeByPath.get(path));

 li.append(idxSpan, nameSpan, sizeSpan);
 li.addEventListener('click', () => {
 if (state.loadingNew) return;
 if (path === state.currentPath) return;
 state.loadingNew = true;
 window.whaleExt.postMessage({ type: 'requestFile', path });
 });
 playlistListEl.appendChild(li);
 }
}

function applyLocale(): void {
 T = window.whaleExt.t(I18N);
 document.documentElement.lang = window.whaleExt.locale;
 updateLoopButton();
 updateShuffleButton();
 updateSpeedButton();
 updatePlaylistPanel();
 updateToolbar();
}

// --- Player mount + auto-advance on ended ---

/** Build a Blob URL for `bytes` and mount an <audio>/<video> element for it.
 * On `ended` consults loopMode and either restarts (one), requests next
 * (list, with wrap), or stops (none).
 * Applies the current `state.playbackRate` to the new element and restores
 * any saved `currentTime` for `filePath` (silent resume). */
function playBytes(bytes: Uint8Array, mime: string, isVideo: boolean, filePath: string) {
 clearCurrent();
 statusEl.textContent = '';
 const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
 currentObjectUrl = URL.createObjectURL(blob);
 const el = document.createElement(isVideo ? 'video' : 'audio');
 // Native controls carry their own volume slider + mute button. Bar mode
 // renders its own mute toggle + progress + ↑/↓ for fine volume, so leaving
 // controls=true here would render a SECOND volume control stacked under
 // our dock UI. Suppress them in bar mode (the audio element is still
 // mounted and playing — just visually hidden via CSS — so playback is
 // unaffected). Note: setting `controls = false` is enough on paper; we
 // also removeAttribute + CSS-hide below as belt-and-suspenders because
 // Chromium's `controls` boolean property has historically shown quirks
 // when toggled after the element is appended to the DOM.
 if (MODE === 'bar') {
 el.removeAttribute('controls');
 } else {
 el.controls = true;
 // Hide Chromium's native "download" button. Whale serves these bytes
 // from its own protocol — the user opened the file in our viewer, not a
 // browser, so we don't want a one-click "save to disk" escape hatch that
 // bypasses our permission model. `nodownload` is the only flag we set
 // here; fullscreen / playback rate stay visible (we own those buttons
 // anyway, but hiding them from the native bar avoids two competing UIs).
 // Set via setAttribute rather than `.controlsList` because TypeScript's
 // lib.dom.d.ts only types `controlsList` on HTMLVideoElement, not on
 // HTMLAudioElement (even though Chromium honors it on both).
 el.setAttribute('controlsList', 'nodownload nopictureinpicture');
 if (isVideo) {
 (el as HTMLVideoElement).disablePictureInPicture = true;
 }
 }
 el.src = currentObjectUrl;
 // Carry the current rate + volume + mute across track changes. We set these
 // BEFORE `play()` so the very first frame already reflects the user's
 // preferences — without this, a fresh <video> defaults to volume=1,
 // muted=false and would briefly blast at 100% before our state can land.
 el.playbackRate = state.playbackRate;
 el.volume = state.volume;
 el.muted = state.muted;
 // Restore saved progress if any. We must wait for `loadedmetadata` so the
 // element knows its duration; setting currentTime before metadata throws.
 const saved = getProgress(state.progressByPath, filePath);
 if (saved > 0) {
 const restore = () => {
 // Don't restore past the very end of the track.
 if (el.duration && Number.isFinite(el.duration) && saved >= el.duration) return;
 el.currentTime = saved;
 };
 if (el.readyState >= 1 /* HAVE_METADATA */) {
 restore();
 } else {
 el.addEventListener('loadedmetadata', restore, { once: true });
 }
 }
 el.addEventListener('ended', onPlaybackEnded);
 el.addEventListener('pause', saveCurrentProgress);
 el.addEventListener('seeked', saveCurrentProgress);
 el.addEventListener('timeupdate', onTimeUpdate);
 currentElement = el;
 containerEl.appendChild(el);
 void el.play().catch(() => {
 // Autoplay may be blocked; user can click play.
 });
 // Loading finished — clear the debounce so the user can press next again.
 state.loadingNew = false;
 updateToolbar();
}

/** Mount an <audio>/<video> element backed by a streaming `whale-file:/ `
 * URL. The browser performs Range requests for metadata, seek, and playback,
 * so multi-GB videos don't need to be buffered into the renderer. */
function playStreamingUrl(url: string, filePath: string) {
 clearCurrent();
 statusEl.textContent = '';
 const ext = extOf(filePath);
 const isVideo = VIDEO_EXT.has(ext);
 const el = document.createElement(isVideo ? 'video' : 'audio');
 // See playBytes — native controls only in fullscreen. In bar mode our
 // dock owns the chrome (prev/play/next/progress/mute). Same belt-and-
 // suspenders approach: removeAttribute + CSS hide (rather than just
 // `el.controls = false`) so Chromium can't decide to keep the native
 // bar visible because the boolean property got toggled post-append.
 if (MODE === 'bar') {
 el.removeAttribute('controls');
 } else {
 el.controls = true;
 // Suppress Chromium's native picture-in-picture + download controls on the
 // <video> element. Without `nopictureinpicture` Chromium renders a PiP
 // overlay button on the video's own controls bar (the small "two-overlapping-
 // squares" icon at the right of the native control bar) — independent of
 // anything in OUR toolbar. The user reported "画中画 still here" because
 // the path here was missing the suffix that `playBytes` had.
 el.setAttribute('controlsList', 'nodownload nopictureinpicture');
 if (isVideo) {
 (el as HTMLVideoElement).disablePictureInPicture = true;
 }
 }
 el.src = url;
 el.preload = 'metadata';
 el.playbackRate = state.playbackRate;
 el.volume = state.volume;
 el.muted = state.muted;
 const saved = getProgress(state.progressByPath, filePath);
 if (saved > 0) {
 const restore = () => {
 if (el.duration && Number.isFinite(el.duration) && saved >= el.duration) return;
 el.currentTime = saved;
 };
 if (el.readyState >= 1 /* HAVE_METADATA */) {
 restore();
 } else {
 el.addEventListener('loadedmetadata', restore, { once: true });
 }
 }
 el.addEventListener('ended', onPlaybackEnded);
 el.addEventListener('pause', saveCurrentProgress);
 el.addEventListener('seeked', saveCurrentProgress);
 el.addEventListener('timeupdate', onTimeUpdate);
 el.addEventListener('error', () => {
 state.loadingNew = false;
 updateToolbar();
 statusEl.textContent = T.transcodeError.replace('{msg}', 'stream error');
 });
 currentElement = el;
 containerEl.appendChild(el);
 void el.play().catch(() => {
 // Autoplay may be blocked; user can click play.
 });
 state.loadingNew = false;
 updateToolbar();
}

function onPlaybackEnded(): void {
 if (!currentElement) return;
 // Natural end → clear saved progress so the next open starts from 0.
 if (state.currentPath) clearProgressFor(state.currentPath);
 if (state.loopMode === 'one') {
 // Manual rewind + play. Don't set the HTML `loop` attribute — that would
 // suppress `ended` and break the auto-advance path when the user later
 // switches back to list mode.
 currentElement.currentTime = 0;
 void currentElement.play().catch(() => {
 /* same autoplay caveat as playBytes */
 });
 return;
 }
 if (state.loopMode === 'none') return;
 // list mode: advance. Shuffle (when on) picks random; otherwise wrap-next.
 // If siblings/current are stale (race), the next fileContent envelope will
 // refresh the counter — but advancing against a missing target is a no-op.
 const next = nextTarget();
 if (!next || next === state.currentPath) return;
 state.loadingNew = true;
 updateToolbar();
 window.whaleExt.postMessage({ type: 'requestFile', path: next });
}

function renderNative(filePath: string, content: string) {
 const ext = extOf(filePath);
 const mime = MIME_MAP[ext] || 'application/octet-stream';
 playBytes(base64ToUint8Array(content), mime, VIDEO_EXT.has(ext), filePath);
}

function shouldStream(filePath: string): boolean {
 const ext = extOf(filePath);
 // Transcode-only formats (APE/WMA/AIFF/…) stream via whale-audio://, which
 // live-transcodes to Opus and pipes it straight to <audio> instead of
 // buffering the whole transcode first (the old path made large APE rips take
 // minutes to start playing). The host picks the scheme in its
 // requestStreamingUrl handler.
 if (TRANSCODE_EXT.has(ext)) return true;
 if (VIDEO_EXT.has(ext)) return true;
 const mime = MIME_MAP[ext];
 if (mime?.startsWith('audio/')) return true;
 return false;
}

// --- Navigation (prev / next / first / last) ---

/** Pick the next track to play for a `next` navigation action, honoring
 * shuffle. Returns null if no eligible target exists. */
function nextTarget(): string | null {
 if (state.shuffleOn) {
 return pickShuffleNext(state.siblings, state.currentPath);
 }
 return siblingTarget(state.siblings, state.currentPath, 'next');
}

/** Pick the prev track, honoring shuffle + history. History pop wins over
 * wrap-around when shuffle is on AND the stack is non-empty. */
function prevTarget(): string | null {
 if (state.shuffleOn) {
 const popped = popHistory(state.history);
 if (popped.value) {
 state.history = popped.history;
 return popped.value;
 }
 }
 return siblingTarget(state.siblings, state.currentPath, 'prev');
}

function navigate(direction: NavDirection): void {
 if (state.loadingNew) return;
 let target: string | null;
 if (direction === 'next') {
 target = nextTarget();
 } else if (direction === 'prev') {
 target = prevTarget();
 } else {
 // first / last — absolute jumps, clear history so the next prev is a
 // wrap-around (or starts fresh) rather than undoing the jump.
 state.history = [];
 target = siblingTarget(state.siblings, state.currentPath, direction);
 }
 if (!target || target === state.currentPath) return;
 state.loadingNew = true;
 updateToolbar();
 window.whaleExt.postMessage({ type: 'requestFile', path: target });
}

/** Space-bar play/pause toggle. No-op when no element is mounted (e.g. during
 * a transcode or after a track switch before `playBytes` finishes). The
 * `pause()` call is synchronous; `play()` returns a promise because autoplay
 * policies may reject it — we mirror the `playBytes` catch and swallow. */
function togglePlayPause(): void {
 if (!currentElement) return;
 if (currentElement.paused) {
 void currentElement.play().catch(() => {
 /* autoplay blocked — user can click the controls bar play */
 });
 } else {
 currentElement.pause();
 }
}

function cycleLoopMode(): void {
 state.loopMode = cyclePlayMode(state.loopMode);
 safeLocalStorageSet(STORAGE_KEY_LOOP, state.loopMode);
 updateLoopButton();
}

function toggleShuffle(): void {
 state.shuffleOn = !state.shuffleOn;
 // Toggling shuffle changes the meaning of next/prev but NOT the meaning of
 // history (it tracks "tracks played in order"). Leave history alone — the
 // user can still prev back through it if they re-enable.
 safeLocalStorageSet(STORAGE_KEY_SHUFFLE, state.shuffleOn ? 'true' : 'false');
 updateShuffleButton();
}

function togglePlaylist(): void {
 state.playlistOpen = !state.playlistOpen;
 safeLocalStorageSet(STORAGE_KEY_PLAYLIST, state.playlistOpen ? 'true' : 'false');
 updatePlaylistPanel();
}

// --- Bar mode (?mode=bar) ---
// 
// Mirrors fullscreen state into the compact single-row dock. The DOM <audio>
// is the SAME element used by fullscreen (we don't mount a second one) — so
// progress / play-pause / ended events naturally fire on it. Bar-mode just
// adds: title + cover + play/pause icon sync + progress fill + scrub.
// The host owns the queue; prev/next inside the dock go through
// `navigate('prev' | 'next')` which calls `requestFile`, which the dock host
// translates into `jumpTo(queue.indexOf(path))`.

/** Format a number of seconds as `M:SS` (or `H:MM:SS` past 1 hour). */
function formatClockTime(seconds: number): string {
 if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
 const s = Math.floor(seconds);
 const h = Math.floor(s / 3600);
 const m = Math.floor((s % 3600) / 60);
 const ss = s % 60;
 const ssStr = ss < 10 ? `0${ss}` : `${ss}`;
 if (h > 0) {
 const mStr = m < 10 ? `0${m}` : `${m}`;
 return `${h}:${mStr}:${ssStr}`;
 }
 return `${m}:${ssStr}`;
}

/** Extract just the basename from an absolute path (handles / and \). */
function basenameOf(filePath: string): string {
 const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
 return i >= 0 ? filePath.slice(i + 1) : filePath;
}

/** Refresh the bar's title + time + progress + play icon from the mounted
 * element. Cheap to call (we throttle via the existing 5s progress save
 * cadence plus play/pause + timeupdate; not an animation frame loop). */
function updateBar(): void {
 if (MODE !== 'bar') return;
 const el = currentElement;
 // Title: filename when known, fallback to "未在播放".
 barTitleEl.textContent = state.currentPath
 ? basenameOf(state.currentPath)
 : '未在播放';
 barTitleEl.setAttribute('title', state.currentPath || '');
 // Times + progress.
 const cur = el ? el.currentTime : 0;
 const dur = el && Number.isFinite(el.duration) ? el.duration : 0;
 barTimeCurEl.textContent = formatClockTime(cur);
 barTimeTotEl.textContent = formatClockTime(dur);
 const pct = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
 barProgressFillEl.style.width = `${(pct * 100).toFixed(2)}%`;
 barProgressEl.setAttribute(
 'aria-valuenow',
 String(Math.round(pct * 100))
 );
 // Play/pause icon.
 const playing = !!el && !el.paused && !el.ended;
 barPlayBtn.innerHTML = playing ? '&#9208;' : '&#9654;'; // ❚❚ vs ▶
 barPlayBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
 // Mute icon mirror.
 barMuteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
 barMuteBtn.innerHTML = state.muted ? '&#128263;' : '&#128264;'; // 🔇 vs 🔊
}

/** Click on the progress track → seek to the clicked position. */
function wireBarProgress(): void {
 let dragging = false;
 function seekFromEvent(ev: MouseEvent): void {
 if (!currentElement) return;
 const rect = barProgressEl.getBoundingClientRect();
 const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
 const ratio = rect.width > 0 ? x / rect.width : 0;
 const dur = currentElement.duration;
 if (Number.isFinite(dur) && dur > 0) {
 currentElement.currentTime = dur * ratio;
 }
 }
 barProgressEl.addEventListener('mousedown', (ev) => {
 if (!currentElement) return;
 dragging = true;
 seekFromEvent(ev);
 });
 window.addEventListener('mousemove', (ev) => {
 if (!dragging) return;
 seekFromEvent(ev);
 });
 window.addEventListener('mouseup', () => {
 dragging = false;
 });
 // Click + drag on the progress bar updates the bar's own progress via
 // `timeupdate`, which we already listen to for fullscreen.
}

if (MODE === 'bar') {
 barPlayBtn.addEventListener('click', () => togglePlayPause());
 barPrevBtn.addEventListener('click', () => navigate('prev'));
 barNextBtn.addEventListener('click', () => navigate('next'));
 barLoopBtn.addEventListener('click', () => cycleLoopMode());
 barShuffleBtn.addEventListener('click', () => toggleShuffle());
 // Fine-grained volume control lives on the global keydown handler
 // (↑/↓ = ±10%) — bar mode keeps just the mute toggle since volume
 // cycling in fixed steps felt worse than a single clear action.
 barMuteBtn.addEventListener('click', () => {
 if (state.muted) {
 state.muted = false;
 if (currentElement) currentElement.muted = false;
 } else {
 state.volumeBeforeMute = state.volume || DEFAULT_VOLUME;
 state.muted = true;
 if (currentElement) currentElement.muted = true;
 }
 safeLocalStorageSet(STORAGE_KEY_MUTED, state.muted ? 'true' : 'false');
 updateBar();
 });
 barMaxBtn.addEventListener('click', () => {
 if (!state.currentPath) return;
 window.whaleExt.postMessage({
 type: 'requestOpenInView',
 path: state.currentPath,
 });
 });
 wireBarProgress();
 // Refresh bar whenever playback state changes.
 const barSync = () => updateBar();
 // Use capture so we run before any fullscreen-only listener; cheaper than
 // wiring a parallel observer.
 document.addEventListener('play', barSync, true);
 document.addEventListener('pause', barSync, true);
 document.addEventListener('timeupdate', barSync, true);
 document.addEventListener('loadedmetadata', barSync, true);
 document.addEventListener('ended', barSync, true);
 // First paint.
 updateBar();
}

// --- Wire DOM events ---

btnPrev.addEventListener('click', () => navigate('prev'));
btnNext.addEventListener('click', () => navigate('next'));
btnSeekBack.addEventListener('click', () => seekBy(-10));
btnSeekForward.addEventListener('click', () => seekBy(10));
btnLoop.addEventListener('click', () => cycleLoopMode());
btnShuffle.addEventListener('click', () => toggleShuffle());
btnSpeed.addEventListener('click', (ev) => {
 ev.stopPropagation();
 toggleSpeedMenu();
});
btnPlaylist.addEventListener('click', () => togglePlaylist());

// Close any open dropdown on outside click. The volume dropdown's slider
// captures pointer events while dragging — we still want a click elsewhere
// to close it, but a mousedown on the slider mustn't.
document.addEventListener('click', (ev) => {
 const target = ev.target as Node | null;
 if (!target) return;
 if (state.speedMenuOpen) {
 if (!speedMenuEl.contains(target) && !btnSpeed.contains(target)) {
 closeSpeedMenu();
 }
 }
});

// Belt-and-suspenders: write progress on tab close / navigation away.
window.addEventListener('beforeunload', () => {
 saveCurrentProgress();
});

// Capture keyboard focus whenever the user moves the mouse into the player.
// Without this, the iframe document may not be the active document (e.g. focus
// stayed in the host FileList), and Space/arrow-key shortcuts are swallowed by
// the parent instead of reaching our `document.addEventListener('keydown')`.
// `window.focus()` is safe here because it's triggered by a user gesture.
document.addEventListener(
 'mouseenter',
 () => {
 window.focus();
 },
 true
);

document.addEventListener('keydown', (ev) => {
 // Don't hijack modifier-key chords (Ctrl+R reload, etc.). Mirrors
 // image-viewer/keymap.ts modifier policy.
 if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
 // Skip if the user is typing into a control (defensive — we have no inputs
 // right now, but a future playlist search box would land here).
 const target = ev.target as HTMLElement | null;
 if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
 return;
 }
 switch (ev.key) {
 case 'ArrowLeft':
 case 'PageUp':
 ev.preventDefault();
 navigate('prev');
 break;
 case 'ArrowRight':
 case 'PageDown':
 ev.preventDefault();
 navigate('next');
 break;
 case 'Home':
 ev.preventDefault();
 navigate('first');
 break;
 case 'End':
 ev.preventDefault();
 navigate('last');
 break;
 case 'l':
 case 'L':
 // YouTube-style ±10s seek. `L` is overloaded with loop toggle; we
 // decided seek-forward is the more common YouTube convention. Users
 // who want loop can still use the toolbar button.
 seekBy(10);
 break;
 case 'j':
 case 'J':
 seekBy(-10);
 break;
 case 's':
 case 'S':
 toggleShuffle();
 break;
 case ',':
 case '<':
 stepSpeed('down');
 break;
 case '.':
 case '>':
 stepSpeed('up');
 break;
 case 'p':
 case 'P':
 togglePlaylist();
 break;
 case ' ':
 case 'Spacebar':
 // Toggle play/pause on the mounted element. preventDefault so Space
 // doesn't also fire a click on whichever toolbar button currently has
 // focus (browser default for Space on a focused <button>).
 ev.preventDefault();
 togglePlayPause();
 break;
 default:
 break;
 }
});

// --- Wire host envelopes ---

window.whaleExt.onMessage((msg) => {
 switch (msg.type) {
 case 'fileContent':
 // Only `fileContent` is allowed to update `currentPath`. See the
 // invariant at the top of this file.
 // Push the OLD currentPath to history if this is a real navigation
 // (not the very first fileContent after boot, where currentPath is '').
 if (state.currentPath && state.currentPath !== msg.path) {
 state.history = pushHistory(state.history, state.currentPath, HISTORY_LIMIT);
 }
 state.currentPath = msg.path;
 if (typeof msg.size === 'number' && Number.isFinite(msg.size)) {
 state.sizeByPath.set(msg.path, msg.size);
 }
 // Also refresh the playlist row highlight without a full re-render —
 // `aria-selected` drives the visual highlight.
 for (const li of Array.from(playlistListEl.children) as HTMLLIElement[]) {
 li.setAttribute(
 'aria-selected',
 li.getAttribute('data-path') === msg.path ? 'true' : 'false'
 );
 }
 updateToolbar();
 // Bar mode: refresh title immediately (before playBytes finishes
 // mounting) so the user sees the new track name at once.
 updateBar();
 if (shouldStream(msg.path)) {
 // Video / native audio / transcode-only audio: ask the host for a
 // streaming URL (whale-file:// for native + video, whale-audio:// for
 // live Opus transcode) instead of inflating the whole file as a blob.
 state.loadingNew = true;
 updateToolbar();
 window.whaleExt.postMessage({ type: 'requestStreamingUrl', path: msg.path });
 } else {
 // Degenerate fallback: a file type the host didn't pre-empt with an empty
 // content blob. Render whatever base64 bytes arrived (usually empty → the
 // element simply won't play; no streaming URL to request for an unknown
 // type). In practice every media-player manifest type hits shouldStream.
 renderNative(msg.path, msg.content);
 }
 break;
 case 'streamingUrl':
 if (!msg.url) {
 state.loadingNew = false;
 updateToolbar();
 statusEl.textContent = T.transcodeError.replace('{msg}', 'streaming URL unavailable');
 break;
 }
 playStreamingUrl(msg.url, msg.path);
 break;
 case 'siblings':
 // The list of sibling media files in the current directory. Sent
 // automatically by the host (ExtensionViewPanel.tsx filters by
 // manifest.fileTypes). Reset history on every siblings update — the
 // directory contents changed, so prev-via-history would jump across
 // unrelated tracks.
 state.siblings = msg.paths.slice();
 state.sizeByPath.clear();
 state.history = [];
 updateToolbar();
 renderPlaylistRows();
 break;
 case 'setTheme':
 applyTheme(msg.theme);
 break;
 case 'setLocale':
 applyLocale();
 break;
 default:
 break;
 }
});

window.whaleExt.onLocale(() => applyLocale());

// --- Boot ---

// Apply the initial theme synchronously to avoid a one-frame white flash on
// dark hosts (mirrors Batch 1). The host's setTheme envelope will
// re-apply the final theme moments later.
applyTheme(detectInitialTheme());

applyLocale();
updateToolbar();
updateLoopButton();
updateShuffleButton();
updateSpeedButton();
renderSpeedMenu();
updatePlaylistPanel();
window.whaleExt.postMessage({ type: 'ready' });
// Try to grab keyboard focus immediately on boot. This works when the iframe
// was opened by a user gesture (double-click); if the browser blocks it, the
// mouseenter fallback below will catch subsequent hovers.
try {
 window.focus();
} catch {
 /* ignore */
}
