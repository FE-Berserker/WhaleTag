import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';

import FileTypeIcon from './FileTypeIcon';
import type { IndexEntry } from '../../shared/ipc-types';
import { RootState } from '-/reducers';
import { EMPTY_ARR, EMPTY_OBJ } from '-/constants';
import { addSavedSearch, removeSavedSearch } from '-/reducers/savedsearches';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { ipcApi } from '-/services/ipc-api';
import { errorMessage } from '-/services/errors';
import { joinPath } from '-/services/path-util';
import {
  isQueryEmpty,
  parseExtensions,
  type SearchQuery,
  type TagMatch,
  type TypeFilter,
} from '-/services/search-filter';
import PromptDialog from '-/components/PromptDialog';

interface AdvancedSearchDialogProps {
  open: boolean;
  onClose: () => void;
}

const MB = 1024 * 1024;

/**
 * Rows the result list renders at most. A query over a large library can match
 * tens of thousands of entries; rendering them all froze the dialog. The count
 * line stays truthful and the truncation note says how many rows were hidden.
 */
const MAX_RENDERED_RESULTS = 300;

/** Parses a number field; blank or invalid → null. */
function numOrNull(raw: string): number | null {
  const n = parseFloat(raw);
  return raw.trim() === '' || Number.isNaN(n) ? null : n;
}

/** Formats epoch-ms as a local `YYYY-MM-DD` for a date input (blank if null). */
function msToDateInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Advanced search over the active location's SQLite index. Assembles a
 * structured {@link SearchQuery} from the form and runs it as SQL in main
 * (index-db.ts advancedQuery). Clicking a result navigates to it.
 */
