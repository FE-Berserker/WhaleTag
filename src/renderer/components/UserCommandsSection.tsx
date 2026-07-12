import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import { setUserCommands } from '-/reducers/settings';
import type { RootState } from '-/reducers';
import type { UserCommand } from '../../shared/shell-types';

/**
 * Manage user-defined shell commands (right-click file/folder → Commands).
 * Clones the AiMcpSection pattern: a local-state "add" form + read-only rows
 * (toggle enabled / delete). Editing a template = delete + re-add (avoids
 * dispatching on every keystroke, which would sync-write redux-persist to
 * disk on each char). The template's `${path}` is substituted + quoted by the
 * main process at run time — see shell-command.ts.
 */
export default function UserCommandsSection(): JSX.Element {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const commands = useSelector((s: RootState) => s.settings.userCommands);

  const [label, setLabel] = useState('');
  const [template, setTemplate] = useState('');
  const [applyToFiles, setApplyToFiles] = useState(true);
  const [applyToFolders, setApplyToFolders] = useState(false);

  const resetForm = () => {
    setLabel('');
    setTemplate('');
    setApplyToFiles(true);
    setApplyToFolders(false);
  };

  const add = () => {
    const trimmedLabel = label.trim();
    const trimmedTemplate = template.trim();
    if (!trimmedLabel || !trimmedTemplate) return;
    const next: UserCommand[] = [
      ...commands,
      {
        id: crypto.randomUUID(),
        label: trimmedLabel,
        template: trimmedTemplate,
        applyToFiles,
        applyToFolders,
        enabled: true,
      },
    ];
    dispatch(setUserCommands(next));
    resetForm();
  };

  const update = (id: string, patch: Partial<UserCommand>) => {
    dispatch(
      setUserCommands(
        commands.map((c) => (c.id === id ? { ...c, ...patch } : c))
      )
    );
  };

  const remove = (id: string) => {
    dispatch(setUserCommands(commands.filter((c) => c.id !== id)));
  };

  return (
    <>
      <Typography variant="subtitle2">{t('commandsTitle')}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
        {t('commandsHint')}
      </Typography>

      {commands.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('commandEmpty')}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {commands.map((c) => (
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
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {c.label}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: 'monospace', display: 'block' }}
                  noWrap
                >
                  {c.template}
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary">
                {[
                  c.applyToFiles ? t('commandApplyFiles') : null,
                  c.applyToFolders ? t('commandApplyFolders') : null,
                ]
                  .filter(Boolean)
                  .join(' / ')}
              </Typography>
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
        <TextField
          size="small"
          placeholder={t('commandLabel')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          size="small"
          placeholder={t('commandTemplatePlaceholder')}
          helperText={t('commandTemplateHelp')}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <Stack direction="row" spacing={1}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={applyToFiles}
                onChange={(e) => setApplyToFiles(e.target.checked)}
              />
            }
            label={t('commandApplyFiles')}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={applyToFolders}
                onChange={(e) => setApplyToFolders(e.target.checked)}
              />
            }
            label={t('commandApplyFolders')}
          />
        </Stack>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          sx={{ alignSelf: 'flex-start' }}
          onClick={add}
        >
          {t('commandAdd')}
        </Button>
      </Box>
    </>
  );
}
