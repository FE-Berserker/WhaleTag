import { useState } from 'react';
import { Button, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAiComponent } from '-/hooks/useAiComponent';
import { ipcApi } from '-/services/ipc-api';

/**
 * Settings panel block for the optional AI component (the user-installed
 * `.whaleai` package holding the Claude Code CLI + Agent SDK).
 *
 * Shows install status + version, offers "install from file…" (native file
 * dialog filtered to `.whaleai`) and uninstall. Rendered at the top of the AI
 * settings section so the gating is visible before provider/key config.
 */
export function AiComponentSection(): JSX.Element {
  const { t } = useTranslation();
  const { state, install, uninstall } = useAiComponent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInstall = async (): Promise<void> => {
    setError(null);
    const filePath = await ipcApi.openComponentFileDialog();
    if (!filePath) return; // user cancelled
    setBusy(true);
    try {
      const result = await install(filePath);
      if (!result.ok) {
        setError(result.error ?? t('aiComponentInstallFailed'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await uninstall();
      if (!result.ok) {
        setError(result.error ?? t('aiComponentUninstallFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack
      sx={{
        gap: 1,
        p: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
      }}
    >
      <Typography variant="subtitle2">{t('aiComponentTitle')}</Typography>
      {state.installed ? (
        <>
          <Typography variant="body2" color="success.main">
            {t('aiComponentInstalled')}
            {state.version ? ` (v${state.version})` : ''}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            claude-code {state.claudeCodeVersion ?? '?'} · sdk{' '}
            {state.sdkVersion ?? '?'}
          </Typography>
          <div>
            <Button
              size="small"
              color="inherit"
              disabled={busy}
              onClick={() => {
                void handleUninstall();
              }}
            >
              {t('aiComponentUninstall')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            {t('aiComponentNotInstalled')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('aiComponentInstallHint')}
          </Typography>
          <div>
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => {
                void handleInstall();
              }}
            >
              {busy ? t('aiComponentInstalling') : t('aiComponentInstall')}
            </Button>
          </div>
        </>
      )}
      {error ? (
        <Typography variant="caption" color="error.main">
          {error}
        </Typography>
      ) : null}
    </Stack>
  );
}