export default function AdvancedSearchDialog({
  open,
  onClose,
}: AdvancedSearchDialogProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { currentLocation, navigateTo } = useCurrentLocationContext();
  const savedSearches = useSelector(
    (s: RootState) => s.savedsearches?.items ?? EMPTY_ARR
  );
  const tagColors = useSelector(
    (s: RootState) => s.settings?.tagColors ?? EMPTY_OBJ
  );
  const tagGroups = useSelector(
    (s: RootState) => s.taglibrary?.groups ?? EMPTY_ARR
  );

  // Tag suggestions: the index's distinct tags (async, from main) merged with
  // tag-group tags and any colored tag, so the picker is useful even before the
  // index is built.
  const [indexTags, setIndexTags] = useState<string[]>([]);
  useEffect(() => {
    if (!currentLocation) {
      setIndexTags([]);
      return;
    }
    let cancelled = false;
    ipcApi
      .indexTags(currentLocation.path)
      .then((tags) => {
        if (!cancelled) setIndexTags(tags);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation?.id]);

  const allTags = useMemo(() => {
    const set = new Set<string>(indexTags);
    for (const g of tagGroups) for (const tg of g.tags) set.add(tg);
    for (const tag of Object.keys(tagColors)) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [indexTags, tagGroups, tagColors]);

  // Form state (assembled into a SearchQuery on submit).
  const [text, setText] = useState('');
  const [type, setType] = useState<TypeFilter>('any');
  const [tags, setTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatch>('all');
  const [excludeTags, setExcludeTags] = useState<string[]>([]);
  const [extRaw, setExtRaw] = useState('');
  const [sizeMin, setSizeMin] = useState('');
  const [sizeMax, setSizeMax] = useState('');
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');

  const [results, setResults] = useState<IndexEntry[] | null>(null);
  // A failed query used to leave the previous query's rows in place, which
  // reads as "this query matched these files". Errors now replace the rows.
  const [searchError, setSearchError] = useState<string | null>(null);
  // `busy` drives the progress bar / aria-busy, so a query over a big library
  // no longer looks like a dead button.
  const [busy, setBusy] = useState(false);
  // Only the newest query may write results. Without this, a slow first query
  // could resolve after a fast second one and overwrite the newer rows.
  const querySeq = useRef(0);
  const [savePromptOpen, setSavePromptOpen] = useState(false);

  const buildQuery = (): SearchQuery => {
    // Extension / size constraints only make sense for files. When searching
    // folders, ignore them (the fields are also disabled in the UI).
    const fileOnly = type !== 'folders';
    const min = numOrNull(sizeMin);
    const max = numOrNull(sizeMax);
    const afterMs = after ? new Date(`${after}T00:00:00`).getTime() : NaN;
    const beforeMs = before ? new Date(`${before}T23:59:59.999`).getTime() : NaN;
    return {
      text,
      tags,
      tagMatch,
      excludeTags,
      type,
      extensions: fileOnly ? parseExtensions(extRaw) : [],
      sizeMinBytes: fileOnly && min !== null ? Math.round(min * MB) : null,
      sizeMaxBytes: fileOnly && max !== null ? Math.round(max * MB) : null,
      modifiedAfter: Number.isNaN(afterMs) ? null : afterMs,
      modifiedBefore: Number.isNaN(beforeMs) ? null : beforeMs,
    };
  };

  /** Runs a query against the index (SQL in main) and shows the results. */
  const runQuery = async (q: SearchQuery) => {
    if (!currentLocation) {
      setResults([]);
      setSearchError(null);
      return;
    }
    const seq = (querySeq.current += 1);
    setBusy(true);
    setSearchError(null);
    try {
      const rows = await ipcApi.advancedIndex(currentLocation.path, q);
      if (seq === querySeq.current) setResults(rows);
    } catch (e) {
      if (seq !== querySeq.current) {
        // A newer query owns the dialog now; surfacing this failure would
        // blame the wrong query. Keep the evidence in the log instead of
        // dropping it silently.
        console.warn('[advanced-search] superseded query failed', e);
        return;
      }
      // Do not keep stale rows: they would be presented as this query's
      // result while the failure stayed invisible.
      setResults(null);
      setSearchError(t('searchFailed', { message: errorMessage(e) }));
    } finally {
      if (seq === querySeq.current) setBusy(false);
    }
  };

  /** Loads a saved query into the form fields and runs it immediately. */
  const applyQuery = (q: SearchQuery) => {
    setText(q.text);
    setType(q.type);
    setTags(q.tags);
    setTagMatch(q.tagMatch);
    setExcludeTags(q.excludeTags);
    setExtRaw(q.extensions.join(', '));
    setSizeMin(q.sizeMinBytes !== null ? String(q.sizeMinBytes / MB) : '');
    setSizeMax(q.sizeMaxBytes !== null ? String(q.sizeMaxBytes / MB) : '');
    setAfter(msToDateInput(q.modifiedAfter));
    setBefore(msToDateInput(q.modifiedBefore));
    void runQuery(q);
  };

  const handleSaveConfirm = (name: string) => {
    setSavePromptOpen(false);
    dispatch(addSavedSearch(name, buildQuery()));
  };

  const handleSearch = () => {
    void runQuery(buildQuery());
  };

  const handleReset = () => {
    setText('');
    setType('any');
    setTags([]);
    setTagMatch('all');
    setExcludeTags([]);
    setExtRaw('');
    setSizeMin('');
    setSizeMax('');
    setAfter('');
    setBefore('');
    setResults(null);
  };

  const handlePick = async (entry: IndexEntry) => {
    if (!currentLocation) return;
    const abs = joinPath(currentLocation.path, entry.path);
    const dir = entry.isDir ? abs : await ipcApi.parentDir(abs);
    navigateTo(dir);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ position: 'relative' }}>
        {t('advancedSearch')}
        {/* Indeterminate progress on the title's bottom edge: a search over a
            large index takes a moment and used to look like a dead button. */}
        {busy ? (
          <LinearProgress
            aria-label={t('searching')}
            sx={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
          />
        ) : null}
      </DialogTitle>
      <DialogContent dividers>
        <Stack sx={{ gap: 2, pt: 0.5 }}>
          {savedSearches.length > 0 ? (
            <Box>
              <Typography variant="caption" color="text.secondary">
                {t('savedSearches')}
              </Typography>
              <Stack
                direction="row"
                sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}
              >
                {savedSearches.map((s) => (
                  <Chip
                    key={s.id}
                    label={s.name}
                    size="small"
                    variant="outlined"
                    onClick={() => applyQuery(s.query)}
                    onDelete={() => dispatch(removeSavedSearch(s.id))}
                  />
                ))}
              </Stack>
            </Box>
          ) : null}

          <TextField
            size="small"
            label={t('filenameContains')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            fullWidth
          />

          <Box>
            <Typography variant="caption" color="text.secondary">
              {t('fileType')}
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={type}
              onChange={(_, v: TypeFilter | null) => v && setType(v)}
              sx={{ display: 'flex', mt: 0.5 }}
            >
              <ToggleButton value="any" sx={{ flex: 1 }}>
                {t('typeAny')}
              </ToggleButton>
              <ToggleButton value="files" sx={{ flex: 1 }}>
                {t('typeFiles')}
              </ToggleButton>
              <ToggleButton value="folders" sx={{ flex: 1 }}>
                {t('typeFolders')}
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Stack direction="row" sx={{ gap: 1, alignItems: 'flex-start' }}>
            <Autocomplete
              multiple
              freeSolo
              size="small"
              options={allTags}
              value={tags}
              onChange={(_, v) => setTags(v)}
              sx={{ flex: 1 }}
              renderInput={(params) => (
                <TextField {...params} label={t('includeTags')} />
              )}
            />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={tagMatch}
              onChange={(_, v: TagMatch | null) => v && setTagMatch(v)}
              sx={{ mt: 0.25 }}
            >
              <ToggleButton value="all">{t('matchAll')}</ToggleButton>
              <ToggleButton value="any">{t('matchAny')}</ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          <Autocomplete
            multiple
            freeSolo
            size="small"
            options={allTags}
            value={excludeTags}
            onChange={(_, v) => setExcludeTags(v)}
            renderInput={(params) => (
              <TextField {...params} label={t('excludeTags')} />
            )}
          />

          <TextField
            size="small"
            label={t('extensions')}
            placeholder={t('extensionsPlaceholder')}
            value={extRaw}
            onChange={(e) => setExtRaw(e.target.value)}
            fullWidth
            disabled={type === 'folders'}
            helperText={type === 'folders' ? t('filesOnlyFilter') : undefined}
          />

          <Stack direction="row" sx={{ gap: 1 }}>
            <TextField
              size="small"
              type="number"
              label={t('minSizeMb')}
              value={sizeMin}
              onChange={(e) => setSizeMin(e.target.value)}
              fullWidth
              disabled={type === 'folders'}
            />
            <TextField
              size="small"
              type="number"
              label={t('maxSizeMb')}
              value={sizeMax}
              onChange={(e) => setSizeMax(e.target.value)}
              fullWidth
              disabled={type === 'folders'}
            />
          </Stack>

          <Stack direction="row" sx={{ gap: 1 }}>
            <TextField
              size="small"
              type="date"
              label={t('modifiedAfter')}
              value={after}
              onChange={(e) => setAfter(e.target.value)}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              size="small"
              type="date"
              label={t('modifiedBefore')}
              value={before}
              onChange={(e) => setBefore(e.target.value)}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Stack>

          {searchError ? (
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void runQuery(buildQuery())}
                >
                  {t('retry')}
                </Button>
              }
            >
              {searchError}
            </Alert>
          ) : null}

          {results !== null ? (
            <Box aria-busy={busy}>
              <Divider sx={{ mb: 1 }} />
              <Typography variant="caption" color="text.secondary">
                {t('resultsCount', { count: results.length })}
              </Typography>
              {results.length > 0 ? (
                <List dense sx={{ maxHeight: 240, overflow: 'auto' }}>
                  {results.slice(0, MAX_RENDERED_RESULTS).map((entry) => (
                    <ListItemButton
                      key={entry.path}
                      onClick={() => handlePick(entry)}
                    >
                      <ListItemIcon sx={{ minWidth: 36 }}>
                        {entry.isDir ? (
                          <FolderIcon fontSize="small" />
                        ) : (
                          <FileTypeIcon name={entry.name} size={20} />
                        )}
                      </ListItemIcon>
                      <ListItemText
                        primary={entry.name}
                        secondary={entry.path}
                        slotProps={{
                          primary: { noWrap: true },
                          secondary: { noWrap: true, sx: { fontSize: 11 } },
                        }}
                      />
                    </ListItemButton>
                  ))}
                </List>
              ) : null}
              {results.length > MAX_RENDERED_RESULTS ? (
                <Typography
                  variant="caption"
                  color="warning.main"
                  sx={{ display: 'block', mt: 0.5 }}
                >
                  {t('resultsTruncated', {
                    shown: MAX_RENDERED_RESULTS,
                    total: results.length,
                  })}
                </Typography>
              ) : null}
            </Box>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleReset} color="inherit">
          {t('reset')}
        </Button>
        <Button
          onClick={() => setSavePromptOpen(true)}
          color="inherit"
          disabled={isQueryEmpty(buildQuery())}
        >
          {t('saveSearch')}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} color="inherit">
          {t('close')}
        </Button>
        <Button onClick={handleSearch} variant="contained" disabled={busy}>
          {busy ? t('searching') : t('search')}
        </Button>
      </DialogActions>

      <PromptDialog
        open={savePromptOpen}
        title={t('saveSearch')}
        label={t('searchName')}
        onConfirm={handleSaveConfirm}
        onClose={() => setSavePromptOpen(false)}
      />
    </Dialog>
  );
}
