import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material';

interface PromptDialogProps {
  open: boolean;
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  /** Return an error string to block submit; null/undefined to accept. */
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

/**
 * Generic single-line input dialog (Electron disables `window.prompt`, so we
 * use this for new-folder / new-file / rename flows).
 */
export default function PromptDialog({
  open,
  title,
  label,
  defaultValue = '',
  placeholder,
  confirmText,
  cancelText,
  validate,
  onConfirm,
  onClose,
}: PromptDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setError(null);
    }
  }, [open, defaultValue]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(t('nameRequired'));
      return;
    }
    const validationError = validate ? validate(trimmed) : null;
    if (validationError) {
      setError(validationError);
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label={label}
          placeholder={placeholder}
          value={value}
          error={!!error}
          helperText={error ?? undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{cancelText ?? t('cancel')}</Button>
        <Button onClick={submit} variant="contained">
          {confirmText ?? t('confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
