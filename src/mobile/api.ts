import type {
  LanListResponse,
  LanRootsResponse,
  LanSearchResponse,
  LanTagsResponse,
} from '../shared/lan-types';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const TEXT_PREVIEW_LIMIT = 256 * 1024;
const TEXT_PREVIEW_RANGE = `bytes=0-${TEXT_PREVIEW_LIMIT - 1}`;

export interface LanTextPreview {
  text: string;
  truncated: boolean;
}

export class LanApiError extends Error {
  constructor(
    public readonly status: number,
    message = `Request failed (${status})`,
  ) {
    super(message);
    this.name = 'LanApiError';
  }
}

export interface LanClient {
  pair(token: string, signal?: AbortSignal): Promise<void>;
  roots(signal?: AbortSignal): Promise<LanRootsResponse>;
  list(rootId: string, id?: string, signal?: AbortSignal): Promise<LanListResponse>;
  tags(rootId: string, signal?: AbortSignal): Promise<LanTagsResponse>;
  search(
    rootId: string,
    query: string,
    tag: string,
    signal?: AbortSignal,
  ): Promise<LanSearchResponse>;
  /**
   * Cheap HEAD probe for a single file. Media elements cannot expose an HTTP
   * status, so the preview uses this to tell an expired session (401) apart
   * from a corrupt or unsupported file.
   */
  probe(rootId: string, id: string, signal?: AbortSignal): Promise<void>;
  text(rootId: string, id: string, signal?: AbortSignal): Promise<LanTextPreview>;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  return search.toString();
}

export function fileUrl(rootId: string, id: string, download = false): string {
  return `/api/file?${query({ rootId, id, download: download ? '1' : undefined })}`;
}

export function createLanClient(fetchImpl: FetchLike = fetch): LanClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'X-Whale-Request': 'read-only',
        ...init.headers,
      },
    });
    if (!response.ok) throw new LanApiError(response.status);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    async pair(token, signal) {
      await request<void>('/api/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    },
    roots: (signal) => request<LanRootsResponse>('/api/roots', { signal }),
    list: (rootId, id, signal) =>
      request<LanListResponse>(`/api/list?${query({ rootId, id })}`, { signal }),
    tags: (rootId, signal) =>
      request<LanTagsResponse>(`/api/tags?${query({ rootId })}`, { signal }),
    search: (rootId, q, tag, signal) =>
      request<LanSearchResponse>(`/api/search?${query({ rootId, q: q.trim(), tag })}`, {
        signal,
      }),
    async probe(rootId, id, signal) {
      const response = await fetchImpl(fileUrl(rootId, id), {
        method: 'HEAD',
        credentials: 'same-origin',
        headers: { 'X-Whale-Request': 'read-only' },
        signal,
      });
      if (!response.ok) throw new LanApiError(response.status);
    },
    async text(rootId, id, signal) {
      const response = await fetchImpl(fileUrl(rootId, id), {
        credentials: 'same-origin',
        headers: { 'X-Whale-Request': 'read-only', Range: TEXT_PREVIEW_RANGE },
        signal,
      });
      if (response.status === 416) {
        const contentRange = response.headers.get('Content-Range');
        if (response.body) await response.body.cancel().catch(() => undefined);
        if (contentRange && contentRange.toLowerCase() !== 'bytes */0') {
          throw new LanApiError(response.status, 'Invalid empty-file Content-Range');
        }
        return { text: '', truncated: false };
      }
      if (!response.ok) throw new LanApiError(response.status);
      if (response.status === 206) {
        const contentRange = response.headers.get('Content-Range') ?? '';
        const match = /^bytes 0-(\d+)\/(\d+|\*)$/i.exec(contentRange);
        const end = match ? Number(match[1]) : Number.NaN;
        if (!match || !Number.isSafeInteger(end) || end >= TEXT_PREVIEW_LIMIT) {
          if (response.body) await response.body.cancel().catch(() => undefined);
          throw new LanApiError(response.status, 'Invalid text preview Content-Range');
        }
        const total = match[2];
        return {
          text: await response.text(),
          truncated: total === '*' || Number(total) > end + 1,
        };
      }
      if (response.status !== 200) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        throw new LanApiError(response.status, 'Unexpected text preview response');
      }
      // A missing or blank Content-Length cannot bound the body. Number(null)
      // is 0, which used to pass the guard below and read the whole file.
      const contentLength = response.headers.get('Content-Length');
      if (contentLength === null || contentLength.trim() === '') {
        if (response.body) await response.body.cancel().catch(() => undefined);
        return { text: '', truncated: true };
      }
      const length = Number(contentLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > TEXT_PREVIEW_LIMIT) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        return { text: '', truncated: true };
      }
      return { text: await response.text(), truncated: false };
    },
  };
}
