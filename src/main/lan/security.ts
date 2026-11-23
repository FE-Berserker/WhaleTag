import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Loopback and addresses usable for a direct, private LAN connection. */
export function isPrivateAddress(input: string | undefined): boolean {
  if (!input) return false;
  let address = input.trim().split('%', 1)[0];
  if (address.startsWith('::ffff:')) address = address.slice(7);
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    /^fe[89ab]/.test(lower)
  );
}

export function normalizeAddress(input: string): string {
  let address = input.trim().split('%', 1)[0].toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) {
    address = address.slice(7);
  }
  return address;
}

/** Parses only a literal IPv4/IPv6 Host header; DNS names are never accepted. */
export function parseLiteralHost(
  value: string | undefined,
  expectedPort: number
): string | null {
  if (!value) return null;
  let address: string;
  let portText: string | undefined;
  const ipv6 = /^\[([0-9a-fA-F:.]+)\](?::([0-9]+))?$/.exec(value);
  if (ipv6) {
    address = ipv6[1];
    portText = ipv6[2];
  } else {
    const ipv4 = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3})(?::([0-9]+))?$/.exec(value);
    if (!ipv4) return null;
    address = ipv4[1];
    portText = ipv4[2];
  }
  const port = portText === undefined ? 80 : Number(portText);
  if (!Number.isSafeInteger(port) || port !== expectedPort) return null;
  const normalized = normalizeAddress(address);
  return isIP(normalized) ? normalized : null;
}

export function isAllowedOrigin(
  origin: string,
  port: number,
  allowedAddresses: ReadonlySet<string>
): boolean {
  try {
    const url = new URL(origin);
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    const address = normalizeAddress(url.hostname);
    const originPort = url.port ? Number(url.port) : 80;
    return (
      isIP(address) > 0 &&
      originPort === port &&
      allowedAddresses.has(address) &&
      isPrivateAddress(address)
    );
  } catch {
    return false;
  }
}

export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return (
    a.length === b.length &&
    timingSafeEqual(new Uint8Array(a), new Uint8Array(b))
  );
}

export function encodeEntryId(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

export class EntryIdError extends Error {}

/** Decodes a canonical UTF-8 base64url portable path, not an absolute path. */
export function decodeEntryId(id: string): string {
  if (
    id.length === 0 ||
    id.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(id) ||
    id.length % 4 === 1
  ) {
    throw new EntryIdError('Invalid entry id');
  }
  const bytes = Buffer.from(id, 'base64url');
  if (bytes.toString('base64url') !== id) throw new EntryIdError('Invalid entry id');
  const relative = bytes.toString('utf8');
  if (Buffer.from(relative, 'utf8').toString('latin1') !== bytes.toString('latin1')) {
    throw new EntryIdError('Invalid entry id');
  }
  validatePortableRelativePath(relative);
  return relative;
}

export function validatePortableRelativePath(relative: string): void {
  if (
    !relative ||
    relative.length > 2048 ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    relative.startsWith('/') ||
    /^[A-Za-z]:/.test(relative)
  ) {
    throw new EntryIdError('Invalid entry path');
  }
  const segments = relative.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.whale'
    )
  ) {
    throw new EntryIdError('Invalid entry path');
  }
}

export function hasHiddenMetadataSegment(relative: string): boolean {
  return relative
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === '.whale');
}

export type ParsedRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'malformed' }
  | { kind: 'unsatisfiable' };

/** Single byte ranges only. Multi-ranges are deliberately not coalesced. */
export function parseLanRange(header: string, size: number): ParsedRange {
  if (header.includes(',')) return { kind: 'unsatisfiable' };
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return { kind: 'malformed' };
  if (size <= 0) return { kind: 'unsatisfiable' };
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, size - Math.min(suffix, size));
    return { kind: 'range', start, end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= size) {
    return { kind: 'unsatisfiable' };
  }
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (match[2] && !Number.isSafeInteger(requestedEnd)) {
    // An end beyond the safe integer range is safely clamped to EOF.
    return { kind: 'range', start, end: size - 1 };
  }
  if (requestedEnd < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end: Math.min(requestedEnd, size - 1) };
}

export function contentDisposition(
  disposition: 'inline' | 'attachment',
  name: string
): string {
  const fallback = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[\r\n]/g, '_')
    .slice(0, 180) || 'file';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
