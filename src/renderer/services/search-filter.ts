/**
 * Renderer-side re-export of the shared search-query helpers. The structured
 * query now runs as SQL in the main process (`src/main/index-db.ts
 * advancedQuery`); the old in-memory `filterIndex` / `uniqueTags` are gone with
 * the Fuse.js index. This file is kept so existing `-/services/search-filter`
 * imports keep resolving.
 */
export type {
  SearchQuery,
  TagMatch,
  TypeFilter,
} from '../../shared/search-query';
export { emptyQuery, isQueryEmpty, parseExtensions } from '../../shared/search-query';
