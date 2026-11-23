import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, type Stats } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces as osNetworkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import type { Socket } from 'node:net';
import type {
  LanEntry,
  LanListResponse,
  LanRoot,
  LanSearchResponse,
  LanStatus,
  LanTagsResponse,
} from '../../shared/lan-types';
import type { SearchQuery } from '../../shared/search-query';
import type { IndexEntry } from '../../shared/ipc-types';
import { mergeTags } from '../../shared/tags';
import { getAllowedRoots } from '../allowed-roots';
import { mapWithConcurrency } from '../concurrency';
import { readSidecarsReadOnly } from '../sidecar';
import { workerLanIndexReader, type LanIndexReader } from './index-reader';
import {
  contentDisposition,
  decodeEntryId,
  encodeEntryId,
  EntryIdError,
  hasHiddenMetadataSegment,
  isAllowedOrigin,
  isPrivateAddress,
  normalizeAddress,
  parseLanRange,
  parseLiteralHost,
  secretsEqual,
  validatePortableRelativePath,
} from './security';

export const LAN_SESSION_COOKIE = 'whale_lan_session';
export const LAN_REQUEST_HEADER = 'x-whale-request';
export const LAN_REQUEST_VALUE = 'read-only';
export const LAN_LIST_LIMIT = 500;
export const LAN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const MIME: Record<string, string> = {
  '.aac': 'audio/aac',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.svgz': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};
const FORCED_DOWNLOAD_EXTENSIONS = new Set([
  '.cjs',
  '.htm',
  '.html',
  '.js',
  '.mjs',
  '.pdf',
  '.svg',
  '.svgz',
  '.xhtml',
  '.xml',
]);

interface RootContext {
  id: string;
  name: string;
  realPath: string;
}

interface ActiveLan {
  server: Server;
  token: string;
  sessions: Set<string>;
  roots: RootContext[];
  port: number;
  urls: string[];
  addresses: Set<string>;
  fingerprint: string;
  networkInterfaces: typeof osNetworkInterfaces;
  mobileRoot: string | null;
  authFailures: Map<string, { windowStarted: number; count: number }>;
  timer: NodeJS.Timeout | null;
  sockets: Set<Socket>;
  closed: boolean;
}

export interface LanServerOptions {
  /** Defaults to an ephemeral port. */
  port?: number;
  /** Defaults to 0.0.0.0; loopback is useful for isolated tests. */
  host?: string;
  /** Test/embedding seam. Production defaults to getAllowedRoots(). */
  roots?: readonly string[];
  indexReader?: LanIndexReader;
  networkInterfaces?: typeof osNetworkInterfaces;
  networkPollMs?: number;
  listLimit?: number;
  /** Test seam; production defaults to the sibling dist/mobile directory. */
  mobileRoot?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

let activeLan: ActiveLan | null = null;
let startPromise: Promise<LanStatus> | null = null;
let stopPromise: Promise<LanStatus> | null = null;
let lifecycleGeneration = 0;

function foldedPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function prepareRoots(rawRoots: readonly string[]): Promise<RootContext[]> {
  const roots: RootContext[] = [];
  const seen = new Set<string>();
  for (const candidate of rawRoots) {
    try {
      const realPath = await fsp.realpath(candidate);
      const stat = await fsp.stat(realPath);
      if (!stat.isDirectory()) continue;
      const key = foldedPath(realPath);
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({
        id: `r${roots.length + 1}`,
        name: path.basename(realPath) || `Root ${roots.length + 1}`,
        realPath,
      });
    } catch {
      // A disconnected configured location is omitted, never substituted with
      // an unresolved path or created on behalf of a LAN reader.
    }
  }
  return roots;
}

function networkSnapshot(provider: typeof osNetworkInterfaces): {
  addresses: Set<string>;
  urls: string[];
  fingerprint: string;
} {
  const addresses = new Set<string>(['127.0.0.1', '::1']);
  const urls: string[] = [];
  for (const entries of Object.values(provider())) {
    for (const entry of entries ?? []) {
      const address = normalizeAddress(entry.address);
      if (!isPrivateAddress(address)) continue;
      addresses.add(address);
      // Link-local IPv6 requires an interface zone in a URL and is not useful
      // for the pairing screen. It remains valid for socket/Host validation.
      if (!entry.internal && !/^fe[89ab]/.test(address)) urls.push(address);
    }
  }
  // Loopback is a fallback only. A QR code must prefer a phone-reachable LAN
  // interface whenever one exists; tests binding 127.0.0.1 still get a URL.
  if (urls.length === 0) urls.push('127.0.0.1');
  const uniqueUrls = [...new Set(urls)];
  return {
    addresses,
    urls: uniqueUrls,
    fingerprint: [...addresses].sort().join('|'),
  };
}

function publicUrl(address: string, port: number): string {
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return `http://${host}:${port}/`;
}

function statusFor(active: ActiveLan): LanStatus {
  return {
    running: !active.closed,
    port: active.closed ? null : active.port,
    urls: active.closed ? [] : [...active.urls],
    token: active.closed ? null : active.token,
  };
}

export function getLanStatus(): LanStatus {
  return activeLan ? statusFor(activeLan) : {
    running: false,
    port: null,
    urls: [],
    token: null,
  };
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', LAN_CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  for (const [key, headerValue] of Object.entries(extraHeaders)) {
    res.setHeader(key, headerValue);
  }
  res.end(req.method === 'HEAD' ? undefined : body);
}

function findRoot(active: ActiveLan, id: string | null): RootContext {
  if (!id) throw new HttpError(400, 'rootId is required');
  const root = active.roots.find((candidate) => candidate.id === id);
  if (!root) throw new HttpError(404, 'Root not found');
  return root;
}

async function resolveEntry(
  root: RootContext,
  id: string
): Promise<{ realPath: string; relative: string }> {
  let relative: string;
  try {
    relative = decodeEntryId(id);
    validatePortableRelativePath(relative);
  } catch (error) {
    if (error instanceof EntryIdError) throw new HttpError(400, 'Invalid entry id');
    throw error;
  }
  if (hasHiddenMetadataSegment(relative)) throw new HttpError(404, 'Entry not found');
  const unresolved = path.resolve(root.realPath, ...relative.split('/'));
  if (!isInside(root.realPath, unresolved)) throw new HttpError(403, 'Entry is outside the root');
  let realPath: string;
  try {
    realPath = await fsp.realpath(unresolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'Entry not found');
    }
    throw error;
  }
  if (!isInside(root.realPath, realPath)) {
    throw new HttpError(403, 'Entry is outside the root');
  }
  const targetRelative = path.relative(root.realPath, realPath);
  if (hasHiddenMetadataSegment(targetRelative)) {
    throw new HttpError(404, 'Entry not found');
  }
  return { realPath, relative };
}

