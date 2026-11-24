import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { SettingsGroup, SettingsRow } from './settings/primitives';
import type { LanStatus } from '../../shared/lan-types';
import { errorMessage } from '-/services/errors';

const STOPPED_STATUS: LanStatus = {
  running: false,
  port: null,
  urls: [],
  token: null,
};

/**
 * Consecutive failed status polls before the interval is stopped. The main
 * process can be genuinely unreachable (crash, network teardown); polling it
 * every 2 s forever would spam the UI with the same error. The error alert's
 * Retry re-arms the poller.
 */
const MAX_POLL_FAILURES = 3;

/** Opt-in LAN pairing controls. The pairing secret is only handed to the
 * clipboard and QR encoder; it is never rendered as readable page text. */
export default function LanSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LanStatus>(STOPPED_STATUS);
  const [selectedUrl, setSelectedUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only a failed status *read* is fixed by asking main again; start/stop/copy
  // failures already have the button that caused them as their retry.
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Bumped to restart a paused poller / re-run the QR encoder.
  const [pollNonce, setPollNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrNonce, setQrNonce] = useState(0);

  const showError = useCallback((message: string, retryable: boolean) => {
    setError(message);
    setErrorRetryable(retryable);
  }, []);

  const applyStatus = useCallback((next: LanStatus) => {
    setStatus(next);
    // A successful read (or start/stop) invalidates the previous failure:
    // leaving it up made a recovered server look broken.
    setError(null);
    setErrorRetryable(false);
    setSelectedUrl((current) =>
      next.urls.includes(current) ? current : (next.urls[0] ?? '')
    );
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await window.whale.getLanStatus();
        if (active) applyStatus(next);
      } catch (cause) {
        if (active) {
          showError(
            t('lanStatusError', { message: errorMessage(cause) }),
            true
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [applyStatus, showError, t]);

  useEffect(() => {
    if (!status.running) return;
    let active = true;
    let polling = false;
    let failures = 0;
    let timer: number | undefined;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await window.whale.getLanStatus();
        if (active) {
          failures = 0;
          // applyStatus also clears a previous poll error, so a single hiccup
          // does not leave a permanent red banner behind.
          applyStatus(next);
        }
      } catch (cause) {
        if (active) {
          failures += 1;
          showError(
            t('lanStatusError', { message: errorMessage(cause) }),
            true
          );
          if (failures >= MAX_POLL_FAILURES && timer !== undefined) {
            // Stop hammering an unreachable main process; Retry re-arms this
            // effect (pollNonce) once the user asks.
            window.clearInterval(timer);
            timer = undefined;
          }
        }
      } finally {
        polling = false;
      }
    };
    // The main process can stop LAN sharing when network/roots change. Poll
    // only while running so an automatic stop also removes the stale QR code.
    timer = window.setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [applyStatus, pollNonce, showError, status.running, t]);

  /** Re-reads the status after a poll error and re-arms the polling effect. */
  const retryStatus = async () => {
    setRetrying(true);
    try {
      applyStatus(await window.whale.getLanStatus());
    } catch (cause) {
      showError(t('lanStatusError', { message: errorMessage(cause) }), true);
    } finally {
      setRetrying(false);
      setPollNonce((n) => n + 1);
    }
  };

  const baseUrl = status.urls.includes(selectedUrl)
    ? selectedUrl
    : (status.urls[0] ?? '');
  const pairingUrl =
    status.running && baseUrl && status.token
      ? `${baseUrl}#token=${encodeURIComponent(status.token)}`
      : null;

  useEffect(() => {
    let active = true;
    setQrDataUrl(null);
    setQrError(null);
    setCopied(false);
    if (!pairingUrl) return () => undefined;
    void (async () => {
      try {
        // Keep the QR encoder out of the initial settings bundle and never
        // load it while the LAN server is stopped.
        const { toDataURL } = await import('qrcode');
        const dataUrl = await toDataURL(pairingUrl, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 220,
        });
        if (active) setQrDataUrl(dataUrl);
      } catch (cause) {
        if (active) {
          setQrError(t('lanQrError', { message: errorMessage(cause) }));
        }
      }
    })();
    return () => {
      active = false;
    };
    // `qrNonce` re-runs the encoder when the user hits Retry on a QR failure.
  }, [pairingUrl, qrNonce, t]);

  const start = async () => {
    setBusy('start');
    setError(null);
    try {
      applyStatus(await window.whale.startLanServer());
    } catch (cause) {
      showError(t('lanStartError', { message: errorMessage(cause) }), false);
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy('stop');
    setError(null);
    try {
      applyStatus(await window.whale.stopLanServer());
    } catch (cause) {
      showError(t('lanStopError', { message: errorMessage(cause) }), false);
    } finally {
      setBusy(null);
    }
  };

  const copyPairingLink = async () => {
    if (!pairingUrl) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
    } catch (cause) {
      showError(t('lanCopyError', { message: errorMessage(cause) }), false);
    }
  };

  return (
    <Stack sx={{ gap: 2 }}>
      <Alert severity="warning">{t('lanSecurityWarning')}</Alert>
      {error ? (
        <Alert
          severity="error"
          action={
            errorRetryable ? (
              <Button
                color="inherit"
                size="small"
                disabled={retrying}
                onClick={() => void retryStatus()}
              >
                {t('retry')}
              </Button>
            ) : undefined
          }
        >
          {error}
        </Alert>
      ) : null}

      <SettingsGroup>
        <SettingsRow
          label={
            <Typography role="status" variant="body2">
              {status.running ? t('lanRunning') : t('lanStopped')}
            </Typography>
          }
          hint={loading ? t('lanLoading') : undefined}
        >
          <Button
            variant="contained"
            size="small"
            disabled={loading || busy !== null}
            onClick={() => void (status.running ? stop() : start())}
          >
            {status.running
              ? busy === 'stop'
                ? t('lanStopping')
                : t('lanStop')
              : busy === 'start'
                ? t('lanStarting')
                : t('lanStart')}
          </Button>
        </SettingsRow>

        {status.running && status.urls.length > 1 ? (
          <SettingsRow label={t('lanBaseUrl')} fullWidth>
            <FormControl size="small" fullWidth>
              <InputLabel id="lan-base-url-label">{t('lanBaseUrl')}</InputLabel>
              <Select
                labelId="lan-base-url-label"
                value={baseUrl}
                label={t('lanBaseUrl')}
                onChange={(event) => setSelectedUrl(event.target.value)}
              >
                {status.urls.map((url) => (
                  <MenuItem key={url} value={url}>
                    {url}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </SettingsRow>
        ) : null}

        {status.running && status.urls.length === 1 && baseUrl ? (
          <SettingsRow label={t('lanBaseUrl')} hint={baseUrl} />
        ) : null}
      </SettingsGroup>

      {pairingUrl ? (
        <SettingsGroup>
          <Stack sx={{ alignItems: 'center', gap: 1, p: 2 }}>
            <Button
              variant="outlined"
              size="small"
              aria-label={t('lanCopyLink')}
              onClick={() => void copyPairingLink()}
            >
              {t('lanCopyLink')}
            </Button>
            {copied ? (
              <Typography role="status" variant="caption" color="success.main">
                {t('lanLinkCopied')}
              </Typography>
            ) : null}
            {qrDataUrl ? (
              <Box
                component="img"
                src={qrDataUrl}
                alt={t('lanQrCode')}
                sx={{ width: 220, height: 220 }}
              />
            ) : null}
            {qrError ? (
              <Alert
                severity="error"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => setQrNonce((n) => n + 1)}
                  >
                    {t('retry')}
                  </Button>
                }
              >
                {qrError}
              </Alert>
            ) : null}
          </Stack>
        </SettingsGroup>
      ) : null}
    </Stack>
  );
}
