import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  IconButton,
  InputAdornment,
  Link,
  MenuItem,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import AudioFileOutlined from '@mui/icons-material/AudioFileOutlined';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import FolderOpenOutlined from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlined from '@mui/icons-material/FolderOutlined';
import GridViewRounded from '@mui/icons-material/GridViewRounded';
import ImageOutlined from '@mui/icons-material/ImageOutlined';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import LanguageRounded from '@mui/icons-material/LanguageRounded';
import ListRounded from '@mui/icons-material/ListRounded';
import LockOutlineRounded from '@mui/icons-material/LockOutlineRounded';
import MovieOutlined from '@mui/icons-material/MovieOutlined';
import PictureAsPdfOutlined from '@mui/icons-material/PictureAsPdfOutlined';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import { createLanClient, fileUrl, LanApiError, type LanClient } from './api';
import { detectLanguage, translate, type Language, type MessageKey } from './i18n';
import { createRequestScope, isAbortError, type RequestScope } from './request';
import type { LanEntry, LanListResponse, LanRoot } from '../shared/lan-types';

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

type ViewLayout = 'list' | 'grid';
type PreviewKind = 'directory' | 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'unsupported';
type VisualKind = 'directory' | 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'other';
type FolderCrumb = { id: string; name: string; path: string };

export function previewKind(entry: Pick<LanEntry, 'isDirectory' | 'extension'>): PreviewKind {
  if (entry.isDirectory) return 'directory';
  const ext = entry.extension.toLowerCase().replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['txt', 'md', 'log', 'csv', 'tsv'].includes(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  return 'unsupported';
}

function visualKind(entry: LanEntry): VisualKind {
  const kind = previewKind(entry);
  if (kind === 'unsupported') return 'other';
  return kind;
}

function formatSize(size: number, isDirectory: boolean): string {
  if (isDirectory) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string, language: Language): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
}

/**
 * Pairing failures never surface the raw `LanApiError.message` (English, and a
 * reflection surface); only a stable message key reaches the pairing card.
 */
function pairErrorKey(error: unknown): MessageKey {
  if (error instanceof LanApiError) {
    if (error.status === 401) return 'pairFailed';
    if (error.status === 429) return 'pairRateLimited';
  }
  return 'pairUnavailable';
}

