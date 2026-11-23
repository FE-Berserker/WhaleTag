import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IndexEntry } from '../../shared/ipc-types';
import type { SearchQuery } from '../../shared/search-query';
import { request } from '../index-worker-host';

export interface LanIndexSearchResult {
  entries: IndexEntry[];
  indexUnavailable: boolean;
}

export interface LanIndexTagsResult {
  tags: string[];
  indexUnavailable: boolean;
}

export interface LanIndexReader {
  search(rootPath: string, query: SearchQuery): Promise<LanIndexSearchResult>;
  tags(rootPath: string): Promise<LanIndexTagsResult>;
}

function hasIndex(rootPath: string): boolean {
  return existsSync(path.join(rootPath, '.whale', 'index.db'));
}

/**
 * SQLite stays in the index utilityProcess. The main-process precheck avoids
 * even spawning that process for a root with no index; the worker repeats the
 * check to close the removal race and always opens readonly/fileMustExist.
 */
export const workerLanIndexReader: LanIndexReader = {
  async search(rootPath, query) {
    if (!hasIndex(rootPath)) return { entries: [], indexUnavailable: true };
    return request('index:readonly-advanced', { rootPath, q: query });
  },
  async tags(rootPath) {
    if (!hasIndex(rootPath)) return { tags: [], indexUnavailable: true };
    return request('index:readonly-tags', { rootPath });
  },
};
