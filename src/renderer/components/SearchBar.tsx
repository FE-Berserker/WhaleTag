import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import TuneIcon from '@mui/icons-material/Tune';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import FolderIcon from '@mui/icons-material/Folder';

import FileTypeIcon from './FileTypeIcon';
import type { IndexEntry, FulltextHit } from '../../shared/ipc-types';
import { RootState } from '-/reducers';
import { useLocationIndexContext } from '-/hooks/LocationIndexContextProvider';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { ipcApi } from '-/services/ipc-api';
import { joinPath } from '-/services/path-util';
import { normalizeFsPath } from '-/reducers/settings';
import { searchAllFulltext } from '-/services/fulltext-search';
import AdvancedSearchDialog from '-/components/AdvancedSearchDialog';

/** True if `s` contains any CJK ideograph / symbol / fullwidth character. */
function hasCjk(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK symbols & punctuation
      (code >= 0xff00 && code <= 0xffef) // Fullwidth forms
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Wraps every case-insensitive occurrence of `query` in `text` with <mark>.
 * Computed client-side from the hit name + the query (SQLite FTS5 returns hits
 * but not byte ranges, so we no longer rely on Fuse's match indices).
 */
function Highlighted({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  let idx = lower.indexOf(needle, cursor);
  while (idx !== -1) {
    if (idx > cursor) nodes.push(text.slice(cursor, idx));
    nodes.push(
      <Box
        component="mark"
        key={i}
        sx={{
          bgcolor: 'warning.main',
          color: '#1f2937',
          borderRadius: 0.5,
          px: '2px',
        }}
      >
        {text.slice(idx, idx + needle.length)}
      </Box>
    );
    i += 1;
    cursor = idx + needle.length;
    idx = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/**
 * Cross-location filename search. Search runs ONLY on Enter (editing/deleting
 * the query never triggers a search); Escape clears. Results show matched
 * substrings highlighted; clicking a result navigates to its directory.
 */
export default function SearchBar() {
  const { t } = useTranslation();
  const { status, progress, build, search } = useLocationIndexContext();
  const { currentLocation, navigateTo, navigateToInLocation } =
    useCurrentLocationContext();
  const fulltextPaths = useSelector(
    (s: RootState) => s.settings?.fulltextPaths ?? []
  );
  const locations = useSelector((s: RootState) => s.locations.items);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IndexEntry[]>([]);
  const [contentResults, setContentResults] = useState<FulltextHit[]>([]);
  const [contentMode, setContentMode] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const busy = status === 'loading' || status === 'building';
  const fulltextOn = fulltextPaths.length > 0;

  // docs/04 §10: live build progress next to the spinner, e.g. "Indexing…
  // 1,234" (scan, no total) or "Indexing… 1,234/5,000" (ingest).
  const progressText =
    status === 'building' && progress
      ? progress.total != null
        ? t('indexBuildingTotal', {
            processed: progress.processed,
            total: progress.total,
          })
        : t('indexBuilding', { processed: progress.processed })
      : null;

  /** Run the search (Enter only). No-op if not ready or query too short. */
  const runSearch = async () => {
    const q = query.trim();
    if (contentMode) {
      // Full-text content search across enabled roots (runs in main process).
      if (!q) {
        setContentResults([]);
        setOpen(false);
        return;
      }
      setContentBusy(true);
      searchAllFulltext(fulltextPaths, q)
        .then((hits) => setContentResults(hits))
        .finally(() => {
          setContentBusy(false);
          setOpen(true);
        });
      return;
    }
    // CJK single-character queries are allowed; Latin/ASCII need >= 2 chars
    // (a single ASCII letter would match far too many files).
    if (status !== 'ready' || !q || (q.length < 2 && !hasCjk(q))) {
      setResults([]);
      setOpen(false);
      return;
    }
    const hits = await search(query);
    setResults(hits);
    setOpen(true);
  };

  const handlePick = async (entry: IndexEntry) => {
    if (!currentLocation) return;
    const abs = joinPath(currentLocation.path, entry.path);
    const dir = await ipcApi.parentDir(abs);
    navigateTo(dir);
    setOpen(false);
    setQuery('');
  };

  /** Navigate to a content hit — into its location if known, else open natively. */
  const handlePickContent = async (hit: FulltextHit) => {
    const target = normalizeFsPath(hit.path);
    const loc = locations.find((l) => {
      const lp = normalizeFsPath(l.path);
      return target === lp || target.startsWith(`${lp}/`);
    });
    if (loc) {
      const dir = await ipcApi.parentDir(hit.path);
      navigateToInLocation(loc.id, dir);
    } else {
      await ipcApi.openNative(hit.path).catch(() => undefined);
    }
    setOpen(false);
    setQuery('');
  };

  const clear = () => {
    setQuery('');
    setResults([]);
    setContentResults([]);
    setOpen(false);
  };

  // No index yet: offer to build one.
  if (status === 'idle') {
    return (
      <Button
        size="small"
        variant="outlined"
        startIcon={<SearchIcon />}
        onClick={build}
        disabled={!currentLocation}
      >
        {t('buildIndex')}
      </Button>
    );
  }

  // Index errored: let the user retry.
  if (status === 'error') {
    return (
      <Tooltip title={t('indexError')}>
        <span>
          <Button
            size="small"
            startIcon={<SearchIcon />}
            onClick={build}
            disabled={busy}
          >
            {t('rebuildIndex')}
          </Button>
        </span>
      </Tooltip>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        flex: '0 1 280px',
        minWidth: 0,
      }}
    >
      <Box ref={anchorRef} sx={{ flex: 1, minWidth: 0 }}>
        <TextField
          size="small"
          placeholder={contentMode ? t('searchContents') : t('search')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(false); // hide stale results while editing; reopen on Enter
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            } else if (e.key === 'Escape') {
              clear();
            }
          }}
          sx={{ width: '100%' }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  {busy || contentBusy ? (
                    <CircularProgress size={16} />
                  ) : (
                    <SearchIcon fontSize="small" />
                  )}
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  <Tooltip title={t('clear')}>
                    <IconButton
                      size="small"
                      aria-label={t('clear')}
                      onClick={clear}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ) : null,
            },
            htmlInput: {
              'aria-label': contentMode ? t('searchContents') : t('search'),
            },
          }}
        />
        <Popover
          open={open}
          anchorEl={anchorRef.current}
          onClose={() => setOpen(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: { sx: { width: 380 } } }}
        >
          {contentMode ? (
            contentResults.length === 0 ? (
              <Typography variant="body2" sx={{ p: 2 }} color="text.secondary">
                {t('fulltextNoResults')}
              </Typography>
            ) : (
              <List dense sx={{ maxHeight: 360, overflow: 'auto' }}>
                {contentResults.map((hit) => (
                  <ListItemButton
                    key={hit.path}
                    onClick={() => handlePickContent(hit)}
                  >
                    <ListItemIcon>
                      <FileTypeIcon name={hit.name} />
                    </ListItemIcon>
                    <ListItemText
                      primary={hit.name}
                      secondary={hit.snippet}
                      slotProps={{
                        primary: { noWrap: true },
                        secondary: { sx: { fontSize: 11 } },
                      }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )
          ) : results.length === 0 ? (
            <Typography variant="body2" sx={{ p: 2 }} color="text.secondary">
              {t('noResults')}
            </Typography>
          ) : (
            <List dense sx={{ maxHeight: 360, overflow: 'auto' }}>
              {results.map((entry) => (
                <ListItemButton
                  key={entry.path}
                  onClick={() => handlePick(entry)}
                >
                  <ListItemIcon>
                    {entry.isDir ? <FolderIcon /> : <FileTypeIcon name={entry.name} />}
                  </ListItemIcon>
                  <ListItemText
                    primary={<Highlighted text={entry.name} query={query} />}
                    secondary={entry.path}
                    slotProps={{
                      primary: { noWrap: true },
                      secondary: { noWrap: true, sx: { fontSize: 11 } },
                    }}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </Popover>
      </Box>
      {progressText ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {progressText}
        </Typography>
      ) : null}
      {fulltextOn ? (
        <Tooltip title={t('searchContents')}>
          <IconButton
            size="small"
            color={contentMode ? 'primary' : 'default'}
            onClick={() => {
              setContentMode((v) => !v);
              setOpen(false);
            }}
          >
            <ManageSearchIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip title={t('advancedSearch')}>
        <IconButton size="small" onClick={() => setAdvancedOpen(true)}>
          <TuneIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <AdvancedSearchDialog
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
      />
    </Box>
  );
}
