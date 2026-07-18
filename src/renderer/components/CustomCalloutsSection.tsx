import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import { setCustomCallouts } from '-/reducers/settings';
import type { RootState } from '-/reducers';
import type { CustomCallout } from '../../shared/callout-types';

/**
 * Manage user-defined callout types for md-editor's `> [!TYPE]` syntax
 * (extends the 15 built-ins). Clones UserCommandsSection's pattern: a
 * local-state "add" form + read-only rows (toggle enabled / delete). A
 * custom entry's `type` matches `[!type]` in markdown; `color` (hex) drives
 * the rendered box's border + a derived lighter background; `icon` is an
 * emoji shown in the title row.
 */
export default function CustomCalloutsSection(): JSX.Element {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const callouts = useSelector((s: RootState) => s.settings.customCallouts);

  const [type, setType] = useState('');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#0969da');
  const [icon, setIcon] = useState('📝');

  const resetForm = () => {
    setType('');
    setLabel('');
    setColor('#0969da');
    setIcon('📝');
  };

  const add = () => {
    // `type` must be lowercase [\w-]+ — it becomes the `[!type]` marker the
    // user writes in markdown. Invalid (empty / spaces / special chars) is
    // ignored (no-op) so the user can keep typing.
    const trimmed = type.trim().toLowerCase();
    if (!trimmed || !/^[\w-]+$/.test(trimmed)) return;
    const next: CustomCallout[] = [
      ...callouts,
      {
        id: crypto.randomUUID(),
        type: trimmed,
        label: label.trim() || trimmed,
        color: color.trim() || '#0969da',
        icon: icon.trim() || '📝',
        enabled: true,
      },
    ];
    dispatch(setCustomCallouts(next));
    resetForm();
  };

  const update = (id: string, patch: Partial<CustomCallout>) => {
    dispatch(
      setCustomCallouts(
        callouts.map((c) => (c.id === id ? { ...c, ...patch } : c))
      )
    );
  };

  const remove = (id: string) => {
    dispatch(setCustomCallouts(callouts.filter((c) => c.id !== id)));
  };

  return (
    <>
      <Typography variant="subtitle2">{t('calloutsTitle')}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
        {t('calloutsHint')}
      </Typography>

      {callouts.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('calloutEmpty')}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {callouts.map((c) => (
            <Stack
              key={c.id}
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center' }}
            >
              <Switch
                size="small"
                checked={c.enabled}
                onChange={(e) => update(c.id, { enabled: e.target.checked })}
              />
              <Box
                sx={{
                  width: 16,
                  height: 16,
                  borderRadius: '3px',
                  bgcolor: c.color,
                  flexShrink: 0,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {c.icon} <code>{c.type}</code>
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                >
                  {c.label}
                </Typography>
              </Box>
              <Tooltip title={t('remove')}>
                <IconButton size="small" onClick={() => remove(c.id)}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      )}

      <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            placeholder={t('calloutType')}
            value={type}
            onChange={(e) => setType(e.target.value)}
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            placeholder={t('calloutIcon')}
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            sx={{ width: 80 }}
          />
        </Stack>
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            placeholder={t('calloutLabel')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            placeholder={t('calloutColor')}
            value={color}
            onChange={(e) => setColor(e.target.value)}
            sx={{ width: 110 }}
          />
        </Stack>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          sx={{ alignSelf: 'flex-start' }}
          onClick={add}
        >
          {t('calloutAdd')}
        </Button>
      </Box>
    </>
  );
}
