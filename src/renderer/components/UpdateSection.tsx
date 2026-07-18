import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  Link,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

import { RootState } from '-/reducers';
import { setAutoUpdateCheck } from '-/reducers/settings';
import { ipcApi } from '-/services/ipc-api';
import LogoIcon from '-/assets/LogoIcon';
import type {
  AppUpdateCheckResult,
  AppUpdateDownloadResult,
  AppUpdateInfo,
  AppUpdateProgressPayload,
} from '../../shared/ipc-types';

// Project links shown in the About block. External http(s) links opened from
// the renderer are intercepted by the main process's `setWindowOpenHandler`
// and routed to `shell.openExternal`, so they always open in the user's
// browser — never in-app.
const GITHUB_URL = 'https://github.com/FE-Berserker/WhaleTag';
const WEBSITE_URL = 'https://FE-Berserker.github.io/WhaleTag_Page';

type ViewState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'no-update' }
  | { kind: 'available'; info: AppUpdateInfo }
  | { kind: 'downloading'; info: AppUpdateInfo; progress: AppUpdateProgressPayload | null }
  | { kind: 'downloaded'; info: AppUpdateInfo }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

/**
 * Settings → About section. Renders the current app version, the auto-update
 * on/off toggle (synced to the `autoUpdateCheck` redux-persist field), and a
 * manual check / download / restart-to-install button trio that drives the
 * main-side `auto-update.ts` state machine.
 *
 * Subscribe order matters: we wire `available` / `progress` / `downloaded` /
 * `error` on mount and tear them down on unmount. The IPC `subscribe` API
 * returns its own unsubscribe; we run them all from a single cleanup
 * function so order-of-unsubscription can't leak.
 */
