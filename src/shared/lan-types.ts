/** Public contracts for the opt-in, read-only LAN web interface. */

export interface LanStatus {
  running: boolean;
  port: number | null;
  /** Base URLs without credentials, one per usable private interface. */
  urls: string[];
  /** Session-scoped pairing secret. Null while stopped; never persisted. */
  token: string | null;
}

export interface LanRoot {
  id: string;
  name: string;
}

export interface LanEntry {
  /** Opaque root-scoped id; never an absolute filesystem path. */
  id: string;
  rootId: string;
  name: string;
  /** Portable relative path within the configured location. */
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  extension: string;
  tags: string[];
}

export interface LanRootsResponse {
  roots: LanRoot[];
}

export interface LanListResponse {
  rootId: string;
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  entries: LanEntry[];
  /** True when the bounded first page reached the directory safety limit. */
  truncated?: boolean;
  /** True when sidecar metadata failed to load; files remain visible without those tags. */
  metadataUnavailable?: boolean;
}

export interface LanSearchResponse {
  entries: LanEntry[];
  /** Search/tag reads never create an index; the desktop app must build one. */
  indexUnavailable: boolean;
}

export interface LanTagsResponse {
  tags: string[];
  indexUnavailable: boolean;
}
