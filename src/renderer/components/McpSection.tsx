import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import RefreshIcon from '@mui/icons-material/Refresh';

import { ipcApi } from '-/services/ipc-api';
import { useConfirm } from '-/components/ConfirmDialogProvider';
import type { McpStatus } from '../../shared/mcp-types';

/**
 * Settings pane for the local MCP server (docs/21) — the bridge that lets an
 * EXTERNAL AI client (Claude Desktop, ZCode, …) search, read, tag and package
 * the user's files. All state is main-process owned; this pane only polls
 * `mcp:getStatus` and pushes toggles, so it works even when the server is
 * stopped (the token/endpoint preview helps configure clients before start).
 */
export default function McpSection(): JSX.Element {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = () => {
    void ipcApi
      .mcpGetStatus()
      .then(setStatus)
      .catch(() => undefined);
  };

  useEffect(refresh, []);

  const copy = (label: string, value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => undefined);
  };

  const apply = (fn: () => Promise<McpStatus>) => {
    setBusy(true);
    void fn()
      .then(setStatus)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const regenerate = async () => {
    const ok = await confirm({
      message: t('mcpRegenerateConfirm'),
      confirmLabel: t('mcpRegenerateToken'),
      danger: true,
    });
    if (ok) apply(() => ipcApi.mcpRegenerateToken());
  };

  const endpoint =
    status?.endpoint ?? `http://127.0.0.1:${status ? '?' : '…'}/mcp`;
  const token = status?.token ?? '…';

  return (
    <Stack sx={{ gap: 2 }}>
      <Stack>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {t('settingsSectionMcp')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t('mcpSettingsHint')}
        </Typography>
      </Stack>

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2">{t('mcpEnable')}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t('mcpEnableHint')}
          </Typography>
        </Box>
        <Switch
          checked={status?.running ?? false}
          disabled={!status || busy}
          onChange={(e) => apply(() => ipcApi.mcpSetEnabled(e.target.checked))}
        />
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2">{t('mcpReadOnly')}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t('mcpReadOnlyHint')}
          </Typography>
        </Box>
        <Switch
          checked={status?.readOnly ?? true}
          disabled={!status || busy}
          onChange={(e) => apply(() => ipcApi.mcpSetReadOnly(e.target.checked))}
        />
      </Box>

      <TextField
        label={t('mcpEndpoint')}
        value={status && !status.running ? t('mcpNotRunning') : endpoint}
        slotProps={{
          input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 13 } },
          inputLabel: { shrink: true },
        }}
        fullWidth
        size="small"
        margin="none"
      />

      <TextField
        label={t('mcpToken')}
        type={showToken ? 'text' : 'password'}
        value={token}
        slotProps={{
          input: {
            readOnly: true,
            sx: { fontFamily: 'monospace', fontSize: 13 },
            endAdornment: (
              <InputAdornment position="end">
                <Tooltip title={t(showToken ? 'mcpHideToken' : 'mcpShowToken')}>
                  <IconButton size="small" onClick={() => setShowToken((v) => !v)}>
                    {showToken ? (
                      <VisibilityOffIcon fontSize="small" />
                    ) : (
                      <VisibilityIcon fontSize="small" />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title={copied === 'token' ? t('mcpCopied') : t('mcpCopy')}>
                  <IconButton
                    size="small"
                    edge="end"
                    onClick={() => copy('token', token)}
                  >
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </InputAdornment>
            ),
          },
          inputLabel: { shrink: true },
        }}
        fullWidth
        size="small"
        margin="none"
      />

      <Box sx={{ display: 'flex', flexDirection: 'row', gap: 1, alignItems: 'center' }}>
        <Button
          size="small"
          startIcon={<RefreshIcon />}
          disabled={!status || busy}
          onClick={() => void regenerate()}
        >
          {t('mcpRegenerateToken')}
        </Button>
        <Typography variant="caption" color="text.secondary">
          {t('mcpSessions', { count: status?.sessions ?? 0 })}
        </Typography>
      </Box>
    </Stack>
  );
}
