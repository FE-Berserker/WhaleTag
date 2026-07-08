import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { Box, LinearProgress, MenuItem, Select, Tooltip, Typography } from '@mui/material';

import { setAiSettings } from '-/reducers/settings';
import type { RootState } from '-/reducers';
import type { UsageInfo } from '../../../shared/ai-types';

/**
 * Compact per-conversation toolbar above the AI input: model picker, permission
 * mode, and a context-window gauge fed by the turn's `usage` chunk.
 */
export default function AiToolbar({ usage }: { usage: UsageInfo | null }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const model = useSelector((s: RootState) => s.settings.aiModel);
  const permission = useSelector((s: RootState) => s.settings.aiPermissionMode);

  const pct = usage?.percentage ?? null;
  const over = (pct ?? 0) >= 80;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.5,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      <Select
        size="small"
        value={model}
        onChange={(e) => dispatch(setAiSettings({ aiModel: String(e.target.value) }))}
        sx={{ minWidth: 110, typography: 'caption' }}
        variant="standard"
        disableUnderline
      >
        <MenuItem value="sonnet">Sonnet</MenuItem>
        <MenuItem value="opus">Opus</MenuItem>
        <MenuItem value="haiku">Haiku</MenuItem>
      </Select>
      <Select
        size="small"
        value={permission}
        onChange={(e) =>
          dispatch(
            setAiSettings({
              aiPermissionMode: e.target.value as 'yolo' | 'plan' | 'normal',
            })
          )
        }
        sx={{ minWidth: 90, typography: 'caption' }}
        variant="standard"
        disableUnderline
      >
        <MenuItem value="normal">{t('aiPermissionNormal')}</MenuItem>
        <MenuItem value="yolo">{t('aiPermissionYolo')}</MenuItem>
        <MenuItem value="plan">{t('aiPermissionPlan')}</MenuItem>
      </Select>
      <Box sx={{ flex: 1 }} />
      {pct !== null ? (
        <Tooltip
          title={
            usage
              ? `${usage.contextTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`
              : ''
          }
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 70 }}>
            <LinearProgress
              variant="determinate"
              value={pct}
              color={over ? 'warning' : 'primary'}
              sx={{ flex: 1, height: 6, borderRadius: 3 }}
            />
            <Typography variant="caption" color={over ? 'warning.main' : 'text.secondary'}>
              {pct}%
            </Typography>
          </Box>
        </Tooltip>
      ) : null}
    </Box>
  );
}
