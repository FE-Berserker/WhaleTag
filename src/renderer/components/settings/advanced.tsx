import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import { RootState } from '-/reducers';
import {
  addFulltextPath,
  removeFulltextPath,
  normalizeFsPath,
} from '-/reducers/settings';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { ipcApi } from '-/services/ipc-api';
import { errorMessage } from '-/services/errors';
import ExtensionsSection from '../ExtensionsSection';
import { SettingsGroup } from './primitives';

type BuildState = 'unbuilt' | 'building' | 'ready' | 'error';
interface FtStatus {
  state: BuildState;
  count?: number;
  /** Live extraction progress during 'building' (docs/04 §10). */
  processed?: number;
  error?: string;
}

const EMPTY_FULLTEXT_PATHS: string[] = [];

/**
 * Full-text settings: the list of directories with content search enabled.
 * Each path is an independent index root (may be a location root or any
 * subdirectory). Adding or rebuilding triggers a main-process build; build
 * status is kept locally (redux only stores the path list).
 */
export function FulltextSettings() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const paths = useSelector(
    (s: RootState) => s.settings?.fulltextPaths ?? EMPTY_FULLTEXT_PATHS
  );
  const { currentLocation } = useCurrentLocationContext();

  const [input, setInput] = useState('');
  // Rejected "add fulltext path" attempts are explained inline instead of
  // silently persisting a row that can only ever show an error state.
  const [pathError, setPathError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, FtStatus>>({});

  const build = useCallback(async (p: string) => {
    const key = normalizeFsPath(p);
    setStatus((prev) => ({ ...prev, [key]: { state: 'building' } }));
    try {
      const { count } = await ipcApi.buildFulltextIndex(p);
      setStatus((prev) => ({ ...prev, [key]: { state: 'ready', count } }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[FulltextSettings] build failed:', p, message, e);
      setStatus((prev) => ({
        ...prev,
        [key]: { state: 'error', count: undefined, error: message },
      }));
    }
  }, []);

  // Reset status when the path list changes (e.g. add/remove) so we don't
  // show stale counts from a previous session.
  useEffect(() => {
    setStatus({});
  }, [paths]);

  // docs/04 §10: live extraction progress for in-flight fulltext builds.
  useEffect(() => {
    return ipcApi.onIndexProgress((ev) => {
      if (ev.op !== 'fulltext:build') return;
      const key = normalizeFsPath(ev.rootPath);
      setStatus((prev) => {
        const cur = prev[key];
        if (!cur || cur.state !== 'building') return prev;
        if (ev.done) return { ...prev, [key]: { ...cur, processed: undefined } };
        return { ...prev, [key]: { ...cur, processed: ev.processed } };
      });
    });
  }, []);

  // Probe existing indexes for paths we don't yet have a status for.
  useEffect(() => {
    for (const p of paths) {
      const key = normalizeFsPath(p);
      if (status[key]) continue;
      void ipcApi
        .hasFulltextIndex(p)
        .then((has) => {
          setStatus((prev) =>
            prev[key]
              ? prev
              : { ...prev, [key]: { state: has ? 'ready' : 'unbuilt' } }
          );
        })
        .catch((e) => {
          // Probe failure is not "no index": show it as an error row so the
          // user doesn't rebuild (or trust) a state we never determined.
          setStatus((prev) =>
            prev[key]
              ? prev
              : {
                  ...prev,
                  [key]: { state: 'error', error: errorMessage(e) },
                }
          );
        });
    }
  }, [paths, status]);

  const handleAdd = () => {
    const v = input.trim();
    if (!v) return;
    // Persisted setting: validate before dispatch. `addFulltextPath` writes to
    // redux-persist, so a typo ("D:/doc" vs "D:\doc" is fine, but "doc" or a
    // URL is not) would otherwise stick around forever and always fail at
    // build time with a path error.
    const absolute =
      /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\') || v.startsWith('/');
    if (!absolute) {
      setPathError(t('fulltextPathInvalid'));
      return;
    }
    const key = normalizeFsPath(v);
    if (paths.some((p) => normalizeFsPath(p) === key)) {
      setPathError(t('fulltextPathDuplicate'));
      return;
    }
    setPathError(null);
    dispatch(addFulltextPath(v));
    setInput('');
    void build(v);
  };

  const statusLabel = (st: FtStatus | undefined): string => {
    if (!st) return '';
    if (st.state === 'building')
      return st.processed !== undefined
        ? `${t('fulltextBuilding')} ${st.processed}`
        : t('fulltextBuilding');
    if (st.state === 'error')
      return `${t('errorOccurred')}${st.error ? `: ${st.error}` : ''}`;
    if (st.state === 'ready')
      return st.count !== undefined
        ? t('entriesIndexed', { count: st.count })
        : t('fulltextReady');
    return t('fulltextNotBuilt');
  };

  return (
    <SettingsGroup
      title={t('fulltextSearch')}
      description={t('fulltextHint')}
    >
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Stack direction="row" sx={{ gap: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t('fulltextPathPlaceholder')}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (pathError) setPathError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
          />
          <Tooltip title={t('add')}>
            <span>
              <IconButton
                size="small"
                color="primary"
                aria-label={t('add')}
                onClick={handleAdd}
                disabled={!input.trim()}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        {pathError ? (
          <Typography variant="caption" color="error">
            {pathError}
          </Typography>
        ) : null}

        {currentLocation ? (
          <Button
            size="small"
            sx={{ alignSelf: 'flex-start' }}
            onClick={() => setInput(currentLocation.path)}
          >
            {t('useCurrentLocation')}
          </Button>
        ) : null}

        {paths.length > 0 ? (
          <Stack sx={{ gap: 1 }}>
            {paths.map((p) => {
              const st = status[normalizeFsPath(p)];
              const busy = st?.state === 'building';
              return (
                <Stack
                  key={p}
                  direction="row"
                  sx={{ alignItems: 'center', gap: 0.5 }}
                >
                  <Stack sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" noWrap title={p}>
                      {p}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {statusLabel(st)}
                    </Typography>
                  </Stack>
                  <Tooltip title={t('rebuildIndex')}>
                    <span>
                      <IconButton
                        size="small"
                        data-testid="rebuild-fulltext-button"
                        data-path={p}
                        onClick={() => void build(p)}
                        disabled={busy}
                      >
                        <RefreshIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={t('remove')}>
                    <IconButton
                      size="small"
                      onClick={() => dispatch(removeFulltextPath(p))}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              );
            })}
          </Stack>
        ) : null}

        <Typography variant="caption" color="text.secondary">
          {t('fulltextNote')}
        </Typography>
      </Box>
    </SettingsGroup>
  );
}

export function AdvancedSection() {
  return (
    <Stack sx={{ gap: 2 }}>
      <ExtensionsSection />
      <FulltextSettings />
    </Stack>
  );
}