function makeLanEntry(
  root: RootContext,
  relative: string,
  name: string,
  stat: Stats,
  tags: readonly string[] = []
): LanEntry {
  const isDirectory = stat.isDirectory();
  return {
    id: encodeEntryId(relative),
    rootId: root.id,
    name,
    path: relative,
    isDirectory,
    size: isDirectory ? 0 : stat.size,
    modified: new Date(stat.mtimeMs).toISOString(),
    extension: isDirectory ? '' : path.extname(name).toLowerCase(),
    tags: mergeTags(name, [...tags]),
  };
}

async function listDirectory(
  root: RootContext,
  id: string | null,
  limit: number
): Promise<LanListResponse & { truncated: boolean }> {
  let realPath = root.realPath;
  let relative = '';
  if (id !== null) ({ realPath, relative } = await resolveEntry(root, id));
  let stat: Stats;
  try {
    stat = await fsp.stat(realPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'Directory not found');
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new HttpError(400, 'Entry is not a directory');
  const dirents = await fsp.readdir(realPath, { withFileTypes: true });
  const visible = dirents
    .filter((entry) => entry.name.toLowerCase() !== '.whale')
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name)
    );
  const truncated = visible.length > limit;
  const selected = visible.slice(0, limit);
  const entries = await mapWithConcurrency(selected, 16, async (entry) => {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    try {
      const resolved = await resolveEntry(root, encodeEntryId(childRelative));
      const childStat = await fsp.stat(resolved.realPath);
      if (!childStat.isDirectory() && !childStat.isFile()) return null;
      return {
        entry,
        resolved,
        childRelative,
        childStat,
      };
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
        return null;
      }
      if ((error as NodeJS.ErrnoException).code === 'EACCES') return null;
      throw error;
    }
  });
  const present = entries.filter(
    (value): value is NonNullable<typeof value> => value !== null
  );
  let sidecars: Awaited<ReturnType<typeof readSidecarsReadOnly>> = {};
  let metadataUnavailable = false;
  try {
    sidecars = await readSidecarsReadOnly(
      realPath,
      present.map(({ entry }) => entry.name)
    );
  } catch {
    metadataUnavailable = true;
    console.warn('LAN directory metadata is unavailable; continuing without sidecar tags');
  }
  const result = present
    .map(({ entry, childRelative, childStat }) =>
      makeLanEntry(
        root,
        childRelative,
        entry.name,
        childStat,
        sidecars[entry.name]?.tags ?? []
      )
    )
    .sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
    );
  const parentRelative = relative ? path.posix.dirname(relative) : '';
  return {
    rootId: root.id,
    id: relative ? encodeEntryId(relative) : '',
    name: relative ? path.posix.basename(relative) : root.name,
    path: relative,
    parentId: relative && parentRelative !== '.' ? encodeEntryId(parentRelative) : null,
    entries: result,
    truncated,
    ...(metadataUnavailable ? { metadataUnavailable: true } : {}),
  };
}