function EntryVisual({ entry }: { entry: LanEntry }) {
  const [imageFailed, setImageFailed] = useState(false);
  const kind = visualKind(entry);
  useEffect(() => setImageFailed(false), [entry.rootId, entry.id]);
  if (kind === 'image' && !imageFailed) {
    return (
      <Box component="span" className="entry-visual entry-visual-image">
        <img
          src={fileUrl(entry.rootId, entry.id)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      </Box>
    );
  }
  const Icon = kind === 'directory' ? FolderOutlined
    : kind === 'image' ? ImageOutlined
      : kind === 'video' ? MovieOutlined
        : kind === 'audio' ? AudioFileOutlined
          : kind === 'pdf' ? PictureAsPdfOutlined
            : kind === 'text' ? DescriptionOutlined : InsertDriveFileOutlined;
  return (
    <Box component="span" className={`entry-visual entry-visual-${kind}`}>
      <Icon className="entry-type-icon" />
      {kind === 'other' && entry.extension && (
        <span className="entry-extension">{entry.extension.replace(/^\./, '').slice(0, 5).toUpperCase()}</span>
      )}
    </Box>
  );
}

function PreviewDialog({
  entry,
  client,
  onClose,
  onSessionExpired,
  language,
  requestTimeoutMs,
}: {
  entry: LanEntry | null;
  client: LanClient;
  onClose: () => void;
  onSessionExpired: () => void;
  language: Language;
  requestTimeoutMs?: number;
}) {
  const t = (key: MessageKey, params: Record<string, string | number> = {}) => translate(language, key, params);
  const [text, setText] = useState('');
  const [textTruncated, setTextTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const mediaProbe = useRef<RequestScope | null>(null);
  useEffect(() => () => {
    const scope = mediaProbe.current;
    mediaProbe.current = null;
    scope?.cancel();
  }, []);
  useEffect(() => {
    const pendingProbe = mediaProbe.current;
    mediaProbe.current = null;
    pendingProbe?.cancel();
    setMediaError(false);
    if (!entry) {
      setLoading(false);
      return;
    }
    setText('');
    setTextTruncated(false);
    setError(false);
    if (previewKind(entry) !== 'text') return;
    let active = true;
    const scope = createRequestScope(requestTimeoutMs);
    setLoading(true);
    void client.text(entry.rootId, entry.id, scope.signal)
      .then((value) => {
        if (!active) return;
        setText(value.text);
        setTextTruncated(value.truncated);
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (isAbortError(e) && !scope.timedOut) return;
        if (e instanceof LanApiError && e.status === 401) { onSessionExpired(); return; }
        console.warn('[mobile] text preview failed', e);
        setError(true);
      })
      .finally(() => {
        scope.dispose();
        if (active) setLoading(false);
      });
    return () => { active = false; scope.cancel(); };
  }, [client, entry, onSessionExpired, requestTimeoutMs]);
  const handleMediaError = useCallback(() => {
    setMediaError(true);
    const target = entry;
    if (!target) return;
    const pending = mediaProbe.current;
    mediaProbe.current = null;
    pending?.cancel();
    const scope = createRequestScope(requestTimeoutMs);
    mediaProbe.current = scope;
    // Media elements never expose an HTTP status, so probe the same file to
    // tell an expired session (401) apart from a corrupt/unsupported file.
    void client.probe(target.rootId, target.id, scope.signal)
      .catch((e: unknown) => {
        if (isAbortError(e) && !scope.timedOut) return;
        if (e instanceof LanApiError && e.status === 401) { onSessionExpired(); return; }
        console.warn('[mobile] media preview probe failed', e);
      })
      .finally(() => {
        scope.dispose();
        if (mediaProbe.current === scope) mediaProbe.current = null;
      });
  }, [client, entry, onSessionExpired, requestTimeoutMs]);
  const kind = entry ? previewKind(entry) : null;
  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      className="preview-dialog"
      classes={{ paper: 'preview-paper' }}
      aria-labelledby="mobile-preview-title"
    >
      {entry && (
        <>
          <Box className="preview-header">
            <Box className={`preview-file-badge preview-file-${visualKind(entry)}`}>
              <DescriptionOutlined />
            </Box>
            <Box id="mobile-preview-title" className="preview-heading">
              <Typography className="preview-kicker">{t('readOnly')}</Typography>
              <Typography component="h2" className="preview-title" noWrap title={entry.name}>{entry.name}</Typography>
            </Box>
            <IconButton aria-label={t('close')} onClick={onClose} className="preview-close">
              <CloseRounded />
            </IconButton>
          </Box>
          <DialogContent className="preview-content">
            {loading && <Box className="preview-loading" role="status"><CircularProgress size={32} /></Box>}
            {error && <Alert severity="error">{t('previewError')}</Alert>}
            {!loading && !error && mediaError && (
              <Box className="preview-media-fallback" role="status">
                <InsertDriveFileOutlined />
                <Typography>{t('previewError')}</Typography>
              </Box>
            )}
            {!loading && !error && !mediaError && kind === 'image' && (
              <img
                className="preview-media preview-image image-preview"
                src={fileUrl(entry.rootId, entry.id)}
                alt={entry.name}
                onError={handleMediaError}
              />
            )}
            {!loading && !error && !mediaError && kind === 'video' && (
              <video
                className="preview-media"
                controls
                playsInline
                src={fileUrl(entry.rootId, entry.id)}
                onError={handleMediaError}
              />
            )}
            {!loading && !error && !mediaError && kind === 'audio' && (
              <Box className="audio-preview">
                <AudioFileOutlined />
                <audio controls src={fileUrl(entry.rootId, entry.id)} onError={handleMediaError} />
              </Box>
            )}
            {!loading && !error && kind === 'text' && (
              <Box className="text-preview">
                {textTruncated && <Alert severity="info">{t('textTruncated')}</Alert>}
                <Box component="pre" className="text-preview-content">{text}</Box>
              </Box>
            )}
            {kind === 'pdf' && (
              <Box className="safe-download-message">
                <PictureAsPdfOutlined />
                <Typography>{t('pdfDownloadOnly')}</Typography>
              </Box>
            )}
            {kind === 'unsupported' && (
              <Box className="safe-download-message">
                <InsertDriveFileOutlined />
                <Typography>{t('unsupportedPreview')}</Typography>
              </Box>
            )}
          </DialogContent>
          <Box className="preview-footer">
            <Typography className="preview-meta">
              {[formatSize(entry.size, entry.isDirectory), formatDate(entry.modified, language)].filter(Boolean).join(' · ')}
            </Typography>
            <Button
              component="a"
              href={fileUrl(entry.rootId, entry.id, true)}
              variant="contained"
              startIcon={<DownloadOutlined />}
            >
              {t('download')}
            </Button>
          </Box>
        </>
      )}
    </Dialog>
  );
}

export interface AppProps {
  client?: LanClient;
  initialLanguage?: Language;
  /** Per-request timeout; production uses the 15 s default from `request.ts`. */
  requestTimeoutMs?: number;
}

export default function App({
  client: providedClient,
  initialLanguage,
  requestTimeoutMs,
}: AppProps = {}) {
  const [language, setLanguage] = useState<Language>(() => initialLanguage ?? detectLanguage());
  const t = useCallback((key: MessageKey, params: Record<string, string | number> = {}) => (
    translate(language, key, params)
  ), [language]);
  const client = useMemo<LanClient>(() => providedClient ?? createLanClient(), [providedClient]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('appTitle');
  }, [language, t]);
  const [paired, setPaired] = useState(false);
  const [sessionChecking, setSessionChecking] = useState(() => !/#token=/.test(window.location.hash));
  const [token, setToken] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<MessageKey | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [roots, setRoots] = useState<LanRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const [location, setLocation] = useState<LanListResponse | null>(null);
  const [folderTrail, setFolderTrail] = useState<FolderCrumb[]>([]);
  const [entries, setEntries] = useState<LanEntry[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagError, setTagError] = useState(false);
  const [tagRetry, setTagRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [layout, setLayout] = useState<ViewLayout>(() => (
    window.matchMedia?.('(min-width: 768px)').matches ? 'grid' : 'list'
  ));
  const [loading, setLoading] = useState(false);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [contentError, setContentError] = useState<MessageKey | null>(null);
  const [indexUnavailable, setIndexUnavailable] = useState(false);
  const [directoryTruncated, setDirectoryTruncated] = useState(false);
  const [metadataUnavailable, setMetadataUnavailable] = useState(false);
  const [preview, setPreview] = useState<LanEntry | null>(null);
  const [contentRetry, setContentRetry] = useState(0);
  const requestSequence = useRef(0);
  const skipNextRootsLoad = useRef(false);
  const rootsScope = useRef<RequestScope | null>(null);
  const pairScope = useRef<RequestScope | null>(null);

  const expireSession = useCallback(() => {
    requestSequence.current += 1;
    skipNextRootsLoad.current = false;
    setPaired(false);
    setSessionExpired(true);
    setRoots([]);
    setRootId('');
    setFolderTrail([]);
    setLocation(null);
    setEntries([]);
    setTags([]);
    setTagError(false);
    setQuery('');
    setTag('');
    setPreview(null);
    setContentError(null);
    setIndexUnavailable(false);
    setDirectoryTruncated(false);
    setMetadataUnavailable(false);
    setLoading(false);
    setRootsLoading(false);
  }, []);

  const loadRoots = useCallback(async () => {
    const previous = rootsScope.current;
    rootsScope.current = null;
    previous?.cancel();
    const scope = createRequestScope(requestTimeoutMs);
    rootsScope.current = scope;
    setRootsLoading(true);
    setContentError(null);
    try {
      const response = await client.roots(scope.signal);
      if (rootsScope.current !== scope) return;
      setRoots(response.roots);
      setRootId((current) => current || response.roots[0]?.id || '');
    } catch (e) {
      if (rootsScope.current !== scope) return;
      if (isAbortError(e) && !scope.timedOut) return;
      if (e instanceof LanApiError && e.status === 401) { expireSession(); return; }
      console.warn('[mobile] roots request failed', e);
      setContentError('loadFailed');
    } finally {
      scope.dispose();
      if (rootsScope.current === scope) {
        rootsScope.current = null;
        setRootsLoading(false);
      }
    }
    }, [client, expireSession, requestTimeoutMs]);

  const pair = useCallback(async (value: string) => {
    if (!value || pairing) return;
    setPairing(true);
    setPairError(null);
    setSessionExpired(false);
    const previous = pairScope.current;
    pairScope.current = null;
    previous?.cancel();
    const scope = createRequestScope(requestTimeoutMs);
    pairScope.current = scope;
    try {
      await client.pair(value, scope.signal);
      if (pairScope.current !== scope) return;
      // pair() loads roots explicitly below; the paired effect must not issue
      // a duplicate request when setPaired(true) renders first.
      skipNextRootsLoad.current = true;
      setPaired(true);
      setToken('');
      setTag('');
      setTags([]);
      setTagError(false);
      setIndexUnavailable(false);
      setPreview(null);
      setContentRetry(0);
      setFolderTrail([]);
      setLocation(null);
      setEntries([]);
      setContentError(null);
      await loadRoots();
    } catch (e) {
      if (pairScope.current !== scope) return;
      if (isAbortError(e) && !scope.timedOut) return;
      console.warn('[mobile] pairing failed', e);
      setPairError(pairErrorKey(e));
    } finally {
      scope.dispose();
      if (pairScope.current === scope) {
        pairScope.current = null;
        setPairing(false);
      }
    }
  }, [client, loadRoots, pairing, requestTimeoutMs]);

  useEffect(() => () => {
    const pendingRoots = rootsScope.current;
    rootsScope.current = null;
    pendingRoots?.cancel();
    const pendingPair = pairScope.current;
    pairScope.current = null;
    pendingPair?.cancel();
  }, []);

  useEffect(() => {
    const match = window.location.hash.match(/#token=([^&]+)/);
    if (!match) return;
    let value = '';
    try { value = decodeURIComponent(match[1]); } catch { value = match[1]; }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    void pair(value);
  }, [pair]);

  useEffect(() => {
    // A #token auto-pair already owns session establishment. Probing roots in
    // parallel would issue an avoidable unauthenticated request before pair().
    if (paired || !sessionChecking) return;
    let active = true;
    const scope = createRequestScope(requestTimeoutMs);
    void client.roots(scope.signal)
      .then((response) => {
        if (!active) return;
        setRoots(response.roots);
        setRootId(response.roots[0]?.id || '');
        skipNextRootsLoad.current = true;
        setPaired(true);
        setTag('');
        setTags([]);
        setTagError(false);
        setIndexUnavailable(false);
        setPreview(null);
        setContentRetry(0);
        setLocation(null);
        setEntries([]);
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (isAbortError(e) && !scope.timedOut) return;
        // 401 is the expected "no cookie yet" path and keeps the pairing form.
        if (e instanceof LanApiError && e.status === 401) return;
        console.warn('[mobile] session probe failed', e);
      })
      .finally(() => {
        scope.dispose();
        if (active) setSessionChecking(false);
      });
    return () => { active = false; scope.cancel(); };
  }, [client, paired, requestTimeoutMs, sessionChecking]);

  useEffect(() => {
    if (!paired) return;
    if (skipNextRootsLoad.current) {
      skipNextRootsLoad.current = false;
      return;
    }
    void loadRoots();
  }, [loadRoots, paired]);

  useEffect(() => {
    if (!paired || !rootId) return;
    let active = true;
    const scope = createRequestScope(requestTimeoutMs);
    setTagError(false);
    void client.tags(rootId, scope.signal)
      .then((response) => {
        if (!active) return;
        setTags(response.tags);
        setIndexUnavailable(response.indexUnavailable);
        setTagError(false);
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (isAbortError(e) && !scope.timedOut) return;
        if (e instanceof LanApiError && e.status === 401) { expireSession(); return; }
        // Keep the chips we already have: an empty strip would read as
        // "this location has no tags", which is a false conclusion.
        console.warn('[mobile] tags request failed', e);
        setTagError(true);
      })
      .finally(() => { scope.dispose(); });
    return () => { active = false; scope.cancel(); };
  }, [client, expireSession, paired, requestTimeoutMs, rootId, tagRetry]);

  const filtering = query.trim().length > 0 || tag.length > 0;
  // An index-less search returns zero entries by contract; showing "no results"
  // next to the index warning would state a false conclusion.
  const indexFallbackActive = filtering && indexUnavailable && entries.length === 0;
  useEffect(() => {
    if (!paired || !rootId) return;
    let active = true;
    const scope = createRequestScope(requestTimeoutMs);
    const sequence = ++requestSequence.current;
    setLoading(true);
    setContentError(null);
    setDirectoryTruncated(false);
    setMetadataUnavailable(false);
    const timer = window.setTimeout(() => {
      const request = filtering
        ? client.search(rootId, query.trim(), tag, scope.signal)
        : client.list(rootId, location?.id || undefined, scope.signal);
      void request
        .then((response) => {
          if (!active || sequence !== requestSequence.current) return;
          setEntries(response.entries);
          if ('indexUnavailable' in response) {
            setIndexUnavailable(response.indexUnavailable);
            setDirectoryTruncated(false);
            setMetadataUnavailable(false);
          } else {
            setDirectoryTruncated(response.truncated === true);
            setMetadataUnavailable('metadataUnavailable' in response && response.metadataUnavailable === true);
          }
        })
        .catch((e: unknown) => {
          if (!active || sequence !== requestSequence.current) return;
          if (isAbortError(e) && !scope.timedOut) return;
          if (e instanceof LanApiError && e.status === 401) {
            expireSession();
            return;
          }
          console.warn('[mobile] content request failed', e);
          setContentError('loadFailed');
        })
        .finally(() => {
          scope.dispose();
          if (active && sequence === requestSequence.current) setLoading(false);
        });
    }, filtering ? 300 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      scope.cancel();
    };
  }, [client, contentRetry, expireSession, filtering, location?.id, paired, query, requestTimeoutMs, rootId, tag]);

  const clearFilters = () => { setQuery(''); setTag(''); };
  const changeQuery = (value: string) => {
    if (value.trim() && !filtering) {
      if (location?.rootId) setRootId(location.rootId);
      setFolderTrail([]);
      setLocation(null);
    }
    setQuery(value);
  };
  const toggleTag = (value: string) => {
    const next = tag === value ? '' : value;
    if (next && !filtering) {
      if (location?.rootId) setRootId(location.rootId);
      setFolderTrail([]);
      setLocation(null);
    }
    setTag(next);
  };
  const openFolder = (entry: LanEntry) => {
    const baseTrail = filtering ? [] : folderTrail;
    const parentId = baseTrail[baseTrail.length - 1]?.id ?? null;
    setRootId(entry.rootId);
    setFolderTrail([...baseTrail, { id: entry.id, name: entry.name, path: entry.path }]);
    setLocation({ rootId: entry.rootId, id: entry.id, name: entry.name, path: entry.path, parentId, entries: [] });
    clearFilters();
    setPreview(null);
  };
  const navigateRoot = () => {
    setFolderTrail([]);
    setLocation(null);
    clearFilters();
  };
  const navigateTrail = (trail: FolderCrumb[]) => {
    const current = trail[trail.length - 1];
    setFolderTrail(trail);
    setLocation(current ? {
      rootId: location?.rootId || rootId,
      id: current.id,
      name: current.name,
      path: current.path,
      parentId: trail[trail.length - 2]?.id ?? null,
      entries: [],
    } : null);
    clearFilters();
  };
  const goBack = () => navigateTrail(folderTrail.slice(0, -1));
  const navigateBreadcrumb = (index: number) => navigateTrail(folderTrail.slice(0, index + 1));
  const selectRoot = (id: string) => {
    setRootId(id);
    setFolderTrail([]);
    setLocation(null);
    clearFilters();
    setTags([]);
    setIndexUnavailable(false);
  };
  const breadcrumbs = folderTrail;
  const refresh = useCallback(() => {
    if (!paired) return;
    // Refresh used to be a dead button while no location was selected; reload
    // the location list so a location shared moments ago can show up.
    if (roots.length === 0 || !rootId) {
      void loadRoots();
      return;
    }
    setTagRetry((value) => value + 1);
    setContentRetry((value) => value + 1);
  }, [loadRoots, paired, rootId, roots.length]);

  const pairingCard = (
    <Box className="pairing-layout">
      <Box className="pairing-card">
        <Box className="pairing-symbol"><FolderOpenOutlined /></Box>
        <Chip icon={<LockOutlineRounded />} label={t('readOnly')} size="small" className="pairing-badge" />
        <Typography component="h1" className="pairing-title">{t('pairTitle')}</Typography>
        <Typography className="pairing-subtitle">{t('pairDescription')}</Typography>
        <Box className="pairing-form">
          <TextField
            label={t('tokenLabel')}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            fullWidth
            variant="filled"
            slotProps={{ input: { disableUnderline: true } }}
            onKeyDown={(e) => { if (e.key === 'Enter') void pair(token.trim()); }}
          />
          {sessionExpired && <Alert severity="warning">{t('sessionExpired')}</Alert>}
          {pairError && <Alert severity="error">{t(pairError)}</Alert>}
          <Button variant="contained" size="large" fullWidth disabled={!token.trim() || pairing} onClick={() => void pair(token.trim())}>
            {pairing ? t('connecting') : t('connect')}
          </Button>
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box className="mobile-app">
      <Box component="header" className="mobile-header">
        <Box className="mobile-header-inner">
          <Box className="brand-lockup" role="group" aria-label="WhaleTag LAN">
            <Box className="brand-mark"><FolderOpenOutlined /></Box>
            <Typography className="brand-name">WhaleTag</Typography>
            <span className="brand-lan">LAN</span>
          </Box>
          <Box className="header-actions">
            <Chip icon={<LockOutlineRounded />} label={t('readOnly')} size="small" className="readonly-chip" />
            <Select
              className="language-select"
              variant="standard"
              disableUnderline
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              inputProps={{ 'aria-label': t('language') }}
              startAdornment={<LanguageRounded className="language-icon" />}
            >
              {LANGUAGES.map((item) => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
            </Select>
          </Box>
        </Box>
      </Box>

      <Box component="main" className="mobile-main">
        {sessionChecking ? (
          <Box className="session-loading" role="status" aria-label={t('loading')}><CircularProgress size={32} /></Box>
        ) : !paired ? pairingCard : (
          <Box className="browser-shell">
            <Box component="section" className="navigation-surface" aria-label={t('roots')}>
              <Box className="location-row">
                {folderTrail.length > 0 && (
                  <IconButton
                    className="back-button"
                    aria-label={t('back')}
                    onClick={goBack}
                  >
                    <ArrowBackRounded />
                  </IconButton>
                )}
                <TextField
                  select
                  variant="filled"
                  value={rootId}
                  onChange={(e) => selectRoot(e.target.value)}
                  className="location-select"
                  fullWidth
                  slotProps={{
                    input: {
                      'aria-label': t('selectRoot'),
                      disableUnderline: true,
                      startAdornment: <InputAdornment position="start"><FolderOpenOutlined /></InputAdornment>,
                    },
                  }}
                >
                  {roots.map((root) => <MenuItem key={root.id} value={root.id}>{root.name}</MenuItem>)}
                </TextField>
              </Box>
              {breadcrumbs.length > 0 && (
                <Breadcrumbs className="location-breadcrumbs" separator={<ChevronRightRounded />} maxItems={4} aria-label={t('breadcrumb')}>
                  <Link component="button" onClick={navigateRoot} underline="hover">
                    {roots.find((root) => root.id === (location?.rootId || rootId))?.name || t('selectRoot')}
                  </Link>
                  {breadcrumbs.map((item, index) => index === breadcrumbs.length - 1 ? (
                    <Typography key={item.id} className="current-breadcrumb" noWrap>{item.name}</Typography>
                  ) : (
                    <Link component="button" key={item.id} onClick={() => navigateBreadcrumb(index)} underline="hover">
                      {item.name}
                    </Link>
                  ))}
                </Breadcrumbs>
              )}
            </Box>

            <Box component="section" className="browser-surface">
              <Box className="browser-controls">
                <TextField
                  type="search"
                  placeholder={t('searchPlaceholder')}
                  variant="filled"
                  value={query}
                  onChange={(e) => changeQuery(e.target.value)}
                  fullWidth
                  className="mobile-search"
                  slotProps={{
                    input: {
                      'aria-label': t('searchLabel'),
                      disableUnderline: true,
                      startAdornment: <InputAdornment position="start"><SearchRounded /></InputAdornment>,
                    },
                  }}
                />
                {tags.length > 0 && (
                  <Box className="tag-strip tag-filter" role="group" aria-label={t('tags')}>
                    {tags.map((item) => (
                      <Chip
                        key={item}
                        label={item}
                        clickable
                        size="small"
                        color={tag === item ? 'primary' : 'default'}
                        variant={tag === item ? 'filled' : 'outlined'}
                        aria-pressed={tag === item}
                        onClick={() => toggleTag(item)}
                      />
                    ))}
                  </Box>
                )}
                {tagError && (
                  <Alert
                    severity="warning"
                    className="tag-error"
                    action={<Button color="inherit" size="small" onClick={() => setTagRetry((value) => value + 1)}>{t('retry')}</Button>}
                  >
                    {t('tagsUnavailable')}
                  </Alert>
                )}
                <Box className="content-toolbar">
                  <Typography className="result-count" aria-live="polite">{t(entries.length === 1 ? 'item' : 'items', { count: entries.length })}</Typography>
                  {filtering && (
                    <IconButton
                      className="clear-filter-control"
                      size="small"
                      aria-label={t('clearFilter')}
                      onClick={clearFilters}
                    >
                      <CloseRounded />
                    </IconButton>
                  )}
                  <ToggleButtonGroup
                    value={layout}
                    exclusive
                    size="small"
                    onChange={(_event, value: ViewLayout | null) => { if (value) setLayout(value); }}
                    className="view-toggle"
                  >
                    <ToggleButton value="list" aria-label={t('listView')}><ListRounded /><span>{t('listView')}</span></ToggleButton>
                    <ToggleButton value="grid" aria-label={t('gridView')}><GridViewRounded /><span>{t('gridView')}</span></ToggleButton>
                  </ToggleButtonGroup>
                </Box>
              </Box>

              <Box className="results-area" aria-busy={loading || rootsLoading}>
                {indexUnavailable && <Alert severity="warning">{t('indexUnavailable')}</Alert>}
                {directoryTruncated && <Alert severity="warning">{t('directoryTruncated')}</Alert>}
                {metadataUnavailable && <Alert severity="warning">{t('metadataUnavailable')}</Alert>}
                {contentError && (
                  <Alert severity="error" action={<Button color="inherit" size="small" onClick={refresh}>{t('retry')}</Button>}>
                    {t(contentError)}
                  </Alert>
                )}
                {loading || rootsLoading ? (
                  <Box className="content-loading" role="status">
                    <CircularProgress size={30} />
                    <Typography>{t('loading')}</Typography>
                  </Box>
                ) : !contentError && roots.length === 0 ? (
                  <Box className="empty-state" role="status">
                    <FolderOpenOutlined />
                    <Typography>{t('noRoots')}</Typography>
                  </Box>
                ) : !contentError && entries.length === 0 && !indexFallbackActive ? (
                  <Box className="empty-state" role="status">
                    {filtering ? <SearchRounded /> : <FolderOpenOutlined />}
                    <Typography>{filtering ? t('noResults') : t('emptyFolder')}</Typography>
                  </Box>
                ) : !contentError && !indexFallbackActive && (
                  <Box className={`entry-grid ${layout}`}>
                    {entries.map((entry) => (
                      <Box
                        component="button"
                        type="button"
                        key={entry.id}
                        className="entry-item entry-button"
                        aria-label={`${t('open')}: ${entry.name}`}
                        onClick={() => entry.isDirectory ? openFolder(entry) : setPreview(entry)}
                      >
                        <EntryVisual entry={entry} />
                        <Box component="span" className="entry-copy">
                          <Typography component="span" className="entry-name" noWrap title={entry.name}>{entry.name}</Typography>
                          <Typography component="span" className="entry-meta" noWrap>
                            {[formatSize(entry.size, entry.isDirectory), formatDate(entry.modified, language)].filter(Boolean).join(' · ')}
                          </Typography>
                        </Box>
                        <ChevronRightRounded className="entry-chevron" />
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            </Box>
            <Button variant="text" className="refresh-button" startIcon={<RefreshRounded />} onClick={refresh}>
              {t('refresh')}
            </Button>
          </Box>
        )}
      </Box>
      <PreviewDialog
        entry={preview}
        client={client}
        language={language}
        requestTimeoutMs={requestTimeoutMs}
        onClose={() => setPreview(null)}
        onSessionExpired={expireSession}
      />
    </Box>
  );
}