export default function UpdateSection(): JSX.Element {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const autoUpdateCheck = useSelector(
    (s: RootState) => s.settings?.autoUpdateCheck ?? true
  );

  const [view, setView] = useState<ViewState>({ kind: 'idle' });
  // Track which info-version is "the one we're tracking" so progress
  // updates from a previous, abandoned check don't leak into a new one.
  const [trackedVersion, setTrackedVersion] = useState<string | null>(null);

  // App version comes from the main process (`app.getVersion()`) so dev and
  // packaged builds each report their own version. Importing package.json in
  // the renderer would pin a stale literal, and DefinePlugin isn't wired here.
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    void ipcApi.appGetVersion().then(setVersion).catch(() => undefined);
  }, []);

  // Subscribe to push events on mount; cleanup on unmount.
  useEffect(() => {
    const offAvailable = ipcApi.onAppUpdateEvent('available', (data) => {
      const info = data as AppUpdateInfo;
      setTrackedVersion(info.version);
      setView({ kind: 'available', info });
    });
    const offProgress = ipcApi.onAppUpdateEvent('progress', (data) => {
      const p = data as AppUpdateProgressPayload;
      setView((prev) => {
        // Don't downgrade if progress arrives after a `downloaded` / `error`
        // — that would race the UI back into a "downloading" state.
        if (prev.kind === 'downloading' || prev.kind === 'available') {
          return {
            kind: 'downloading',
            info: prev.info,
            progress: p,
          };
        }
        return prev;
      });
    });
    const offDownloaded = ipcApi.onAppUpdateEvent('downloaded', (data) => {
      const info = data as AppUpdateInfo;
      setView({ kind: 'downloaded', info });
    });
    const offError = ipcApi.onAppUpdateEvent('error', (data) => {
      const message = typeof data === 'string' ? data : 'unknown error';
      setView({ kind: 'error', message });
    });
    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
    };
  }, []);

  const handleCheck = async (): Promise<void> => {
    setView({ kind: 'checking' });
    let result: AppUpdateCheckResult;
    try {
      result = await ipcApi.appCheckForUpdates();
    } catch (e) {
      setView({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    switch (result.kind) {
      case 'unsupported':
        setView({ kind: 'unsupported' });
        return;
      case 'error':
        setView({ kind: 'error', message: result.error });
        return;
      case 'no-update':
        setView({ kind: 'no-update' });
        return;
      case 'update-available':
        setTrackedVersion(result.info.version);
        setView({ kind: 'available', info: result.info });
        return;
    }
  };

  const handleDownload = async (): Promise<void> => {
    if (view.kind !== 'available') return;
    const info = view.info;
    setView({ kind: 'downloading', info, progress: null });
    let result: AppUpdateDownloadResult;
    try {
      result = await ipcApi.appDownloadUpdate();
    } catch (e) {
      setView({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (result.kind === 'error') {
      setView({ kind: 'error', message: result.error });
      // `electron-updater` still emits 'downloaded' if it eventually finishes,
      // so we don't override the view back to 'available' on transient errors.
    }
    // Success path: `downloaded` push event will transition us to 'downloaded'.
  };

  const handleRestart = (): void => {
    if (view.kind !== 'downloaded') return;
    if (trackedVersion && view.info.version !== trackedVersion) {
      // Stale UI from an earlier check that wasn't this session's
      // downloaded version — don't risk installing something the user
      // didn't approve. Reset and let them check again.
      setView({ kind: 'idle' });
      return;
    }
    ipcApi.appQuitAndInstall();
  };

  return (
    <Stack sx={{ gap: 1.5 }}>
      {/* ---- Project declaration / about ---- */}
      <Stack sx={{ gap: 2 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
          <LogoIcon sx={{ fontSize: 56, flexShrink: 0 }} />
          <Stack sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {t('aboutAppName')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('aboutTagline')}
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={version ? t('aboutVersion', { version }) : '…'}
              sx={{ alignSelf: 'flex-start', mt: 0.5 }}
            />
          </Stack>
        </Stack>

        <Typography variant="body2" color="text.secondary">
          {t('aboutIntro')}
        </Typography>

        <Stack
          sx={{
            gap: 1,
            p: 1.5,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          <AboutLinkRow label={t('aboutGithub')} href={GITHUB_URL} />
          <AboutLinkRow label={t('aboutWebsite')} href={WEBSITE_URL} />
          <AboutInfoRow label={t('aboutLicense')} value={t('aboutLicenseValue')} />
          <AboutInfoRow label={t('aboutTechStack')} value={t('aboutTechStackValue')} />
        </Stack>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textAlign: 'center' }}
        >
          {t('aboutCopyright')}
        </Typography>
      </Stack>

      <Divider sx={{ my: 0.5 }} />

      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
        <SystemUpdateAltIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography variant="overline" color="text.secondary">
          {t('updateSectionTitle')}
        </Typography>
      </Stack>

      <Stack
        sx={{
          gap: 1,
          p: 1.5,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
        }}
      >
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="body2">
            {t('updateCurrentVersion')}{' '}
            <Box
              component="span"
              sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}
            >
              v{version || '—'}
            </Box>
          </Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={view.kind === 'checking'}
            onClick={() => {
              void handleCheck();
            }}
          >
            {t('updateCheckButton')}
          </Button>
        </Stack>

        {view.kind === 'checking' && (
          <Typography variant="caption" color="text.secondary">
            {t('updateChecking')}
          </Typography>
        )}

        {view.kind === 'unsupported' && (
          <Typography variant="caption" color="text.secondary">
            {t('updateUnsupportedDev')}
          </Typography>
        )}

        {view.kind === 'no-update' && (
          <Typography variant="caption" color="success.main">
            {t('updateUpToDate')}
          </Typography>
        )}

        {view.kind === 'available' && (
          <Stack sx={{ gap: 0.5 }}>
            <Typography variant="body2" color="primary.main">
              {t('updateAvailable', {
                current: version,
                latest: view.info.version,
              })}
            </Typography>
            {view.info.releaseNotes && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'auto' }}
              >
                {view.info.releaseNotes}
              </Typography>
            )}
            <Box>
              <Button
                size="small"
                variant="contained"
                onClick={() => {
                  void handleDownload();
                }}
              >
                {t('updateDownloadButton')}
              </Button>
            </Box>
          </Stack>
        )}

        {view.kind === 'downloading' && (
          <Stack sx={{ gap: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('updateDownloading', { percent: Math.round(view.progress?.percent ?? 0) })}
            </Typography>
            <LinearProgress
              variant={
                view.progress && view.progress.total > 0
                  ? 'determinate'
                  : 'indeterminate'
              }
              value={view.progress?.percent ?? 0}
            />
          </Stack>
        )}

        {view.kind === 'downloaded' && (
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
            <RestartAltIcon fontSize="small" color="success" />
            <Typography variant="body2" color="success.main">
              {t('updateDownloaded', { version: view.info.version })}
            </Typography>
            <Button
              size="small"
              variant="contained"
              color="primary"
              onClick={handleRestart}
            >
              {t('updateRestartButton')}
            </Button>
          </Stack>
        )}

        {view.kind === 'error' && (
          <Typography variant="caption" color="error.main">
            {t('updateCheckError', { message: view.message })}
          </Typography>
        )}
      </Stack>

      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Typography variant="body2">{t('updateAutoCheck')}</Typography>
        <Switch
          checked={autoUpdateCheck}
          onChange={(e) => {
            dispatch(setAutoUpdateCheck(e.target.checked));
          }}
        />
      </Stack>
    </Stack>
  );
}

/** Label on the left, an external link on the right. `target="_blank"` links
 *  are caught by the main process and opened in the system browser. */
function AboutLinkRow({ label, href }: { label: string; href: string }) {
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        minWidth: 0,
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {label}
      </Typography>
      <Link
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        variant="body2"
        underline="hover"
        sx={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {href}
      </Link>
    </Stack>
  );
}

/** Label on the left, a plain text value on the right. */
function AboutInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack
      direction="row"
      sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
    >
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {label}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {value}
      </Typography>
    </Stack>
  );
}