async function searchIndex(
  root: RootContext,
  url: URL,
  reader: LanIndexReader
): Promise<LanSearchResponse> {
  const q = url.searchParams.getAll('q');
  if (q.length > 1) throw new HttpError(400, 'q must be a single value');
  const tags = url.searchParams.getAll('tag');
  if (tags.length > 16 || tags.some((tag) => tag.length > 128)) {
    throw new HttpError(400, 'Invalid tag filter');
  }
  const text = q[0] ?? '';
  if (text.length > 512) throw new HttpError(400, 'q is too long');
  const query: SearchQuery = {
    text,
    tags,
    tagMatch: 'all',
    excludeTags: [],
    type: 'any',
    extensions: [],
    sizeMinBytes: null,
    sizeMaxBytes: null,
    modifiedAfter: null,
    modifiedBefore: null,
  };
  const result = await reader.search(root.realPath, query);
  const entries = await mapWithConcurrency(result.entries, 8, async (indexed) =>
    lanEntryFromIndex(root, indexed)
  );
  return {
    entries: entries.filter((entry): entry is LanEntry => entry !== null),
    indexUnavailable: result.indexUnavailable,
  };
}

async function lanEntryFromIndex(
  root: RootContext,
  indexed: IndexEntry
): Promise<LanEntry | null> {
  try {
    validatePortableRelativePath(indexed.path);
    if (hasHiddenMetadataSegment(indexed.path)) return null;
    const { realPath, relative } = await resolveEntry(root, encodeEntryId(indexed.path));
    const stat = await fsp.stat(realPath);
    if (!stat.isFile() && !stat.isDirectory()) return null;
    return makeLanEntry(root, relative, path.posix.basename(relative), stat, indexed.tags);
  } catch (error) {
    if (error instanceof EntryIdError) return null;
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return null;
    throw error;
  }
}

function safeMime(name: string): { mime: string; forcedDownload: boolean } {
  const extension = path.extname(name).toLowerCase();
  return {
    mime: MIME[extension] ?? 'application/octet-stream',
    forcedDownload: FORCED_DOWNLOAD_EXTENSIONS.has(extension),
  };
}

