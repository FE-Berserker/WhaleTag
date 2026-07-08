import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';

import { ipcApi } from '-/services/ipc-api';
import { basename } from '-/services/path-util';

interface AddLocationDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string, path: string, readOnly: boolean) => void;
}

/** Add a local folder as a Whale location: name + native folder picker. */
export default function AddLocationDialog({
  open,
  onClose,
  onAdd,
}: AddLocationDialogProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPath('');
      setName('');
      setReadOnly(false);
      setError(null);
    }
  }, [open]);

  const handleBrowse = async () => {
    const picked = await ipcApi.openDirectoryDialog();
    if (picked) {
      setPath(picked);
      if (!name) setName(basename(picked));
      setError(null);
    }
  };

  const submit = () => {
    if (!path) {
      setError(t('pickFolderFirst'));
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('nameRequired'));
      return;
    }
    onAdd(trimmed, path, readOnly);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('addLocation')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label={t('locationName')}
            value={name}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField
              label={t('locationPath')}
              value={path}
              size="small"
              sx={{ flex: 1 }}
              slotProps={{ input: { readOnly: true } }}
              error={!!error && !path}
            />
            <Button
              onClick={handleBrowse}
              startIcon={<FolderIcon />}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {t('browse')}
            </Button>
          </Stack>
          <FormControlLabel
            control={
              <Checkbox
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
                size="small"
              />
            }
            label={t('readOnly')}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
            {t('readOnlyHint')}
          </Typography>
          {error ? (
            <Typography color="error" variant="body2">
              {error}
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button onClick={submit} variant="contained">
          {t('add')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
