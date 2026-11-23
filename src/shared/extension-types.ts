/**
 * Types shared between the host (renderer main app) and built-in extensions.
 * Keep this file free of Node-only or DOM-only imports.
 */

export const EXT_PROTOCOL_VERSION = 1;

/**
 * Whether a save acknowledgement covers the editor's latest document version.
 * Missing revisions are the legacy protocol and retain its original behaviour.
 */
export function isSaveAckCurrent(
  ackRevision: number | undefined,
  currentRevision: number | undefined
): boolean {
  return (
    ackRevision === undefined ||
    currentRevision === undefined ||
    ackRevision >= currentRevision
  );
}

export type ExtensionType = 'viewer' | 'editor';

export interface ExtensionManifest {
  id: string;
  name: string;
  type: ExtensionType;
  /** Hex color used for icons / accents. */
  color: string;
  /** Lowercase extensions without the leading dot, e.g. ['txt', 'md']. */
  fileTypes: string[];
  /** Entry HTML file, relative to the extension's dist folder. */
  entryPoint: string;
  enabled: boolean;
  isDefault: boolean;
}

export interface ExtensionRegistry {
  extensions: ExtensionManifest[];
  generatedAt: string;
}

export type MessageSource = 'host' | 'extension';

export interface ExtensionEnvelope<T = unknown> {
  protocolVersion: number;
  source: MessageSource;
  message: T;
}

// Host -> Extension messages

export interface FileContentMessage {
  type: 'fileContent';
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  readOnly: boolean;
  /** File size in bytes, supplied by the host when available. Optional so
   *  older hosts/extensions stay compatible. The extension uses it for the
   *  status bar; if absent the extension falls back to `—`. */
  size?: number;
  /**
   * Absolute directory of the file, supplied by the host when available.
   * Optional so older hosts stay compatible. Extensions that render images
   * (e.g. image-viewer, html-viewer) use this to resolve
   * `<img src="./relative.png">` into a streamable `whale-file://` URL. The
   * host should compute it once
   * (e.g. via `path.dirname(filePath)`) and pass it as-is — the extension
   * does no further normalization. If absent, the extension treats any
   * relative `src` as a remote URL and lets it 404.
   */
  dirPath?: string;
  /**
   * Set by the host when it wants the extension to replace its buffer even if
   * the editor is dirty (e.g. the user restored an older revision of this file
   * and confirmed losing the unsaved edits). Extensions that keep an unmodified
   * buffer on same-path reloads must honour it and reset their dirty state.
   */
  force?: boolean;
}

export interface SavingFileMessage {
  type: 'savingFile';
  path: string;
  /** Document version accepted by the host. Omitted by legacy hosts. */
  revision?: number;
}

export interface SetThemeMessage {
  type: 'setTheme';
  theme: 'light' | 'dark';
}

export interface SetReadOnlyMessage {
  type: 'setReadOnly';
  readOnly: boolean;
}

/** Host -> Extension: the host UI language (e.g. 'en', 'zh'). Sent on ready and
 *  whenever the user switches language, so the extension panel can re-render its
 *  own strings. Extensions carry their own small string catalogs (the host does
 *  not ship per-extension translations). */
export interface SetLocaleMessage {
  type: 'setLocale';
  locale: string;
}

export interface RequestSaveMessage {
  type: 'requestSave';
  path: string;
}

/** Host -> Extension: the libheif-js wasm bytes requested by heic-viewer.
 *  Fetching `whale-extension://` is unreliable in this Electron build, so the
 *  extension asks the host for the wasm and feeds it to emscripten as
 *  `wasmBinary`. `data` is null on read failure. */
export interface HeicWasmMessage {
  type: 'heicWasm';
  requestId: string;
  data: ArrayBuffer | null;
  error?: string;
}

/** Host -> Extension: a file is being dragged from Whale's directory tree over
 *  the extension (e.g. into the Excalidraw canvas). The iframe can't read the
 *  dropped File's path, so the host supplies it. active=false on drag end. */
export interface ExternalDragMessage {
  type: 'externalDrag';
  active: boolean;
  path?: string;
  name?: string;
  /** Images embed natively via the OS drop; non-images get a thumbnail+link. */
  isImage?: boolean;
  /** True when the dragged item is a directory (folders are never image-native
   *  drops, so extensions that insert a thumbnail always go through the
   *  `requestFileEmbed` round-trip). */
  isDirectory?: boolean;
}

/** Host -> Extension: thumbnail + metadata for a dropped non-image file, so the
 *  editor can insert a linked thumbnail element. */
export interface FileEmbedMessage {
  type: 'fileEmbed';
  path: string;
  name: string;
  /** A data: URL (real thumbnail, or a generic file-type icon as fallback). */
  thumbnailDataUrl: string;
  /** Echo of the `requestId` from `RequestFileEmbedMessage`. Present when the
   *  request carried one; absent for legacy extensions (and legacy hosts).
   *  Extensions must only place a reply whose id is still pending — see
   *  `src/shared/extension-requests.ts`. */
  requestId?: string;
}

/** Host -> Extension: the list of sibling files the extension can navigate
 *  to (e.g. image-viewer's prev/next within the current directory). Sent
 *  alongside `fileContent` so the viewer can light up its prev/next buttons
 *  immediately, and request a different path with `RequestFileMessage` when
 *  the user presses `←`/`→` or clicks a sibling button.
 *  - `current` is the file the extension is currently displaying (member of
 *    `paths`, or absent if the current file lives in another directory).
 *  - `paths` is a flat list of absolute paths in display order. The viewer is
 *    free to wrap around; the host does not pre-send file contents.
 *  - An empty `paths` is meaningful: it says "there is nothing to navigate to"
 *    and viewers must disable their prev/next controls. The host therefore
 *    always sends this message for a tab that opted into sibling navigation,
 *    instead of skipping the send and leaving stale buttons enabled. */