async function serveFile(
  active: ActiveLan,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const root = findRoot(active, url.searchParams.get('rootId'));
  const id = url.searchParams.get('id');
  if (!id) throw new HttpError(400, 'id is required');
  const download = url.searchParams.get('download');
  if (download !== null && download !== '0' && download !== '1') {
    throw new HttpError(400, 'download must be 0 or 1');
  }
  const { realPath, relative } = await resolveEntry(root, id);
  let stat: Stats;
  try {
    stat = await fsp.stat(realPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'File not found');
    }
    throw error;
  }
  if (!stat.isFile()) throw new HttpError(400, 'Entry is not a file');
  const name = path.posix.basename(relative);
  const { mime, forcedDownload } = safeMime(name);
  const disposition =
    download === '1' || forcedDownload ? 'attachment' : 'inline';
  const rangeHeader = req.headers.range;
  const range = typeof rangeHeader === 'string' ? parseLanRange(rangeHeader, stat.size) : null;
  if (range?.kind === 'malformed') throw new HttpError(400, 'Malformed Range header');
  const common = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Content-Disposition': contentDisposition(disposition, name),
  };
  if (range?.kind === 'unsatisfiable') {
    throw new HttpError(416, 'Range not satisfiable', {
      ...common,
      'Content-Range': `bytes */${stat.size}`,
    });
  }
  const partial = range?.kind === 'range';
  const start = partial ? range.start : 0;
  const end = partial ? range.end : Math.max(0, stat.size - 1);
  const length = partial ? end - start + 1 : stat.size;
  res.statusCode = partial ? 206 : 200;
  for (const [key, value] of Object.entries(common)) res.setHeader(key, value);
  res.setHeader('Content-Length', length);
  if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(realPath, partial ? { start, end } : undefined);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const STATIC_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function staticRelativePath(rawUrl: string): string {
  const end = rawUrl.search(/[?#]/);
  const rawPath = end === -1 ? rawUrl : rawUrl.slice(0, end);
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, 'Invalid static path');
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    throw new HttpError(403, 'Static path is not allowed');
  }
  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new HttpError(403, 'Static traversal is not allowed');
  }
  if (pathname === '/' || pathname === '/index.html') return 'index.html';
  const rootAsset = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(pathname);
  const assetPath = pathname.startsWith('/assets/') ? pathname.slice(1) : null;
  const relative = assetPath ?? rootAsset?.[1] ?? null;
  if (!relative || segments.some((segment) => segment.startsWith('.'))) {
    throw new HttpError(404, 'Not found');
  }
  const extension = path.posix.extname(relative).toLowerCase();
  if (!STATIC_MIME[extension] || extension === '.html') {
    throw new HttpError(404, 'Not found');
  }
  return relative;
}

async function serveStatic(
  active: ActiveLan,
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, 'Method not allowed');
  }
  if (!active.mobileRoot) throw new HttpError(404, 'Mobile client is not built');
  const relative = staticRelativePath(rawUrl);
  const unresolved = path.resolve(active.mobileRoot, ...relative.split('/'));
  if (!isInside(active.mobileRoot, unresolved)) {
    throw new HttpError(403, 'Static path is outside the client');
  }
  let realPath: string;
  try {
    realPath = await fsp.realpath(unresolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'Not found');
    }
    throw error;
  }
  if (!isInside(active.mobileRoot, realPath)) {
    throw new HttpError(403, 'Static path is outside the client');
  }
  const stat = await fsp.stat(realPath);
  if (!stat.isFile()) throw new HttpError(404, 'Not found');
  res.statusCode = 200;
  res.setHeader('Content-Type', STATIC_MIME[path.extname(realPath).toLowerCase()]);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(realPath);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function authRetryAfter(active: ActiveLan, remote: string): number {
  const now = Date.now();
  const current = active.authFailures.get(remote);
  if (!current || now - current.windowStarted >= 60_000) {
    active.authFailures.delete(remote);
    return 0;
  }
  return current.count >= 5 ? Math.max(1, Math.ceil((60_000 - (now - current.windowStarted)) / 1000)) : 0;
}

function noteAuthFailure(active: ActiveLan, remote: string): void {
  const now = Date.now();
  const current = active.authFailures.get(remote);
  if (!current || now - current.windowStarted >= 60_000) {
    active.authFailures.set(remote, { windowStarted: now, count: 1 });
  } else {
    current.count += 1;
  }
  if (active.authFailures.size > 256) {
    for (const [address, record] of active.authFailures) {
      if (now - record.windowStarted >= 60_000) active.authFailures.delete(address);
    }
  }
}

