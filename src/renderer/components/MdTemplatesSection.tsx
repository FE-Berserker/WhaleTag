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

import { setMdTemplates } from '-/reducers/settings';
import type { RootState } from '-/reducers';
import type { MdTemplate } from '../../shared/md-template-types';

/**
 * Manage user-defined HTML snippet templates for md-editor's right-click
 * "Templates" submenu. Mirrors `CustomCalloutsSection`'s shape: a local-state
 * "add" form + read-only rows (toggle enabled / delete). Editing a template =
 * delete + re-add (avoids dispatching on every keystroke, which would
 * sync-write redux-persist to disk on each char).
 *
 * Inserted HTML is sanitized on preview by md-editor's existing DOMPurify
 * pipeline (`FORBID_ATTR: ['style']` + allow-list), so inline `style` is
 * stripped — the helper text tells the user to use `class` instead.
 */
export default function MdTemplatesSection(): JSX.Element {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const templates = useSelector((s: RootState) => s.settings.mdTemplates);

  const [label, setLabel] = useState('');
  const [template, setTemplate] = useState('');

  const resetForm = () => {
    setLabel('');
    setTemplate('');
  };

  const add = () => {
    const trimmedLabel = label.trim();
    const trimmedTemplate = template.trim();
    if (!trimmedLabel || !trimmedTemplate) return;
    const next: MdTemplate[] = [
      ...templates,
      {
        id: crypto.randomUUID(),
        label: trimmedLabel,
        template: trimmedTemplate,
        enabled: true,
      },
    ];
    dispatch(setMdTemplates(next));
    resetForm();
  };

  const update = (id: string, patch: Partial<MdTemplate>) => {
    dispatch(
      setMdTemplates(
        templates.map((tp) => (tp.id === id ? { ...tp, ...patch } : tp))
      )
    );
  };

  const remove = (id: string) => {
    dispatch(setMdTemplates(templates.filter((tp) => tp.id !== id)));
  };

  return (
    <>
      <Typography variant="subtitle2">{t('mdTemplatesTitle')}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
        {t('mdTemplatesHint')}
      </Typography>

      {templates.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('mdTemplateEmpty')}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {templates.map((tp) => (
            <Stack
              key={tp.id}
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center' }}
            >
              <Switch
                size="small"
                checked={tp.enabled}
                onChange={(e) => update(tp.id, { enabled: e.target.checked })}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {tp.label}
                </Typography>
                <Typography
                  variant="caption"
                  component="pre"
                  sx={{
                    opacity: 0.7,
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    margin: 0,
                    maxHeight: 60,
                    overflow: 'hidden',
                  }}
                >
                  {tp.template}
                </Typography>
              </Box>
              <Tooltip title={t('remove')}>
                <IconButton size="small" onClick={() => remove(tp.id)}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      )}

      <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          size="small"
          label={t('mdTemplateLabel')}
          helperText={t('mdTemplateLabelHint')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          size="small"
          multiline
          minRows={2}
          label={t('mdTemplateContent')}
          helperText={t('mdTemplateContentHint')}
          placeholder={'<div class="card">…</div>'}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          sx={{ '& .MuiInputBase-input': { fontFamily: 'monospace' } }}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          sx={{ alignSelf: 'flex-start' }}
          onClick={add}
        >
          {t('mdTemplateAdd')}
        </Button>
      </Box>
    </>
  );
}