export interface SiblingsMessage {
  type: 'siblings';
  current: string;
  paths: string[];
}

export type HostMessage =
  | FileContentMessage
  | SavingFileMessage
  | SetThemeMessage
  | SetReadOnlyMessage
  | SetLocaleMessage
  | RequestSaveMessage
  | HeicWasmMessage
  | ExternalDragMessage
  | FileEmbedMessage
  | SiblingsMessage;

// Extension -> Host messages

export interface ReadyMessage {
  type: 'ready';
}

export interface ParentSaveDocumentMessage {
  type: 'parentSaveDocument';
  path: string;
  content: string;
  /** Version of `content`, echoed back by `savingFile`. Legacy editors omit it. */
  revision?: number;
}

export interface ContentChangedMessage {
  type: 'contentChangedInEditor';
  path: string;
  dirty: boolean;
  /** Latest editor document version. Legacy editors omit it. */
  revision?: number;
}

export interface OpenLinkExternallyMessage {
  type: 'openLinkExternally';
  url: string;
}

export interface ErrorMessage {
  type: 'error';
  path: string;
  message: string;
  /** Fatal document/load errors use the host's blocking retry surface instead
   *  of leaving a blank editor interactive. Ordinary runtime errors omit it. */
  fatal?: boolean;
}

/** Extension -> Host: heic-viewer requesting the libheif-js wasm bytes. */
export interface RequestHeicWasmMessage {
  type: 'requestHeicWasm';
  requestId: string;
}

/** Extension -> Host: request a thumbnail + metadata for a dropped non-image
 *  file so it can be inserted as a linked thumbnail (answered with fileEmbed).
 *  `isDirectory` switches the host between `loadThumbnail` (per-file pipeline)
 *  and `loadFolderThumbnail` (`<dir>/.whale/wst.jpg`).
 *  `requestId` correlates the reply: the host echoes it on `fileEmbed` so a
 *  late answer to an earlier drop cannot be placed at the newest drop's
 *  coordinates. Optional — extensions that omit it keep the old single-slot
 *  behaviour. */
export interface RequestFileEmbedMessage {
  type: 'requestFileEmbed';
  path: string;
  isDirectory?: boolean;
  requestId?: string;
}

/** Extension -> Host: ask the host to load and deliver the file at `path` as
 *  a normal `fileContent` message. Used by image-viewer's prev/next — the host
 *  already published the sibling list via `SiblingsMessage`, so the viewer
 *  just points at one of those paths and the host re-sends fileContent
 *  (re-encoding through `readFileContent` so the same base64 / utf8 plumbing
 *  is reused). The host is free to ignore requests for paths outside the
 *  active location.
 *
 *  `requestId` identifies the navigation attempt. The answer is a *new tab*
 *  showing the requested file, not a `fileContent` echo into this iframe, so
 *  the id is not round-tripped; the host uses it to drop a replayed request
 *  (double click / duplicated message) and to correlate its own log lines. */
export interface RequestFileMessage {
  type: 'requestFile';
  path: string;
  requestId?: string;
}

export type ExtensionMessage =
  | ReadyMessage
  | ParentSaveDocumentMessage
  | ContentChangedMessage
  | OpenLinkExternallyMessage
  | ErrorMessage
  | RequestHeicWasmMessage
  | RequestFileEmbedMessage
  | RequestFileMessage;

export interface RevisionInfo {
  /** ISO-8601 timestamp of the backup. */
  timestamp: string;
  /** Absolute path to the revision file. */
  path: string;
  /** Size in bytes. */
  size: number;
}

/** Identifies the kind of file content an extension needs. */
export type ExtensionEncoding = 'utf8' | 'base64';

/** Returns whether a value is a valid ExtensionEnvelope from the expected source. */
export function isValidEnvelope<T>(
  data: unknown,
  expectedSource: MessageSource
): data is ExtensionEnvelope<T> {
  if (typeof data !== 'object' || data === null) return false;
  const env = data as Partial<ExtensionEnvelope<T>>;
  const message = env.message as { type?: unknown } | null | undefined;
  return (
    env.protocolVersion === EXT_PROTOCOL_VERSION &&
    env.source === expectedSource &&
    // The old check only required `message !== undefined`, so any payload —
    // including one with a misspelled or unknown `type` — passed validation
    // and reached the host's switch. Require a known type as the first filter;
    // per-message payload validation stays in the handlers that know the shape.
    typeof message === 'object' &&
    message !== null &&
    typeof message.type === 'string' &&
    KNOWN_MESSAGE_TYPES.has(message.type)
  );
}

/**
 * Every message type the host↔extension protocol defines. Kept as a runtime
 * set (not just types) because envelopes are validated at the iframe boundary.
 * Keep it in sync with `HostMessage` / `ExtensionMessage` — a type listed here
 * but nowhere in the unions is a protocol entry nothing produces or consumes.
 */
const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'contentChangedInEditor',
  'error',
  'externalDrag',
  'fileContent',
  'fileEmbed',
  'heicWasm',
  'openLinkExternally',
  'parentSaveDocument',
  'ready',
  'requestFile',
  'requestFileEmbed',
  'requestHeicWasm',
  'requestSave',
  'savingFile',
  'setLocale',
  'setReadOnly',
  'setTheme',
  'siblings',
]);