function sessionFromCookie(active: ActiveLan, header: string | undefined): boolean {
  if (!header) return false;
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${LAN_SESSION_COOKIE}=`));
  if (matches.length !== 1) return false;
  const value = matches[0].slice(LAN_SESSION_COOKIE.length + 1);
  for (const session of active.sessions) {
    if (secretsEqual(value, session)) return true;
  }
  return false;
}

function assertNetworkRequest(active: ActiveLan, req: IncomingMessage): void {
  const remote = req.socket.remoteAddress;
  const local = req.socket.localAddress;
  if (!isPrivateAddress(remote) || !isPrivateAddress(local)) {
    throw new HttpError(403, 'Private LAN access required');
  }
  if (!active.addresses.has(normalizeAddress(local!))) {
    throw new HttpError(403, 'Interface is not allowed');
  }
  const host = parseLiteralHost(req.headers.host, active.port);
  if (!host || !active.addresses.has(host) || !isPrivateAddress(host)) {
    throw new HttpError(403, 'Host is not allowed');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string' || !isAllowedOrigin(origin, active.port, active.addresses)) {
      throw new HttpError(403, 'Origin is not allowed');
    }
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (
    fetchSite !== undefined &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'none'
  ) {
    throw new HttpError(403, 'Cross-site requests are not allowed');
  }
}

async function handleRequest(
  active: ActiveLan,
  req: IncomingMessage,
  res: ServerResponse,
  reader: LanIndexReader,
  listLimit: number
): Promise<void> {
  setCommonHeaders(res);
  try {
    if (active.closed) throw new HttpError(503, 'LAN server is stopped');
    assertNetworkRequest(active, req);
    const rawUrl = req.url;
    if (!rawUrl || rawUrl.length > 8192 || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
      throw new HttpError(400, 'Invalid request URL');
    }
    const url = new URL(rawUrl, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      await serveStatic(active, req, res, rawUrl);
      return;
    }
    if (req.headers['transfer-encoding'] !== undefined) {
      throw new HttpError(400, 'Request bodies are not supported');
    }
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > 1024) {
      throw new HttpError(413, 'Request body is too large');
    }

    if (pathname === '/api/session') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'Method not allowed');
      }
      if (req.headers[LAN_REQUEST_HEADER] !== LAN_REQUEST_VALUE) {
        throw new HttpError(403, 'Missing read-only request header');
      }
      const remote = req.socket.remoteAddress ?? '';
      const retryAfter = authRetryAfter(active, remote);
      if (retryAfter > 0) {
        throw new HttpError(429, 'Too many authentication failures', {
          'Retry-After': String(retryAfter),
        });
      }
      const authorization = req.headers.authorization;
      const match = typeof authorization === 'string' ? /^Bearer (.+)$/.exec(authorization) : null;
      if (!match || !secretsEqual(match[1], active.token)) {
        noteAuthFailure(active, remote);
        throw new HttpError(401, 'Invalid token', {
          'WWW-Authenticate': 'Bearer realm="whale-lan"',
        });
      }
      active.authFailures.delete(remote);
      const session = randomBytes(32).toString('base64url');
      if (active.sessions.size >= 64) {
        const oldest = active.sessions.values().next().value;
        if (oldest) active.sessions.delete(oldest);
      }
      active.sessions.add(session);
      res.statusCode = 204;
      res.setHeader(
        'Set-Cookie',
        `${LAN_SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`
      );
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw new HttpError(405, 'Method not allowed');
    }
    const isFile = pathname === '/api/file';
    if (!isFile && req.headers[LAN_REQUEST_HEADER] !== LAN_REQUEST_VALUE) {
      throw new HttpError(403, 'Missing read-only request header');
    }
    if (!sessionFromCookie(active, req.headers.cookie)) {
      throw new HttpError(401, 'Authentication required', {
        'WWW-Authenticate': 'Cookie',
      });
    }

    switch (pathname) {
      case '/api/roots': {
        const roots: LanRoot[] = active.roots.map(({ id, name }) => ({ id, name }));
        sendJson(req, res, 200, { roots });
        return;
      }
      case '/api/list': {
        const root = findRoot(active, url.searchParams.get('rootId'));
        const ids = url.searchParams.getAll('id');
        if (ids.length > 1) throw new HttpError(400, 'id must be a single value');
        const result = await listDirectory(root, ids.length === 0 ? null : ids[0], listLimit);
        sendJson(req, res, 200, result);
        return;
      }
      case '/api/tags': {
        const root = findRoot(active, url.searchParams.get('rootId'));
        const result = await reader.tags(root.realPath);
        const body: LanTagsResponse = {
          tags: result.tags,
          indexUnavailable: result.indexUnavailable,
        };
        sendJson(req, res, 200, body);
        return;
      }
      case '/api/search': {
        const root = findRoot(active, url.searchParams.get('rootId'));
        sendJson(req, res, 200, await searchIndex(root, url, reader));
        return;
      }
      case '/api/file':
        await serveFile(active, req, res, url);
        return;
      default:
        throw new HttpError(404, 'Not found');
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const httpError =
      error instanceof HttpError
        ? error
        : new HttpError(500, 'Internal server error');
    sendJson(req, res, httpError.status, { error: httpError.message }, httpError.headers);
  }
}

async function closeActiveLan(active: ActiveLan): Promise<void> {
  if (activeLan === active) activeLan = null;
  active.closed = true;
  active.token = '';
  active.sessions.clear();
  active.authFailures.clear();
  if (active.timer) {
    clearInterval(active.timer);
    active.timer = null;
  }
  active.server.closeAllConnections();
  for (const socket of active.sockets) socket.destroy();
  active.sockets.clear();
  if (!active.server.listening) return;
  await new Promise<void>((resolve) => {
    active.server.close(() => resolve());
  });
}

/** Starts a new session domain. No module init, settings, or token persistence. */
export async function startLanServer(
  options: LanServerOptions = {}
): Promise<LanStatus> {
  if (activeLan && !activeLan.closed && !stopPromise) return getLanStatus();
  if (startPromise) return startPromise;
  const generation = ++lifecycleGeneration;
  const operation = (async () => {
    if (stopPromise) await stopPromise;
    if (generation !== lifecycleGeneration) return getLanStatus();
    const provider = options.networkInterfaces ?? osNetworkInterfaces;
    const roots = await prepareRoots(options.roots ?? getAllowedRoots());
    const host = options.host ?? '0.0.0.0';
    const snapshot = networkSnapshot(provider);
    const addresses = host === '127.0.0.1' || host === '::1'
      ? new Set([host])
      : new Set(snapshot.addresses);
    const server = createServer();
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 100;
    let mobileRoot: string | null = null;
    try {
      mobileRoot = await fsp.realpath(
        options.mobileRoot ?? path.resolve(__dirname, '../mobile')
      );
    } catch {
      // APIs remain available in development when the mobile bundle is absent.
    }
    const active: ActiveLan = {
      server,
      token: randomBytes(32).toString('base64url'),
      sessions: new Set(),
      roots,
      port: 0,
      urls: [],
      addresses,
      fingerprint: snapshot.fingerprint,
      networkInterfaces: provider,
      mobileRoot,
      authFailures: new Map(),
      timer: null,
      sockets: new Set(),
      closed: false,
    };
    const reader = options.indexReader ?? workerLanIndexReader;
    const listLimit = Math.max(
      1,
      Math.min(options.listLimit ?? LAN_LIST_LIMIT, LAN_LIST_LIMIT)
    );
    server.on('request', (req, res) => {
      void handleRequest(active, req, res, reader, listLimit);
    });
    server.on('connection', (socket) => {
      if (active.closed) {
        socket.destroy();
        return;
      }
      active.sockets.add(socket);
      socket.on('close', () => active.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    if (generation !== lifecycleGeneration) return getLanStatus();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(options.port ?? 0, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
    if (generation !== lifecycleGeneration) {
      await closeActiveLan(active);
      return getLanStatus();
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('LAN server did not bind a TCP port');
    }
    active.port = address.port;
    active.urls = (host === '127.0.0.1' || host === '::1' ? [host] : snapshot.urls)
      .filter((ip) => host !== '0.0.0.0' || isIP(ip) === 4)
      .map((ip) => publicUrl(ip, active.port));
    if (active.urls.length === 0) {
      await closeActiveLan(active);
      throw new Error('No private IPv4 interface is available for LAN access');
    }
    activeLan = active;
    const pollMs = Math.max(50, options.networkPollMs ?? 2000);
    active.timer = setInterval(() => {
      if (active.closed) return;
      if (networkSnapshot(active.networkInterfaces).fingerprint !== active.fingerprint) {
        void stopLanServer();
      }
    }, pollMs);
    active.timer.unref();
    return statusFor(active);
  })();
  startPromise = operation;
  try {
    return await operation;
  } finally {
    if (startPromise === operation) startPromise = null;
  }
}

/** Stops listeners and all sockets, and invalidates every token/session first. */
export async function stopLanServer(): Promise<LanStatus> {
  if (stopPromise) {
    ++lifecycleGeneration;
    return stopPromise;
  }
  const pendingStart = startPromise;
  startPromise = null;
  if (!pendingStart && !activeLan) return getLanStatus();
  ++lifecycleGeneration;
  stopPromise = (async () => {
    if (pendingStart) {
      try {
        await pendingStart;
      } catch {
        // A failed/cancelled start must not prevent the stop barrier completing.
      }
    }
    if (activeLan) await closeActiveLan(activeLan);
    return getLanStatus();
  })();
  try {
    return await stopPromise;
  } finally {
    stopPromise = null;
  }
}

/** App-shutdown hook; intentionally has the same non-persistent semantics. */
export async function shutdownLanServer(): Promise<void> {
  await stopLanServer();
}
